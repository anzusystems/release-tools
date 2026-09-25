// @ts-check
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import * as semver from '../semver.mjs'
import { lastStable, lastOfLine, olderLineHeads, latestLine } from '../versions.mjs'
import { DEFAULT_TEMPLATE, renderTemplate } from '../changelog.mjs'
import { detectPackageManager, worktreeInstall } from '../pm.mjs'
import { sh } from '../exec.mjs'
import { Project, MAIN } from '../project.mjs'
import { TAGS_NS } from '../git.mjs'
import { releaseFolder, buildSettingsAt } from '../context.mjs'
import { ReleaseError } from '../util.mjs'
import { releaseBranches, mainVersion, unreleasedInMain, releasedUnmerged, commitLines, folderState } from './common.mjs'
import { cancelRelease } from './cancel.mjs'

/**
 * @typedef {import('../context.mjs').Context} Context
 * @typedef {import('./common.mjs').ReleaseBranch} ReleaseBranch
 */

/**
 * release:start
 * @param {Context} ctx
 */
export async function start(ctx) {
  const project = new Project(ctx)
  await project.recoverMoves()
  const released = await project.released()
  const bootstrap = await project.bootstrap(released)
  const last = lastStable(released)
  const branches = await releaseBranches(ctx)
  const unmerged = await releasedUnmerged(ctx, project, released, bootstrap)
  const inMain = await unreleasedInMain(ctx, released)
  const mv = await mainVersion(ctx)

  const open = []
  const leftovers = []
  for (const b of branches) {
    if (!released.has(b.version)) open.push(b)
    else if (await releaseFinished(ctx, b)) leftovers.push(b)
  }

  /** @type {import('../ui.mjs').Choice[]} */
  const choices = []
  const blocked = unmerged
    ? `${unmerged.version} is released but not merged into main yet; finish it with release:publish`
    : inMain
      ? `main holds ${inMain.version}, which is not released (its release pull request #${inMain.pr.number} was merged by hand); finish it with release:publish`
      : null
  const base = bootstrap ? (last ?? null) : (mv && semver.valid(mv) ? mv : last)
  if (!blocked) {
    const group = `New release from main${base ? ` (${base})` : ''}`
    if (bootstrap && mv && semver.isStable(mv) && !released.has(mv) && (!last || semver.gt(mv, last))) {
      choices.push({ group, label: `${mv}`, value: { kind: 'release', version: mv }, hint: 'the version in package.json' })
    }
    if (base && semver.valid(base)) {
      const core = semver.core(base)
      for (const k of /** @type {const} */ (['patch', 'minor', 'major'])) {
        const v = semver.bump(core, k)
        if (!choices.some((c) => c.value?.version === v)) choices.push({ group, label: `${k.padEnd(6)} ${v}`, value: { kind: 'release', version: v } })
      }
    }
    choices.push({ group, label: 'custom…', value: { kind: 'release', version: null } })
  }
  const heads = olderLineHeads(released)
  for (const h of heads) {
    choices.push({ group: 'Hotfix of an older version', label: `${h} → ${semver.bump(h, 'patch')}`, value: { kind: 'hotfix', version: semver.bump(h, 'patch') } })
  }
  if (heads.length) choices.push({ group: 'Hotfix of an older version', label: 'other…', value: { kind: 'hotfix', version: null } })
  for (const b of open) choices.push({ group: 'Open releases', label: `${b.branch}   cancel`, value: { kind: 'cancel', branch: b } })
  for (const b of leftovers) choices.push({ group: 'Leftovers of released versions', label: `${b.branch}   delete`, value: { kind: 'leftover', branch: b } })
  if (blocked) ctx.ui.info(blocked)
  if (!choices.length) throw new ReleaseError(blocked ?? 'nothing to start')

  const choice = await ctx.ui.select('What do you want to start?', choices)
  if (choice.kind === 'cancel') return cancelRelease(ctx, project, choice.branch)
  if (choice.kind === 'leftover') return deleteLeftover(ctx, project, choice.branch, released)

  let version = choice.version
  if (!version) {
    version = await ctx.ui.input(choice.kind === 'hotfix' ? 'Hotfix version (X.Y.Z)' : 'Version (X.Y.Z)', {
      validate: (v) => (semver.isStable(v) ? null : 'exactly X.Y.Z: no prerelease part, no +build'),
    })
  }
  if (choice.kind === 'release') await checkNewRelease(ctx, project, version, { released, bootstrap, last, mv, blocked, branches })
  else await checkHotfix(ctx, project, version, released)
  const branch = `${choice.kind}/${version}`
  const startRef = choice.kind === 'release' ? MAIN : `${TAGS_NS}${lastOfLine(released, semver.line(version))}`
  const folder = await createRelease(ctx, project, branch, version, startRef)
  const lines = choice.kind === 'release' ? leftovers.filter((b) => b.kind === 'release') : leftovers.filter((b) => b.kind === 'hotfix' && semver.line(b.version) === semver.line(version))
  for (const b of lines) await offerLeftover(ctx, project, b, branch, folder, released)
  ctx.ui.info(`\n${branch} is ready in ${folder}`)
  return { branch, folder }
}

