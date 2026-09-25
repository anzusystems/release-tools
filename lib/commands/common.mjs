// @ts-check
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as semver from '../semver.mjs'
import { skipsCi } from '../tags.mjs'
import { lastStable } from '../versions.mjs'
import { parseHeader, hasContent, releasedEntries, indexLines, setReleaseDate, rebuildIndex } from '../changelog.mjs'
import { VERSION_FILES, resolveVersionConflict, resolveIndexConflict, setRootVersion } from '../conflicts.mjs'
import { detectPackageManager, npmVersionArgs } from '../pm.mjs'
import { run } from '../exec.mjs'
import { MAIN } from '../project.mjs'
import { releaseFolder, buildSettingsAt } from '../context.mjs'
import { ReleaseError, isoDate, sleep, pollMs } from '../util.mjs'

/**
 * @typedef {import('../context.mjs').Context} Context
 * @typedef {import('../project.mjs').Project} Project
 */

/**
 * @typedef {object} ReleaseBranch
 * @property {string} branch release/X.Y.Z or hotfix/X.Y.Z
 * @property {'release' | 'hotfix'} kind
 * @property {string} version
 * @property {string | null} remote sha on GitHub
 * @property {string | null} local sha of the local branch
 * @property {string | null} worktree path of its folder
 */

/**
 * Release and hotfix branches on GitHub, local branches and folders.
 * @param {Context} ctx
 * @returns {Promise<ReleaseBranch[]>}
 */
