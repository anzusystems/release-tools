// @ts-check
import { existsSync } from 'node:fs'
import * as semver from '../semver.mjs'
import { classifyVersion, PRERELEASE_IDS, DEV_NAME_RE } from '../tags.mjs'
import { lastStable, nextPrereleaseNumber, devVersion, isOlderLine, lastOfLine } from '../versions.mjs'
import { Project, MAIN } from '../project.mjs'
import { TAGS_NS } from '../git.mjs'
import { releaseFolder, buildSettingsAt } from '../context.mjs'
import { ReleaseError, compactTime } from '../util.mjs'
import { parseFooter } from '../release-body.mjs'
import { releaseBranches, prepareFolder, checkChangelog, checkTaggable, mergeMain, unreleasedInMain, releasedUnmerged, mainVersion } from './common.mjs'
import { publishFinal, finishReleased, checkHotfixAncestry, verifiedCommit, ensureRelease } from './final.mjs'
import { createRelease } from './start.mjs'

/**
 * @typedef {import('../context.mjs').Context} Context
 * @typedef {import('./common.mjs').ReleaseBranch} ReleaseBranch
 */

/**
 * release:publish
 * @param {Context} ctx
 */
export async function publish(ctx) {
  const project = new Project(ctx)
  await project.recoverMoves()
  const released = await project.released()
  const bootstrap = await project.bootstrap(released)
  const branch = await ctx.git.currentBranch()
  const branches = await releaseBranches(ctx)
  const unfinished = await unfinishedItems(ctx, project, released, bootstrap, branches)

  /** @type {import('../ui.mjs').Choice[]} */
  const choices = []
  const here = branches.find((b) => b.branch === branch && b.worktree && samePath(b.worktree, ctx.dir))
  if (here && !released.has(here.version)) {
    const V = here.version
    const tagNames = (await project.tagRefs()).map((t) => t.name)
    const next = (/** @type {string} */ id) => `${V}-${id}.${nextPrereleaseNumber(V, id, [...released, ...tagNames])}`
    const group = here.branch
    const finalHint = here.kind === 'release' ? 'publishes, then merges into main and removes the branch' : 'publishes; the changelog goes to main in its own pull request'
    choices.push({ group, label: `final   ${V}`, value: { kind: 'final', rel: here }, hint: finalHint })
    const order = here.kind === 'release' ? ['beta', 'rc', 'alpha'] : ['rc', 'beta', 'alpha']
    for (const id of order) choices.push({ group, label: `${id.padEnd(7)} ${next(id)}`, value: { kind: 'prerelease', id, core: V, rel: here } })
    choices.push({ group, label: 'dev     build of this branch', value: { kind: 'dev' } })
  } else if (here) {
    choices.push({ group: here.branch, label: `finish ${here.version}`, value: { kind: 'finish', rel: here }, hint: 'released; finish what is left (merge, changelog, clean up)' })
  } else if (branch && !/^(release|hotfix)\//.test(branch)) {
    const group = `${branch}`
    const last = lastStable(released)
    const target = last ? semver.bump(last, 'minor') : ((await mainVersion(ctx)) ?? '1.0.0')
    choices.push({ group, label: 'dev build of this branch', value: { kind: 'dev' } })
    for (const id of PRERELEASE_IDS) choices.push({ group, label: `${id} of ${semver.core(target)} (or another version)`, value: { kind: 'prerelease', id, core: null, rel: null } })
  }
  for (const b of branches) {
    if (b === here || released.has(b.version)) continue
    choices.push({ group: 'Open releases', label: `${b.branch}`, value: { kind: 'open', rel: b } })
  }
  for (const u of unfinished) choices.push({ group: 'Unfinished', label: u.label, value: u.value, hint: u.hint })
  if (!choices.length) throw new ReleaseError('nothing to publish here', { hint: 'start a release with release:start' })

  const choice = await ctx.ui.select('What do you want to publish?', choices)
  if (choice.kind === 'open' || choice.kind === 'final' || choice.kind === 'finish') {
    const b = choice.rel
    const folder = await ensureFolder(ctx, project, b)
    const rel = { kind: b.kind, version: b.version, branch: b.branch, git: ctx.git.at(folder) }
    if (choice.kind === 'open') return publishIn(ctx, project, rel, released)
    return publishFinal(ctx, project, rel)
  }
  if (choice.kind === 'finish-released') return finishWithoutBranch(ctx, project, choice.version, choice.releaseKind)
  if (choice.kind === 'prerelease') return prerelease(ctx, project, choice)
  if (choice.kind === 'dev') return dev(ctx, project)
  throw new Error(`unknown choice ${choice.kind}`)
}

/**
 * @param {string} a
 * @param {string} b
 */