/**
 * A released version whose release is finished: the tagged commit is in main (release), or the changelog of the
 * hotfix is in main. Only then is its branch a leftover; otherwise release:publish finishes it.
 * @param {Context} ctx
 * @param {ReleaseBranch} b
 */
async function releaseFinished(ctx, b) {
  const tag = await ctx.gh.tag(b.version)
  if (!tag) return false
  if (b.kind === 'release') return (await ctx.git.hasObject(tag.commit)) && ctx.git.isAncestor(tag.commit, MAIN)
  const build = await buildSettingsAt(ctx, MAIN)
  const text = await ctx.git.show(MAIN, `${build.changelogDir}/${b.version}.md`)
  return !!text && /^\S+ — \d{4}-\d{2}-\d{2}/m.test(text)
}

/**
 * @param {Context} ctx
 * @param {Project} project
 * @param {string} version
 * @param {{ released: Set<string>, bootstrap: boolean, last: string | null, mv: string | null, blocked: string | null, branches: ReleaseBranch[] }} s
 */
async function checkNewRelease(ctx, project, version, s) {
  if (s.blocked) throw new ReleaseError(s.blocked)
  const req = await ctx.gh.mergeRequirements()
  if (req.problems.length) throw new ReleaseError(`main cannot take releases:\n- ${req.problems.join('\n- ')}`)
  if (!semver.isStable(version)) throw new ReleaseError(`${version} is not exactly X.Y.Z`)
  if (!s.bootstrap && s.last && s.mv !== s.last) {
    throw new ReleaseError(`main has the version ${s.mv}, but the last released version is ${s.last}`, { hint: 'finish the released version with release:publish' })
  }
  if (s.last && !semver.gt(version, s.last)) throw new ReleaseError(`${version} is not higher than the last released stable version ${s.last}`)
  await checkFree(ctx, project, version, `release/${version}`, s.branches)
}

/**
 * @param {Context} ctx
 * @param {Project} project
 * @param {string} version
 * @param {Set<string>} released
 */
async function checkHotfix(ctx, project, version, released) {
  if (!semver.isStable(version)) throw new ReleaseError(`${version} is not exactly X.Y.Z`)
  const line = semver.line(version)
  if (line === latestLine(released)) throw new ReleaseError(`${line} is the latest line; a patch of it is a normal release from main`)
  const base = lastOfLine(released, line)
  if (!base) throw new ReleaseError(`no version of the line ${line} is released`)
  if (semver.bump(base, 'patch') !== version) throw new ReleaseError(`the hotfix of ${line} is ${semver.bump(base, 'patch')} (the next patch of ${base}), not ${version}`)
  const tag = await ctx.gh.tag(base)
  if (!tag) throw new ReleaseError(`the tag ${base} does not exist on GitHub`)
  if (!(await project.hasStub(tag.commit))) throw new ReleaseError(`${base} was not released with this tool (its tag has no release workflow of the tool)`)
  await checkFree(ctx, project, version, `hotfix/${version}`, await releaseBranches(ctx))
}

/**
 * @param {Context} ctx
 * @param {Project} project
 * @param {string} version
 * @param {string} branch
 * @param {ReleaseBranch[]} branches
 */