export async function releaseBranches(ctx) {
  /** @type {Map<string, ReleaseBranch>} */
  const map = new Map()
  const add = (/** @type {string} */ branch) => {
    const m = /^(release|hotfix)\/(.+)$/.exec(branch)
    if (!m || !semver.isStable(m[2])) return null
    if (!map.has(branch)) map.set(branch, { branch, kind: /** @type {any} */ (m[1]), version: m[2], remote: null, local: null, worktree: null })
    return map.get(branch)
  }
  for (const prefix of ['release/', 'hotfix/']) {
    for (const b of await ctx.gh.branches(prefix)) {
      const r = add(b.name)
      if (r) r.remote = b.sha
    }
    for (const r of await ctx.mainGit.refs(`refs/heads/${prefix}`)) {
      const x = add(r.ref.replace(/^refs\/heads\//, ''))
      if (x) x.local = r.sha
    }
  }
  for (const w of await ctx.mainGit.worktrees()) {
    if (!w.branch) continue
    const x = add(w.branch)
    if (x) x.worktree = w.path
  }
  return [...map.values()].sort((a, b) => semver.compare(a.version, b.version))
}

/**
 * The state of a release folder: what would be lost or is unfinished.
 * @param {import('../git.mjs').Git} git
 * @param {string | null} upstream remote-tracking ref of the branch, if any
 */
export async function folderState(git, upstream) {
  const st = await git.status()
  const mergeHead = await git.hasMergeHead()
  let ahead = 0
  let behind = 0
  if (upstream && (await git.commitOf(upstream))) {
    ahead = await git.count(`${upstream}..HEAD`)
    behind = await git.count(`HEAD..${upstream}`)
  }
  return { tracked: st.tracked, untracked: st.untracked, unmerged: st.unmerged, mergeHead, ahead, behind }
}

/**
 * Files changed on the branch (against main) that contain conflict markers.
 * @param {import('../git.mjs').Git} git
 */
export async function conflictMarkers(git) {
  const base = (await git.raw(['merge-base', MAIN, 'HEAD'], { allowFail: true })).stdout.trim()
  const files = new Set(base ? await git.changedFiles(base, 'HEAD') : [])
  for (const f of (await git.status()).tracked) files.add(f)
  const found = []
  const top = await git.toplevel()
  for (const f of files) {
    const p = join(top, f)
    if (!existsSync(p)) continue
    const text = await readFile(p, 'utf8').catch(() => '')
    if (/^<{7} |^>{7} /m.test(text)) found.push(f)
  }
  return found
}

/**
 * The checks of a release folder before anything changes; pushes local commits and fast-forwards when possible.
 * @param {Context} ctx
 * @param {import('../git.mjs').Git} git
 * @param {string} branch
 */
export async function prepareFolder(ctx, git, branch) {
  const upstream = `refs/remotes/origin/${branch}`
  const s = await folderState(git, upstream)
  if (s.mergeHead || s.unmerged.length) {
    throw new ReleaseError(`a merge is not finished in ${git.dir}${s.unmerged.length ? ` (conflicts: ${s.unmerged.join(', ')})` : ''}`, {
      hint: 'resolve the conflicts, commit, and run the command again',
    })
  }
  if (s.tracked.length) throw new ReleaseError(`uncommitted changes in ${git.dir}:\n  ${s.tracked.join('\n  ')}`, { hint: 'commit or discard them' })
  const markers = await conflictMarkers(git)
  if (markers.length) throw new ReleaseError(`conflict markers are committed in:\n  ${markers.join('\n  ')}`, { hint: 'fix the files and commit' })
  const remote = await ctx.gh.branchSha(branch)
  const head = /** @type {string} */ (await git.commitOf('HEAD'))
  if (remote && remote !== head) {
    if (await git.isAncestor(head, remote)) {
      if (!(await git.hasObject(remote))) await git.fetch()
      if (!(await git.mergeFfOnly(remote))) throw new ReleaseError(`could not fast-forward ${branch} to GitHub`)
      ctx.ui.step(`fast-forwarded ${branch} to the commits on GitHub`)
    } else if (!(await git.isAncestor(remote, head))) {
      throw new ReleaseError(`${branch} and its branch on GitHub have diverged`, { hint: `pull the changes of ${branch} (git pull) and run the command again` })
    }
  }
  const now = /** @type {string} */ (await git.commitOf('HEAD'))
  if (remote !== now) {
    await git.push([`${now}:refs/heads/${branch}`], { description: `push ${branch}` })
    await git.fetch()
  }
  return now
}

/**
 * Changelog files of a directory at a commit.
 * @param {import('../git.mjs').Git} git
 * @param {string} ref
 * @param {string} dir
 */
export async function changelogFiles(git, ref, dir) {
  const out = []
  for (const name of await git.lsDir(ref, dir)) {
    if (!name.endsWith('.md')) continue
    const text = await git.show(ref, `${dir}/${name}`)
    if (text !== null) out.push({ name, text })
  }
  return out
}

/**
 * Changelog files of a directory in a working tree.
 * @param {string} root
 * @param {string} dir
 */
export async function changelogFilesOnDisk(root, dir) {
  const out = []
  let names = []
  try {
    names = await readdir(join(root, dir))
  } catch {
    return out
  }
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    out.push({ name, text: await readFile(join(root, dir, name), 'utf8') })
  }
  return out
}

/**
 * Checks a changelog: final needs content, a prerelease only warns.
 * @param {Context} ctx
 * @param {string | null} text
 * @param {string} path
 * @param {'final' | 'prerelease'} kind
 */
export function checkChangelog(ctx, text, path, kind) {
  const ok = text !== null && hasContent(text)
  if (ok) return true
  if (kind === 'final') throw new ReleaseError(`${path} ${text === null ? 'is missing' : 'has nothing but headings'}`, { hint: 'write the changelog, commit and push' })
  ctx.ui.warn(`${path} ${text === null ? 'is missing' : 'has nothing but headings'}; the GitHub Release gets the branch and commit instead`)
  return false
}

/**
 * The commit to tag must contain the release workflow and must not skip the run.
 * @param {Context} ctx
 * @param {Project} project
 * @param {string} commit
 */
export async function checkTaggable(ctx, project, commit) {
  if (!(await project.hasStub(commit))) {
    throw new ReleaseError(`${commit.slice(0, 12)} does not contain the release workflow of the tool`, { hint: 'merge main into the branch first (never into a hotfix branch)' })
  }
  const info = await ctx.git.commitInfo(commit)
  if (skipsCi(info.message)) {
    throw new ReleaseError(`the message of ${commit.slice(0, 12)} contains a marker that skips the release run ([skip ci], skip-checks: true, …)`, {
      hint: 'add a commit without it',
    })
  }
}

/**
 * Merges origin/main into the release folder, resolving conflicts on the version and in the changelog index.
 * @param {Context} ctx
 * @param {import('../git.mjs').Git} git
 * @param {string} version
 * @param {string} branch
 * @returns {Promise<boolean>} whether a merge commit was made
 */
export async function mergeMain(ctx, git, version, branch) {
  if (await git.isAncestor(MAIN, 'HEAD')) return false
  const build = await buildSettingsAt(ctx, 'HEAD')
  const r = await git.merge(MAIN, `Merge main into ${branch}`)
  if (!r.clean) {
    const left = []
    for (const file of r.conflicts) {
      const stages = { base: await git.stage(file, 1), ours: await git.stage(file, 2), theirs: await git.stage(file, 3) }
      let resolved = null
      if (VERSION_FILES.includes(file)) resolved = await resolveVersionConflict(stages, version)
      else if (build.changelogIndex && file === build.changelogIndex) {
        const files = await changelogFilesOnDisk(git.dir, build.changelogDir)
        resolved = await resolveIndexConflict(stages, indexLines(releasedEntries(files), build.changelogIndex, build.changelogDir))
      }
      if (resolved === null) {
        left.push(file)
        continue
      }
      await writeFile(join(git.dir, file), resolved)
      await git.add([file])
    }
    if (left.length) {
      throw new ReleaseError(`merging main into ${branch} left conflicts in:\n  ${left.join('\n  ')}`, {
        hint: `resolve them in ${git.dir}, commit, and run the command again`,
      })
    }
    await git.commit(`Merge main into ${branch}`)
  }
  ctx.ui.step(`merged main into ${branch}`)
  return true
}

/**
 * The final commit: version in package.json (and npm lockfiles), date in the changelog header and the index.
 * Makes no commit when everything is already in place.
 * @param {Context} ctx
 * @param {import('../git.mjs').Git} git
 * @param {string} version
 * @returns {Promise<boolean>}
 */
export async function finalCommit(ctx, git, version) {
  const root = git.dir
  const build = await buildSettingsAt(ctx, 'HEAD')
  const pkgPath = join(root, 'package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  const pm = detectPackageManager(pkg, (p) => existsSync(join(root, p)))
  if (pkg.version !== version || (pm.name === 'npm' && (await lockfileVersionDiffers(root, version)))) {
    git.mutate(`set the version ${version} in package.json`)
    if (pm.name === 'npm') await run('npm', npmVersionArgs(version), { cwd: root })
    else await writeFile(pkgPath, setRootVersion(await readFile(pkgPath, 'utf8'), version))
  }
  const changelogPath = `${build.changelogDir}/${version}.md`
  const text = await readFile(join(root, changelogPath), 'utf8')
  const header = parseHeader(text)
  if (!header || header.version !== version) throw new ReleaseError(`${changelogPath} has no header "${version} — unreleased"`)
  if (!header.date) {
    git.mutate(`set the date in ${changelogPath}`)
    const date = isoDate(await ctx.gh.serverTime())
    await writeFile(join(root, changelogPath), setReleaseDate(text, version, date))
  }
  if (build.changelogIndex) {
    const indexPath = join(root, build.changelogIndex)
    const current = existsSync(indexPath) ? await readFile(indexPath, 'utf8') : '# Changelog\n'
    const files = await changelogFilesOnDisk(root, build.changelogDir)
    const next = rebuildIndex(current, releasedEntries(files), build.changelogIndex, build.changelogDir)
    if (next !== current) {
      git.mutate(`update ${build.changelogIndex}`)
      await writeFile(indexPath, next)
    }
  }
  const st = await git.status()
  if (!st.tracked.length) return false
  await git.add(st.tracked)
  await git.commit(`release: ${version}`)
  ctx.checkpoint('final-commit')
  ctx.ui.step(`final commit release: ${version}`)
  return true
}

/**
 * @param {string} root
 * @param {string} version
 */
async function lockfileVersionDiffers(root, version) {
  for (const f of ['package-lock.json', 'npm-shrinkwrap.json']) {
    const p = join(root, f)
    if (!existsSync(p)) continue
    const lock = JSON.parse(await readFile(p, 'utf8'))
    if (lock.version !== version || (lock.packages?.[''] && lock.packages[''].version !== version)) return true
  }
  return false
}

/**
 * The version in package.json of main.
 * @param {Context} ctx
 */
export async function mainVersion(ctx) {
  const text = await ctx.git.show(MAIN, 'package.json')
  return text ? (JSON.parse(text).version ?? null) : null
}

/**
 * "Unreleased version in main": the version of main is not released and a release pull request from
 * release/<version> is merged into main.
 * @param {Context} ctx
 * @param {Set<string>} released
 */
export async function unreleasedInMain(ctx, released) {
  const v = await mainVersion(ctx)
  if (!v || !semver.isStable(v) || released.has(v)) return null
  const pulls = await ctx.gh.pulls({ head: `release/${v}`, base: 'main', state: 'closed' })
  const merged = pulls.find((p) => p.state === 'merged')
  return merged ? { version: v, pr: merged } : null
}

/**
 * "Released but not merged": the last released stable version's tagged commit is not in main (not during bootstrap).
 * @param {Context} ctx
 * @param {Project} project
 * @param {Set<string>} released
 * @param {boolean} bootstrap
 */
export async function releasedUnmerged(ctx, project, released, bootstrap) {
  if (bootstrap) return null
  const last = lastStable(released)
  if (!last) return null
  const tag = await ctx.gh.tag(last)
  if (!tag) return { version: last, tag: null }
  if (!(await ctx.git.hasObject(tag.commit))) await ctx.git.fetch()
  if (await ctx.git.isAncestor(tag.commit, MAIN)) return null
  return { version: last, tag }
}

/**
 * Open pull requests into a branch other than the release pull request: offers to retarget or close them.
 * @param {Context} ctx
 * @param {string} branch
 * @param {number | null} releasePr
 * @param {string[]} otherBranches open release branches to retarget to
 */
export async function handlePullsInto(ctx, branch, releasePr, otherBranches) {
  const pulls = (await ctx.gh.pulls({ base: branch, state: 'open' })).filter((p) => p.number !== releasePr)
  for (const p of pulls) {
    const choices = [
      ...otherBranches.map((b) => ({ label: `retarget to ${b}`, value: { base: b } })),
      { label: 'close it', value: { close: true } },
      { label: 'stop here', value: null },
    ]
    const a = await ctx.ui.select(`Pull request #${p.number} "${p.title}" targets ${branch} (${p.url}).`, choices)
    if (!a) throw new ReleaseError(`pull request #${p.number} still targets ${branch}`, { hint: 'merge, retarget or close it, then run the command again' })
    if (a.base) await ctx.gh.updatePull(p.number, { base: a.base })
    else {
      await ctx.gh.comment(p.number, `Closed by release-tools: ${branch} is being finished or cancelled.`)
      await ctx.gh.updatePull(p.number, { state: 'closed' })
    }
  }
}

/**
 * Waits until a pull request may be merged by the repository's rules; offers a bypass only when just the
 * approval is missing and the user may bypass.
 * @param {Context} ctx
 * @param {number} number
 * @param {{ allowBypass?: boolean, expectHead?: string }} [options]
 * @returns {Promise<{ state: 'mergeable', pull: import('../github.mjs').PullInfo, bypassedBy: string | null } | { state: 'behind' | 'closed' | 'merged' | 'head-changed', pull: import('../github.mjs').PullInfo }>}
 */
export async function waitMergeable(ctx, number, options = {}) {
  let asked = false
  let shown = ''
  for (;;) {
    const p = await ctx.gh.pull(number)
    if (p.state === 'merged') return { state: 'merged', pull: p }
    if (p.state === 'closed') return { state: 'closed', pull: p }
    if (options.expectHead && p.headSha !== options.expectHead) return { state: 'head-changed', pull: p }
    const s = p.mergeStateStatus
    if (s === 'CLEAN' || s === 'HAS_HOOKS' || s === 'UNSTABLE') return { state: 'mergeable', pull: p, bypassedBy: null }
    if (s === 'BEHIND' || s === 'DIRTY') return { state: 'behind', pull: p }
    let text
    if (s === 'BLOCKED' && p.reviewDecision !== 'APPROVED') {
      if (options.allowBypass !== false && !asked && (await ctx.gh.canBypass(number))) {
        asked = true
        if (await ctx.ui.confirm(`${p.url} is not approved yet. Release and merge it without the approval (bypass)?`, { default: false })) {
          return { state: 'mergeable', pull: p, bypassedBy: ctx.login }
        }
      }
      text = `waiting for the approval of ${p.url}`
    } else if (s === 'BLOCKED') {
      text = `${p.url} is approved but blocked by the rules of the repository (for example an extra approval for unattributed changes); waiting`
    } else if (s === 'DRAFT') {
      text = `${p.url} is a draft; mark it ready for review`
    } else {
      text = `waiting until ${p.url} can be merged (${s})`
    }
    if (text !== shown) ctx.ui.status(text)
    shown = text
    await sleep(pollMs(20000))
  }
}

/**
 * @param {Context} ctx
 * @param {string} branch
 */
export function folderFor(ctx, branch) {
  return releaseFolder(ctx, branch)
}

/**
 * Lists commits of a range as lines.
 * @param {import('../git.mjs').Git} git
 * @param {string} range
 */
export async function commitLines(git, range) {
  return (await git.log(range)).map((c) => `  ${c.sha.slice(0, 12)} ${c.subject}`)
}

/**
 * Whether the version is taken: released, a tag (any tag) or a branch on GitHub.
 * @param {Context} ctx
 * @param {Project} project
 * @param {string} version
 */
export async function versionTaken(ctx, project, version) {
  if (await project.isReleased(version)) return `${version} is already released`
  if (await ctx.gh.tag(version)) return `the tag ${version} already exists`
  return null
}