function samePath(a, b) {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '')
}

/**
 * Menu of a release selected outside its folder.
 * @param {Context} ctx
 * @param {Project} project
 * @param {{ kind: 'release' | 'hotfix', version: string, branch: string, git: import('../git.mjs').Git }} rel
 * @param {Set<string>} released
 */
async function publishIn(ctx, project, rel, released) {
  const names = [...released, ...(await project.tagRefs()).map((t) => t.name)]
  const order = rel.kind === 'release' ? ['beta', 'rc', 'alpha'] : ['rc', 'beta', 'alpha']
  const choice = await ctx.ui.select(`${rel.branch}`, [
    { label: `final   ${rel.version}`, value: { kind: 'final' } },
    ...order.map((id) => ({ label: `${id.padEnd(7)} ${rel.version}-${id}.${nextPrereleaseNumber(rel.version, id, names)}`, value: { kind: 'prerelease', id } })),
    { label: 'dev     build of this branch', value: { kind: 'dev' } },
  ])
  const sub = { ...ctx, git: rel.git, dir: rel.git.dir }
  if (choice.kind === 'final') return publishFinal(sub, new Project(sub), rel)
  if (choice.kind === 'prerelease') return prerelease(sub, new Project(sub), { id: choice.id, core: rel.version, rel: { ...rel, worktree: rel.git.dir } })
  return dev(sub, new Project(sub))
}

/**
 * The folder of an open release; created from its branch when it is missing. Without any branch (a release pull
 * request merged by hand and its branch deleted) the main folder is used.
 * @param {Context} ctx
 * @param {Project} project
 * @param {ReleaseBranch} b
 */
async function ensureFolder(ctx, project, b) {
  if (b.worktree && existsSync(b.worktree)) return b.worktree
  if (!b.local && !b.remote) return ctx.mainDir
  if (!b.local) {
    ctx.git.mutate(`create the local branch ${b.branch}`)
    await ctx.mainGit.raw(['branch', '--no-track', b.branch, `refs/remotes/origin/${b.branch}`])
  }
  return createRelease(ctx, project, b.branch, b.version, `refs/heads/${b.branch}`)
}

/**
 * Items that are not finished, offered everywhere.
 * @param {Context} ctx
 * @param {Project} project
 * @param {Set<string>} released
 * @param {boolean} bootstrap
 * @param {ReleaseBranch[]} branches
 */
async function unfinishedItems(ctx, project, released, bootstrap, branches) {
  const items = []
  const unmerged = await releasedUnmerged(ctx, project, released, bootstrap)
  if (unmerged) {
    const b = branches.find((x) => x.branch === `release/${unmerged.version}`)
    items.push({
      label: `${unmerged.version} is released but not merged into main`,
      value: b ? { kind: 'finish', rel: b } : { kind: 'finish-released', version: unmerged.version, releaseKind: 'release' },
      hint: 'finish the merge',
    })
  }
  const inMain = await unreleasedInMain(ctx, released)
  if (inMain) {
    const b = branches.find((x) => x.branch === `release/${inMain.version}`) ?? {
      branch: `release/${inMain.version}`,
      kind: /** @type {const} */ ('release'),
      version: inMain.version,
      remote: null,
      local: null,
      worktree: null,
    }
    items.push({ label: `main holds ${inMain.version}, which is not released`, value: { kind: 'finish', rel: b }, hint: `its release pull request #${inMain.pr.number} was merged by hand` })
  }
  const releases = await project.releases()
  for (const t of await project.tagRefs()) {
    const info = classifyVersion(t.name)
    if (!info || info.kind === 'dev') continue
    const isReleased = released.has(t.name)
    const rel = releases.find((r) => r.tagName === t.name)
    if (isReleased && (!rel || rel.draft) && t.type === 'tag') {
      // Only tags of the tool: other tags (the old flow) are never repaired.
      const tt = await project.toolTag(t.name)
      if (!tt?.message) continue
      const kind = info.kind === 'stable' ? (tt.message.kind === 'hotfix' ? 'hotfix' : 'release') : 'prerelease'
      items.push({
        label: `${t.name} is released but its GitHub Release is ${rel ? 'a draft' : 'missing'}`,
        value: { kind: 'finish-released', version: t.name, releaseKind: kind },
      })
    }
    if (!isReleased && info.kind === 'stable') {
      const b = branches.find((x) => x.version === t.name)
      if (b && !items.some((i) => i.value.rel === b)) items.push({ label: `${t.name} has a tag but is not released`, value: { kind: 'finish', rel: b } })
    }
  }
  const tagNames = new Set((await project.tagRefs()).map((t) => t.name))
  for (const r of releases) {
    const info = classifyVersion(r.tagName)
    if (!info || info.kind === 'dev' || tagNames.has(r.tagName) || !released.has(r.tagName) || !parseFooter(r.body)?.commit) continue
    const kind = info.kind === 'stable' ? (isOlderLine(r.tagName, released) ? 'hotfix' : 'release') : 'prerelease'
    const b = branches.find((x) => x.version === r.tagName)
    items.push({
      label: `${r.tagName} is released but its tag is missing`,
      value: b && kind !== 'prerelease' ? { kind: 'finish', rel: b } : { kind: 'finish-released', version: r.tagName, releaseKind: kind },
    })
  }
  for (const b of branches) {
    if (!released.has(b.version) || items.some((i) => i.value.rel === b)) continue
    const head = b.local ?? b.remote
    const against = b.kind === 'release' ? MAIN : `${TAGS_NS}${b.version}`
    if (head && (await ctx.git.hasObject(head)) && (await ctx.git.commitOf(against)) && (await ctx.git.isAncestor(head, against))) {
      items.push({ label: `${b.branch} is released; clean it up`, value: { kind: 'finish', rel: b } })
    }
  }
  return items
}