async function checkFree(ctx, project, version, branch, branches) {
  if (await project.isReleased(version)) throw new ReleaseError(`${version} is already released`)
  if (await ctx.gh.tag(version)) throw new ReleaseError(`the tag ${version} already exists on GitHub`)
  const other = branches.find((b) => b.version === version && b.branch !== branch && (b.remote || b.local))
  if (other) throw new ReleaseError(`${other.branch} already exists`)
  const own = branches.find((b) => b.branch === branch)
  if (own?.remote && !own.local && !own.worktree) throw new ReleaseError(`${branch} already exists on GitHub`, { hint: 'use release:publish for it, or cancel it in release:start' })
  const folder = releaseFolder(ctx, branch)
  if (existsSync(folder) && own?.worktree !== folder) throw new ReleaseError(`the folder ${folder} already exists and is not the folder of ${branch}`)
}

/**
 * Creates (or continues) the branch, folder, changelog, push, copied files and install.
 * @param {Context} ctx
 * @param {Project} project
 * @param {string} branch
 * @param {string} version
 * @param {string} startRef
 */
export async function createRelease(ctx, project, branch, version, startRef) {
  const folder = releaseFolder(ctx, branch)
  const startCommit = await ctx.git.commitOf(startRef)
  if (!startCommit) throw new ReleaseError(`${startRef} does not exist`)
  const hasLocal = await ctx.mainGit.branchExists(branch)
  const wt = (await ctx.mainGit.worktrees()).find((w) => w.branch === branch)
  if (wt && wt.path !== folder) throw new ReleaseError(`${branch} is checked out in ${wt.path}`)
  if (!wt) {
    if (hasLocal) {
      const local = /** @type {string} */ (await ctx.mainGit.commitOf(`refs/heads/${branch}`))
      if (!(await ctx.git.isAncestor(startCommit, local))) throw new ReleaseError(`the local branch ${branch} exists but does not start from ${startRef}`)
      await ctx.mainGit.worktreePrune()
      await ctx.mainGit.worktreeAdd(folder, { branch, existing: true })
    } else {
      await ctx.mainGit.worktreeAdd(folder, { branch, start: startCommit })
    }
    ctx.checkpoint('worktree')
    ctx.ui.step(`created ${branch} in ${folder}`)
  }
  const git = ctx.git.at(folder)
  const build = await buildSettingsAt(ctx, /** @type {string} */ (await git.commitOf('HEAD')))
  const path = `${build.changelogDir}/${version}.md`
  if (!existsSync(join(folder, path))) {
    const templatePath = join(folder, build.changelogTemplate)
    const template = existsSync(templatePath) ? await readFile(templatePath, 'utf8') : DEFAULT_TEMPLATE
    git.mutate(`create ${path}`)
    await mkdir(dirname(join(folder, path)), { recursive: true })
    await writeFile(join(folder, path), renderTemplate(template, version))
    await git.add([path])
    await git.commit(`docs: changelog ${version}`)
    ctx.checkpoint('changelog')
  }
  const remote = await ctx.gh.branchSha(branch)
  const head = /** @type {string} */ (await git.commitOf('HEAD'))
  if (remote !== head) {
    if (remote && !(await git.isAncestor(remote, head))) throw new ReleaseError(`${branch} on GitHub has other commits`)
    await git.push([`refs/heads/${branch}:refs/heads/${branch}`], { setUpstream: true, description: `push ${branch}` })
    ctx.checkpoint('push')
  }
  for (const f of ctx.settings.worktreeCopy) {
    const from = join(ctx.mainDir, f)
    const to = join(folder, f)
    if (existsSync(from) && !existsSync(to)) {
      await mkdir(dirname(to), { recursive: true })
      await copyFile(from, to)
    }
  }
  await install(ctx, folder, build)
  return folder
}

/**
 * Install in the release folder.
 * @param {Context} ctx
 * @param {string} folder
 * @param {import('../config.mjs').BuildSettings} build
 */
async function install(ctx, folder, build) {
  if (ctx.options.noInstall) return
  const pkg = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'))
  const pm = detectPackageManager(pkg, (p) => existsSync(join(folder, p)))
  /** @type {Record<string, string>} */
  const env = {}
  if (pm.name === 'yarn') {
    const rc = existsSync(join(folder, '.yarnrc.yml')) ? await readFile(join(folder, '.yarnrc.yml'), 'utf8') : ''
    if (/^enableGlobalCache:\s*false/m.test(rc) && !process.env.YARN_CACHE_FOLDER) {
      const m = /^cacheFolder:\s*["']?([^"'\n]+)["']?/m.exec(rc)
      env.YARN_CACHE_FOLDER = join(ctx.mainDir, m ? m[1].trim() : '.yarn/cache')
    }
  }
  const commands = build.worktreeInstall ?? [worktreeInstall(pm)]
  for (const c of commands) {
    ctx.git.mutate(`run ${c} in ${folder}`)
    ctx.ui.step(`${c}`)
    await sh(c, { cwd: folder, inherit: true, extraEnv: env })
  }
}

/**
 * A leftover of a released version: merged into the new release, or kept.
 * @param {Context} ctx
 * @param {Project} project
 * @param {ReleaseBranch} b
 * @param {string} branch
 * @param {string} folder
 * @param {Set<string>} released
 */
async function offerLeftover(ctx, project, b, branch, folder, released) {
  void released
  void project
  const head = b.local ?? b.remote
  if (!head) return
  const git = ctx.git.at(folder)
  if (await git.isAncestor(head, 'HEAD')) return
  const against = b.kind === 'release' ? MAIN : `${TAGS_NS}${b.version}`
  const lines = await commitLines(ctx.git, `${against}..${head}`)
  const merge = await ctx.ui.confirm(`${b.branch} (released) holds commits that are not released:\n${lines.join('\n')}\nMerge them into ${branch}?`, { default: true })
  if (!merge) return
  const r = await git.merge(head, `Merge ${b.branch} into ${branch}`)
  if (!r.clean) throw new ReleaseError(`merging ${b.branch} left conflicts in ${r.conflicts.join(', ')}`, { hint: `resolve them in ${folder}, commit and push` })
  await git.push([`refs/heads/${branch}:refs/heads/${branch}`], { description: `push ${branch}` })
  await removeLeftover(ctx, b, git)
}

/**
 * @param {Context} ctx
 * @param {ReleaseBranch} b
 * @param {import('../git.mjs').Git} into git of the release that took the commits
 */
async function removeLeftover(ctx, b, into) {
  if (b.worktree && existsSync(b.worktree)) {
    const s = await folderState(ctx.git.at(b.worktree), b.remote ? `refs/remotes/origin/${b.branch}` : null)
    if (s.tracked.length || s.untracked.length || s.ahead || s.mergeHead) {
      ctx.ui.warn(`${b.worktree} has uncommitted changes or commits not pushed; it stays`)
      return
    }
    const head = await ctx.git.at(b.worktree).commitOf('HEAD')
    if (head && !(await into.isAncestor(head, 'HEAD'))) return
    await ctx.mainGit.worktreeRemove(b.worktree, false)
  }
  if (await ctx.mainGit.branchExists(b.branch)) await ctx.mainGit.deleteBranch(b.branch)
  if (b.remote) await ctx.gh.deleteBranch(b.branch)
  ctx.ui.step(`removed the leftover ${b.branch}`)
}

/**
 * Deletes a leftover after an explicit confirmation.
 * @param {Context} ctx
 * @param {Project} project
 * @param {ReleaseBranch} b
 * @param {Set<string>} released
 */
async function deleteLeftover(ctx, project, b, released) {
  void project
  void released
  const head = b.local ?? b.remote
  const against = b.kind === 'release' ? MAIN : `${TAGS_NS}${b.version}`
  const lines = head ? await commitLines(ctx.git, `${against}..${head}`) : []
  const wt = b.worktree && existsSync(b.worktree) ? await folderState(ctx.git.at(b.worktree), b.remote ? `refs/remotes/origin/${b.branch}` : null) : null
  ctx.ui.info(
    `${b.branch} holds ${lines.length} commit(s) that are not released:\n${lines.join('\n')}${wt?.tracked.length ? `\nuncommitted changes:\n  ${wt.tracked.join('\n  ')}` : ''}`,
  )
  if (!(await ctx.ui.confirm(`Delete ${b.branch}, its folder and these commits for good?`, { default: false }))) return
  if (b.worktree && existsSync(b.worktree)) await ctx.mainGit.worktreeRemove(b.worktree, true)
  await ctx.mainGit.worktreePrune()
  if (await ctx.mainGit.branchExists(b.branch)) await ctx.mainGit.deleteBranch(b.branch)
  if (b.remote) await ctx.gh.deleteBranch(b.branch)
  ctx.ui.step(`deleted ${b.branch}`)
}