/**
 * A released version without a branch: restore the tag, finish the GitHub Release (and the merge).
 * @param {Context} ctx
 * @param {Project} project
 * @param {string} version
 * @param {'release' | 'hotfix' | 'prerelease'} kind
 */
async function finishWithoutBranch(ctx, project, version, kind) {
  const tag = await ctx.gh.tag(version)
  if (kind === 'prerelease') {
    let t = tag
    if (!t) {
      await project.restoreReleasedTag(version, null)
      t = await ctx.gh.tag(version)
    }
    if (!t) throw new ReleaseError(`the tag ${version} could not be restored`)
    const commit = await verifiedCommit(ctx, project, version, t)
    await ensureRelease(ctx, project, version, commit)
    return
  }
  const branch = `${kind}/${version}`
  const rel = { kind, version, branch, git: ctx.mainGit }
  return finishReleased(ctx, project, /** @type {any} */ (rel), tag)
}

/**
 * Prerelease (alpha, beta, rc): tags the current commit; nothing is merged or deleted.
 * @param {Context} ctx
 * @param {Project} project
 * @param {{ id: string, core: string | null, rel: any }} o
 */
export async function prerelease(ctx, project, o) {
  const released = await project.released()
  let core = o.core
  if (!core) {
    const last = lastStable(released)
    const def = last ? semver.bump(last, 'minor') : ((await mainVersion(ctx)) ?? '1.0.0')
    core = await ctx.ui.input('Version of the prerelease (X.Y.Z)', {
      default: semver.core(def),
      validate: (v) => (semver.isStable(v) ? null : 'exactly X.Y.Z'),
    })
  }
  if (released.has(core)) throw new ReleaseError(`${core} is already released; there is no prerelease of a released version`)
  const lastLine = lastOfLine(released, semver.line(core))
  if (lastLine && !semver.gt(core, lastLine)) throw new ReleaseError(`${core} is not higher than ${lastLine}, the last released version of its line`)
  const branch = /** @type {string} */ (await ctx.git.currentBranch())
  if (!branch) throw new ReleaseError('not on a branch')
  // A prerelease of an older line is a prerelease of its hotfix, whatever the branch is called.
  const olderLine = isOlderLine(core, released) || branch.startsWith('hotfix/')
  const local = /** @type {string} */ (await ctx.git.commitOf('HEAD'))
  if (olderLine) await checkHotfixAncestry(ctx, project, core, local, released)
  const head = await pushCurrent(ctx, branch)
  if (o.id === 'rc' && branch.startsWith('release/') && ctx.settings.requireTestedPrerelease) {
    await ctx.git.fetch()
    if (await mergeMain(ctx, ctx.git, core, branch)) await prepareFolder(ctx, ctx.git, branch)
  }
  const commit = /** @type {string} */ (await ctx.git.commitOf('HEAD'))
  if (commit !== head && !(await ctx.gh.branchSha(branch))) throw new ReleaseError(`${branch} is not on GitHub`)
  await checkTaggable(ctx, project, commit)
  if (olderLine) await checkHotfixAncestry(ctx, project, core, commit, released)
  const build = await buildSettingsAt(ctx, commit)
  const path = `${build.changelogDir}/${core}.md`
  checkChangelog(ctx, await ctx.git.show(commit, path), path, 'prerelease')
  const names = [...released, ...(await project.tagRefs()).map((t) => t.name), ...(await project.releases()).map((r) => r.tagName)]
  const version = `${core}-${o.id}.${nextPrereleaseNumber(core, o.id, names)}`
  if (await project.isReleased(version)) throw new ReleaseError(`${version} is already released`)
  const tag = await project.createTag({ name: version, commit, kind: 'prerelease' })
  const outcome = await project.waitForRun(tag)
  if (await project.isReleased(version)) {
    const rel = await project.release(version)
    ctx.ui.info(`${version} is published${project.npm ? ` on npm: "${ctx.settings.package}": "${version}"` : ''}${rel ? `\n${rel.url}` : ''}`)
    if (!rel || rel.draft) ctx.ui.info('Its GitHub Release is not there yet; run release:publish again to add it.')
    return
  }
  ctx.ui.info(`${version} was not published${outcome ? `: ${outcome.run.url}` : ' (no release run started)'}`)
  if (outcome) ctx.ui.info(await ctx.gh.failedLog(outcome.run.id))
  throw new ReleaseError(`${version} failed`, { hint: 'fix it in the branch; the next prerelease gets the next number' })
}

/**
 * Pushes the current branch (never main) and returns its head.
 * @param {Context} ctx
 * @param {string} branch
 */
async function pushCurrent(ctx, branch) {
  if (branch === 'main') {
    const head = /** @type {string} */ (await ctx.git.commitOf('HEAD'))
    const status = await ctx.git.status()
    if (status.tracked.length) throw new ReleaseError('uncommitted changes', { hint: 'commit or discard them' })
    if (!(await ctx.git.isAncestor(head, MAIN))) throw new ReleaseError('the local main has commits that are not on GitHub; the tool never pushes main')
    return head
  }
  return prepareFolder(ctx, ctx.git, branch)
}

/**
 * Dev build: GitHub only, never npm.
 * @param {Context} ctx
 * @param {Project} project
 */
export async function dev(ctx, project) {
  const branch = await ctx.git.currentBranch()
  if (!branch) throw new ReleaseError('not on a branch')
  await pushCurrent(ctx, branch)
  const commit = /** @type {string} */ (await ctx.git.commitOf('HEAD'))
  await checkTaggable(ctx, project, commit)
  const nearest = await nearestTag(ctx, commit)
  const pkgText = await ctx.git.show(commit, 'package.json')
  const pkgVersion = pkgText ? JSON.parse(pkgText).version : '0.0.0'
  const time = compactTime(await ctx.gh.serverTime())
  const proposed = devVersion(nearest, semver.valid(pkgVersion) ? pkgVersion : '0.0.0', time)
  const name = await ctx.ui.input(`Dev build ${proposed}; type a name instead of the time, or Enter`, {
    default: '',
    validate: (v) => (!v || DEV_NAME_RE.test(v) ? null : 'a name starts with a letter and has letters, digits and hyphens'),
  })
  const version = name ? devVersion(nearest, semver.valid(pkgVersion) ? pkgVersion : '0.0.0', name) : proposed
  if (await ctx.gh.tag(version)) throw new ReleaseError(`${version} is taken (a tag exists)`)
  if ((await project.releases()).some((r) => r.tagName === version)) throw new ReleaseError(`${version} is taken (a GitHub Release exists)`)
  const tag = await project.createTag({ name: version, commit, kind: 'dev' })
  const outcome = await project.waitForRun(tag)
  const rel = await project.release(version)
  if (rel && !rel.draft) {
    const asset = rel.assets.find((a) => a.name.endsWith('.tgz'))
    ctx.ui.info(asset ? `${version} is ready. In package.json:\n"${ctx.settings.package}": "${asset.url}"` : `${version} is ready: ${rel.url}`)
    return
  }
  ctx.ui.info(`${version} failed${outcome ? `: ${outcome.run.url}` : ' (no release run started)'}`)
  if (outcome) ctx.ui.info(await ctx.gh.failedLog(outcome.run.id))
  throw new ReleaseError(`${version} failed`, { hint: 'the next attempt gets a new time or name' })
}

/**
 * The nearest tag of the tool's stable or prerelease format on GitHub the commit comes from (dev tags skipped).
 * @param {Context} ctx
 * @param {string} commit
 */
async function nearestTag(ctx, commit) {
  let best = null
  let bestDistance = Infinity
  for (const ref of await ctx.git.refsMerged(TAGS_NS, commit)) {
    const name = ref.slice(TAGS_NS.length)
    const info = classifyVersion(name)
    if (!info || info.kind === 'dev') continue
    const tagCommit = await ctx.git.commitOf(ref)
    if (!tagCommit) continue
    const d = await ctx.git.count(`${tagCommit}..${commit}`)
    if (d < bestDistance || (d === bestDistance && best && semver.gt(name, best))) {
      best = name
      bestDistance = d
    }
  }
  return best
}

