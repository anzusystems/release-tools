// @ts-check
import { existsSync } from 'node:fs'
import { posix } from 'node:path'
import * as semver from '../semver.mjs'
import { classifyVersion, skipsCi, toolTag } from '../tags.mjs'
import { lastStable, lastOfLine, candidateFor, stableDesc, latestLine } from '../versions.mjs'
import { parseHeader, releasedEntries, rebuildIndex, otherUnreleased, absolutizeLinks } from '../changelog.mjs'
import { VERSION_FILES, resolveVersionConflict, resolveIndexConflict } from '../conflicts.mjs'
import { composeBody, withFooter } from '../release-body.mjs'
import { indexLines } from '../changelog.mjs'
import { MAIN } from '../project.mjs'
import { buildSettingsAt } from '../context.mjs'
import { ReleaseError, sleep, pollMs } from '../util.mjs'
import {
  prepareFolder,
  changelogFiles,
  checkChangelog,
  checkTaggable,
  mergeMain,
  finalCommit,
  mainVersion,
  unreleasedInMain,
  releasedUnmerged,
  handlePullsInto,
  waitMergeable,
  commitLines,
  releaseBranches,
  folderState,
} from './common.mjs'
import { cancelRelease, withdrawOnly } from './cancel.mjs'
import { createRelease } from './start.mjs'

/**
 * @typedef {import('../context.mjs').Context} Context
 * @typedef {import('../project.mjs').Project} Project
 * @typedef {import('../github.mjs').TagInfo} TagInfo
 * @typedef {import('../github.mjs').PullInfo} PullInfo
 */

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000

/**
 * @typedef {object} Rel
 * @property {'release' | 'hotfix'} kind
 * @property {string} version
 * @property {string} branch
 * @property {import('../git.mjs').Git} git git in the release folder
 */

/**
 * The release pull request: the open one from the branch, else the latest merged, else the latest closed.
 * @param {Context} ctx
 * @param {Rel} rel
 * @param {number | null} fromTag the number in the tag message
 * @returns {Promise<PullInfo | null>}
 */
async function releasePull(ctx, rel, fromTag) {
  const all = await ctx.gh.pulls({ head: rel.branch, base: 'main', state: 'all' })
  const open = all.find((p) => p.state === 'open')
  if (open) return ctx.gh.pull(open.number)
  if (fromTag) {
    const p = await ctx.gh.pull(fromTag).catch(() => null)
    if (p) return p
  }
  const merged = all.filter((p) => p.state === 'merged').sort((a, b) => b.number - a.number)[0]
  if (merged) return ctx.gh.pull(merged.number)
  const closed = all.sort((a, b) => b.number - a.number)[0]
  return closed ? ctx.gh.pull(closed.number) : null
}

/**
 * The checks of a final from release/* and hotfix/* before the tag is created.
 * @param {Context} ctx
 * @param {Project} project
 * @param {Rel} rel
 * @param {string} commit the commit that gets the tag (early: the head of the branch before anything changes)
 * @param {{ early?: boolean }} [o] early: the checks before any change, on the branch as it is
 * @returns {Promise<{ candidate: string | null }>}
 */
async function finalChecks(ctx, project, rel, commit, o = {}) {
  const released = await project.released()
  const bootstrap = await project.bootstrap(released)
  const V = rel.version
  if (released.has(V)) throw new ReleaseError(`${V} is already released`)
  if (o.early) {
    if (!(await project.hasStub(commit))) {
      throw new ReleaseError(`${rel.branch} does not contain the release workflow of the tool`, { hint: 'merge main into the branch first (never into a hotfix branch)' })
    }
  } else {
    await checkTaggable(ctx, project, commit)
  }
  const build = await buildSettingsAt(ctx, commit)
  const changelogPath = `${build.changelogDir}/${V}.md`
  checkChangelog(ctx, await ctx.git.show(commit, changelogPath), changelogPath, 'final')
  const last = lastStable(released)
  if (rel.kind === 'release') {
    const unmerged = await releasedUnmerged(ctx, project, released, bootstrap)
    if (unmerged && unmerged.version !== V) {
      throw new ReleaseError(`${unmerged.version} is released but not merged into main yet`, { hint: 'finish it first with release:publish' })
    }
    const mv = await mainVersion(ctx)
    const inMain = await unreleasedInMain(ctx, released)
    if (inMain && inMain.version !== V) throw new ReleaseError(`main holds ${inMain.version}, which is not released`, { hint: 'finish it first with release:publish' })
    if (last && !semver.gt(V, last)) {
      throw new ReleaseError(`${V} is not higher than the last released stable version ${last}`, { hint: 'start a new release with a higher version' })
    }
    if (mv && semver.valid(mv)) {
      const ok = inMain ? semver.eq(V, mv) : semver.gt(V, mv) || (bootstrap && semver.eq(V, mv))
      if (!ok) {
        throw new ReleaseError(`${V} is not higher than the version in main (${mv})`, { hint: 'start a new release with a higher version' })
      }
    }
    const req = await ctx.gh.mergeRequirements()
    if (req.problems.length) throw new ReleaseError(`main cannot take the release:\n- ${req.problems.join('\n- ')}`)
    const others = otherUnreleased(await changelogFiles(ctx.git, commit, build.changelogDir), V, released)
    if (others.length) {
      throw new ReleaseError(`the branch has the changelog of another unreleased version: ${others.map((v) => `${build.changelogDir}/${v}.md`).join(', ')}`, {
        hint: 'move its content into the changelog of this version and delete it',
      })
    }
  } else {
    await checkHotfixAncestry(ctx, project, V, commit, released)
  }
  let candidate = null
  if (ctx.settings.requireTestedPrerelease) {
    candidate = candidateFor(V, released)
    if (!candidate) throw new ReleaseError(`requireTestedPrerelease: no prerelease of ${V} is released`, { hint: 'publish an rc first' })
  }
  await waitForOtherRuns(ctx, project, rel)
  if (rel.kind === 'release') await checkOtherStableTags(ctx, project, rel, released)
  if (await project.isReleased(V)) throw new ReleaseError(`${V} was released meanwhile`, { hint: 'run the command again to finish it' })
  return { candidate }
}

/**
 * A hotfix commit contains the tag of its base version and no release of a newer line.
 * @param {Context} ctx
 * @param {Project} project
 * @param {string} version the stable version of the hotfix
 * @param {string} commit
 * @param {Set<string>} released
 */
export async function checkHotfixAncestry(ctx, project, version, commit, released) {
  const base = lastOfLine(released, semver.line(version))
  if (!base) throw new ReleaseError(`no version of the line ${semver.line(version)} is released`)
  const baseTag = await ctx.gh.tag(base)
  if (!baseTag || !(await ctx.git.hasObject(baseTag.commit)) || !(await ctx.git.isAncestor(baseTag.commit, commit))) {
    throw new ReleaseError(`the hotfix does not contain ${base}`, { hint: 'cancel the hotfix and start it again' })
  }
  const [lm, ln] = semver.line(version).split('.').map(Number)
  const first = new Map()
  for (const v of stableDesc(released)) {
    const p = /** @type {semver.SemVer} */ (semver.parse(v))
    if (p.major < lm || (p.major === lm && p.minor <= ln)) continue
    first.set(`${p.major}.${p.minor}`, v)
  }
  for (const v of first.values()) {
    const t = await ctx.gh.tag(v)
    if (t && (await ctx.git.hasObject(t.commit)) && (await ctx.git.isAncestor(t.commit, commit))) {
      throw new ReleaseError(`the hotfix contains ${v} of a newer line (was main merged into it?)`, { hint: 'cancel the hotfix and start it again' })
    }
  }
}

/**
 * Waits while a stable tag of the newest line (or of this version) has a waiting or running run, then the caller
 * checks the release state again.
 * @param {Context} ctx
 * @param {Project} project
 * @param {Rel} rel
 */
async function waitForOtherRuns(ctx, project, rel) {
  for (;;) {
    const released = await project.released()
    const line = latestLine(released)
    const last = lastStable(released)
    const active = await project.activeStableRuns((name) => {
      if (name === rel.version) return true
      if (rel.kind === 'hotfix') return false
      return (!line || !isOlder(name, line)) && (!last || semver.gte(name, last))
    })
    if (!active.length) return
    ctx.ui.status(`waiting for the release run of ${active.join(', ')} to finish`)
    await sleep(pollMs(10000))
  }
}

/**
 * @param {string} version
 * @param {string} line
 */
function isOlder(version, line) {
  const [lm, ln] = line.split('.').map(Number)
  const p = /** @type {semver.SemVer} */ (semver.parse(version))
  return p.major < lm || (p.major === lm && p.minor < ln)
}

/**
 * No stable tag of another version of the newest line is unreleased (its run could publish after this final).
 * Offers to finish that release, cancel it, or only withdraw its tag.
 * @param {Context} ctx
 * @param {Project} project
 * @param {Rel} rel
 * @param {Set<string>} released
 */
async function checkOtherStableTags(ctx, project, rel, released) {
  const line = latestLine(released)
  for (const t of await project.tagRefs()) {
    const info = classifyVersion(t.name)
    if (!info || info.kind !== 'stable' || t.name === rel.version || released.has(t.name)) continue
    if (line && isOlder(t.name, line)) continue
    const tt = await project.toolTag(t.name)
    if (!tt?.message || (tt.message.kind !== 'final' && tt.message.kind !== 'hotfix')) continue
    if (await project.isReleased(t.name)) continue
    const branches = await releaseBranches(ctx)
    const hasBranch = branches.some((b) => b.version === t.name && (b.remote || b.local))
    const choice = await ctx.ui.select(`The tag ${t.name} of another release is not released yet; ${rel.version} cannot be tagged while it exists.`, [
      { label: `finish ${t.name} first`, value: 'finish', hint: 'stop here and run release:publish for it' },
      ...(hasBranch ? [{ label: `cancel the release ${t.name}`, value: 'cancel' }] : []),
      { label: `withdraw only the tag ${t.name}`, value: 'withdraw', hint: 'its branch, folder and pull requests stay; its next final tags it again' },
    ])
    if (choice === 'finish') throw new ReleaseError(`finish ${t.name} first`, { hint: `release:publish in its folder` })
    if (choice === 'cancel') {
      const b = branches.find((x) => x.version === t.name)
      await cancelRelease(ctx, project, /** @type {any} */ (b))
    } else {
      await withdrawOnly(ctx, project, tt.tag)
    }
  }
}

/**
 * Final from release/* or hotfix/*: continues from whatever state GitHub and the registry are in.
 * @param {Context} ctx
 * @param {Project} project
 * @param {Rel} rel
 */
export async function publishFinal(ctx, project, rel) {
  const V = rel.version
  for (let round = 0; round < 50; round++) {
    await ctx.git.fetch()
    let tag = await ctx.gh.tag(V)
    if (tag && !toolTag(tag)) throw new ReleaseError(`the tag ${V} exists but was not created by the tool`)
    if (await project.isReleased(V)) {
      await finishReleased(ctx, project, rel, tag)
      return
    }
    const tagMessage = tag ? toolTag(tag)?.message : null
    const pr = rel.kind === 'release' ? await releasePull(ctx, rel, tagMessage?.pr ?? null) : null

    if (rel.kind === 'release' && pr?.state === 'merged') {
      const done = await mergedBeforeRelease(ctx, project, rel, pr, tag)
      if (done === 'wait') continue
      return
    }
    if (rel.kind === 'release' && pr?.state === 'closed') {
      const a = await ctx.ui.select(`The release pull request #${pr.number} was closed before ${V} was released.`, [
        { label: 'reopen it', value: 'reopen' },
        { label: `cancel the release ${V}`, value: 'cancel' },
        { label: 'stop here', value: 'stop' },
      ])
      if (a === 'reopen') {
        await ctx.gh.updatePull(pr.number, { state: 'open' })
        continue
      }
      if (a === 'cancel') {
        const b = (await releaseBranches(ctx)).find((x) => x.branch === rel.branch)
        await cancelRelease(ctx, project, /** @type {any} */ (b))
        return
      }
      throw new ReleaseError(`the release pull request #${pr.number} is closed`)
    }

    if (tag) {
      const next = await handleTag(ctx, project, rel, tag, pr)
      if (next === 'continue') continue
      return
    }

    // No tag: check everything first, then prepare the branch and the pull request, wait until it may be
    // merged, check again and tag.
    await finalChecks(ctx, project, rel, /** @type {string} */ (await rel.git.commitOf('HEAD')), { early: true })
    const head = await prepareFolder(ctx, rel.git, rel.branch)
    await rel.git.fetch()
    if (rel.kind === 'release') {
      await mergeMain(ctx, rel.git, V, rel.branch)
      await finalCommit(ctx, rel.git, V)
      const pushedHead = await prepareFolder(ctx, rel.git, rel.branch)
      ctx.checkpoint('push')
      let pull = pr?.state === 'open' ? pr : null
      if (!pull) {
        const build = await buildSettingsAt(ctx, pushedHead)
        const text = await rel.git.show(pushedHead, `${build.changelogDir}/${V}.md`)
        pull = await ctx.gh.createPull({ head: rel.branch, base: 'main', title: `release: ${V}`, body: (text ?? `release: ${V}`).slice(0, 60000) })
        ctx.checkpoint('pull-request')
        ctx.ui.step(`opened the release pull request ${pull.url}`)
      }
      await handlePullsInto(ctx, rel.branch, pull.number, await otherOpenReleases(ctx, rel.branch))
      const w = await waitMergeable(ctx, pull.number, { expectHead: pushedHead })
      if (w.state === 'behind' || w.state === 'head-changed') continue
      if (w.state !== 'mergeable') continue
      const H = w.pull.headSha
      await ctx.git.fetch()
      if (!(await ctx.git.isAncestor(MAIN, H))) continue
      const { candidate } = await finalChecks(ctx, project, rel, H)
      tag = await project.createTag({
        name: V,
        commit: H,
        kind: 'final',
        pr: pull.number,
        candidate: candidate ?? undefined,
        confirmedBy: w.bypassedBy ?? undefined,
      })
    } else {
      await finalCommit(ctx, rel.git, V)
      const pushedHead = await prepareFolder(ctx, rel.git, rel.branch)
      ctx.checkpoint('push')
      const { candidate } = await finalChecks(ctx, project, rel, pushedHead)
      tag = await project.createTag({ name: V, commit: pushedHead, kind: 'hotfix', candidate: candidate ?? undefined })
      void head
    }
    await project.waitForRun(tag)
  }
  throw new ReleaseError('the release did not settle after many rounds; run the command again')
}

/**
 * Other open release branches (to retarget pull requests to).
 * @param {Context} ctx
 * @param {string} except
 */
async function otherOpenReleases(ctx, except) {
  return (await releaseBranches(ctx)).filter((b) => b.kind === 'release' && b.remote && b.branch !== except).map((b) => b.branch)
}

/**
 * The tag exists and the version is not released: wait for its run, or re-run, or move the tag.
 * @param {Context} ctx
 * @param {Project} project
 * @param {Rel} rel
 * @param {TagInfo} tag
 * @param {PullInfo | null} pr
 * @returns {Promise<'continue' | 'stop'>}
 */
async function handleTag(ctx, project, rel, tag, pr) {
  const runs = await project.tagRuns(tag)
  const latest = runs[0] ?? null
  if (latest?.state === 'active') {
    await project.waitForRun(tag)
    return 'continue'
  }
  if (!latest) {
    const age = (await ctx.gh.serverTime()).getTime() - (tag.taggerDate?.getTime() ?? 0)
    if (age < 10 * 60 * 1000) {
      const r = await project.waitForRun(tag, { startMs: 10 * 60 * 1000 - age })
      if (r) return 'continue'
    }
    ctx.ui.warn(`no release run started for the tag ${tag.name}; creating it again`)
    return moveTag(ctx, project, rel, tag, pr)
  }
  if (latest.state === 'cancelled') {
    ctx.ui.warn(`the release run of ${tag.name} was cancelled; creating the tag again`)
    return moveTag(ctx, project, rel, tag, pr)
  }
  if (latest.state === 'success') {
    // The run finished but the version is not released: the registry may lag; check a few times.
    for (let i = 0; i < 6; i++) {
      if (await project.isReleased(rel.version)) return 'continue'
      await sleep(pollMs(10000))
    }
    if (latest.code === 'nothing') {
      ctx.ui.warn(`the release run did not see ${tag.name} as a release`)
      return moveTag(ctx, project, rel, tag, pr)
    }
    throw new ReleaseError(`the release run of ${tag.name} succeeded but ${rel.version} is not released`, { hint: latest.run.url })
  }
  // failure
  const code = latest.code
  ctx.ui.info(`The release run of ${tag.name} failed${code ? ` (${code})` : ''}: ${latest.run.url}${latest.message ? `\n${latest.message}` : ''}`)
  if (code === 'invalid-tag' || code === 'invalid-run') return moveTag(ctx, project, rel, tag, pr)
  const branchHead = rel.kind === 'release' ? (pr?.state === 'open' ? pr.headSha : null) : await ctx.gh.branchSha(rel.branch)
  const old = Date.now() - latest.run.createdAt.getTime() > THIRTY_DAYS - 60 * 60 * 1000
  if (latest.failedJob === 'publish') {
    if (!old && (await artifactAvailable(ctx, latest.run.id))) {
      if (await ctx.ui.confirm('Nothing reached npm. Re-run the failed publishing job?', { default: true })) {
        await ctx.gh.rerunFailed(latest.run.id)
        await sleep(pollMs(5000))
        await project.waitForRun(tag)
        return 'continue'
      }
      throw new ReleaseError('the publishing job failed', { hint: 'run the command again to re-run it or to create the tag again' })
    }
    return moveTag(ctx, project, rel, tag, pr)
  }
  if (!['checks-failed', 'package-mismatch'].includes(code ?? '')) {
    ctx.ui.info(await ctx.gh.failedLog(latest.run.id))
  } else {
    ctx.ui.info((await ctx.gh.failedLog(latest.run.id)).split('\n').slice(-80).join('\n'))
  }
  const localHead = (await rel.git.currentBranch()) === rel.branch ? await rel.git.commitOf('HEAD') : null
  if ((branchHead && branchHead !== tag.commit) || (localHead && localHead !== tag.commit && !(await rel.git.isAncestor(localHead, tag.commit)))) {
    ctx.ui.step(`the branch has new commits; moving the tag ${tag.name}`)
    return moveTag(ctx, project, rel, tag, pr)
  }
  if (ctx.settings.requireTestedPrerelease) {
    const current = candidateFor(rel.version, await project.released())
    const recorded = toolTag(tag)?.message.candidate ?? null
    if (current && current !== recorded) {
      ctx.ui.step(`${current} is released since the tag was created; moving the tag ${tag.name}`)
      return moveTag(ctx, project, rel, tag, pr)
    }
  }
  if (!old && code !== 'checks-failed' && code !== 'package-mismatch') {
    const a = await ctx.ui.select('The build failed. What now?', [
      { label: 're-run the failed jobs', value: 'rerun', hint: 'a temporary error (network, registry)' },
      { label: 'stop here', value: 'stop', hint: 'fix it in the branch and run the command again' },
    ])
    if (a === 'rerun') {
      await ctx.gh.rerunFailed(latest.run.id)
      await sleep(pollMs(5000))
      await project.waitForRun(tag)
      return 'continue'
    }
  } else if (old) {
    if (await ctx.ui.confirm('The run is too old to be re-run. Create the tag again on the same commit?', { default: true })) {
      return moveTag(ctx, project, rel, tag, pr)
    }
  }
  throw new ReleaseError(`nothing was published: the ${code === 'package-mismatch' ? 'package check' : 'checks'} of ${tag.name} failed`, {
    hint: code === 'package-mismatch' ? 'publish a new prerelease if the content changed, then run the command again' : 'fix it in the branch, push, and run the command again; the tag moves to the fix',
  })
}

/**
 * @param {Context} ctx
 * @param {number} runId
 */
async function artifactAvailable(ctx, runId) {
  const list = await ctx.gh.artifacts(runId).catch(() => [])
  return list.some((a) => a.name === 'release-tools' && !a.expired)
}

/**
 * Withdraws the unreleased stable tag (two-phase); the next round creates it again after all checks.
 * @param {Context} ctx
 * @param {Project} project
 * @param {Rel} rel
 * @param {TagInfo} tag
 * @param {PullInfo | null} pr
 * @returns {Promise<'continue'>}
 */
async function moveTag(ctx, project, rel, tag, pr) {
  void pr
  const r = await project.withdrawTag(tag)
  if (r === 'withdrawn') {
    await project.deleteFinishedRuns(tag.name)
    await project.dropSaved(tag.name)
    ctx.ui.step(`withdrew the tag ${tag.name}; it will be created again after the checks`)
  }
  void rel
  return 'continue'
}

/**
 * Rule 1: the release pull request was merged before the version was released ("unreleased version in main").
 * @param {Context} ctx
 * @param {Project} project
 * @param {Rel} rel
 * @param {PullInfo} pr
 * @param {TagInfo | null} tag
 * @returns {Promise<'wait' | 'stop'>}
 */
async function mergedBeforeRelease(ctx, project, rel, pr, tag) {
  const V = rel.version
  await listRetargeted(ctx, rel.branch)
  const target = await mergedCode(ctx, pr)
  if (tag) {
    const runs = await project.tagRuns(tag)
    if (runs[0]?.state === 'active') {
      await project.waitForRun(tag)
      return 'wait'
    }
    if (runs[0] && runs[0].state === 'failure' && ['checks-failed', 'build-failed', 'package-mismatch'].includes(runs[0].code ?? '')) {
      ctx.ui.info(`The release run of ${tag.name} failed: ${runs[0].run.url}`)
      return fixBranch(ctx, project, rel)
    }
  }
  const approved = pr.approvedBy?.length ? `approved by ${pr.approvedBy.join(', ')}` : 'not approved'
  const ok = await ctx.ui.confirm(
    `The release pull request #${pr.number} was merged into main by ${pr.mergedBy ?? 'someone'} (${approved}) before ${V} was released. Tag the code in main and release it?`,
  )
  if (!ok) throw new ReleaseError(`${V} is in main but not released`, { hint: 'run release:publish again when you want to release it' })
  let commit = target
  const msg = (await ctx.git.commitInfo(commit)).message
  if (skipsCi(msg)) {
    const later = (await ctx.git.log(`${commit}..${MAIN}`, ['--first-parent', '--reverse'])).map((c) => c.sha)
    commit = ''
    for (const c of later) {
      if (!skipsCi((await ctx.git.commitInfo(c)).message) && (await ctx.git.isAncestor(target, c))) {
        commit = c
        break
      }
    }
    if (!commit) {
      throw new ReleaseError(`the merged code of ${V} has a marker that skips the release run and no later commit of main without it exists`, {
        hint: `put a commit into release/${V} (recreated from main), open a pull request, and run release:publish there`,
      })
    }
  }
  const released = await project.released()
  const mv = await mainVersion(ctx)
  if (mv !== V) throw new ReleaseError(`main has the version ${mv}, not ${V}`)
  const last = lastStable(released)
  if (last && !semver.gt(V, last)) throw new ReleaseError(`${V} is not higher than the last released stable version ${last}`)
  await checkTaggable(ctx, project, commit)
  let candidate = null
  if (ctx.settings.requireTestedPrerelease) {
    candidate = candidateFor(V, released)
    if (!candidate) throw new ReleaseError(`requireTestedPrerelease: no prerelease of ${V} is released`)
  }
  await waitForOtherRuns(ctx, project, rel)
  await checkOtherStableTags(ctx, project, rel, released)
  if (tag) {
    const r = await project.withdrawTag(tag)
    if (r === 'released') return 'wait'
    await project.deleteFinishedRuns(tag.name)
  }
  const created = await project.createTag({ name: V, commit, kind: 'final', pr: pr.number, candidate: candidate ?? undefined, confirmedBy: ctx.login })
  await project.dropSaved(V)
  await project.waitForRun(created)
  return 'wait'
}

/**
 * The checks of a version merged into main by hand failed: the fix goes through release/X.Y.Z (created again from
 * main, or with main merged into it) and a new pull request; after its approval the tag moves to its head.
 * @param {Context} ctx
 * @param {Project} project
 * @param {Rel} rel
 * @returns {Promise<'wait' | 'stop'>}
 */
async function fixBranch(ctx, project, rel) {
  const V = rel.version
  const exists = (await ctx.gh.branchSha(rel.branch)) || (await ctx.mainGit.branchExists(rel.branch))
  let folder
  if (!exists) {
    folder = await createRelease(ctx, project, rel.branch, V, MAIN)
    ctx.ui.info(`${rel.branch} is created again from main in ${folder}. Put the fix there, commit, push, and run release:publish again.`)
    return 'stop'
  }
  const b = (await releaseBranches(ctx)).find((x) => x.branch === rel.branch)
  folder = b?.worktree && existsSync(b.worktree) ? b.worktree : await createRelease(ctx, project, rel.branch, V, `refs/heads/${rel.branch}`)
  const git = ctx.git.at(folder)
  await prepareFolder(ctx, git, rel.branch)
  if (await mergeMain(ctx, git, V, rel.branch)) await prepareFolder(ctx, git, rel.branch)
  const head = /** @type {string} */ (await git.commitOf('HEAD'))
  if (await ctx.git.isAncestor(head, MAIN)) {
    ctx.ui.info(`Put the fix into ${rel.branch} in ${folder}, commit, push, and run release:publish again.`)
    return 'stop'
  }
  const open = (await ctx.gh.pulls({ head: rel.branch, base: 'main', state: 'open' }))[0]
  if (!open) {
    const pr = await ctx.gh.createPull({ head: rel.branch, base: 'main', title: `release: ${V}`, body: `The fix of ${V}, which is in main but not released.` })
    ctx.ui.step(`opened ${pr.url}`)
  }
  return 'wait'
}

/**
 * The code a merged pull request put into main: its head for a merge commit, the resulting commit otherwise.
 * @param {Context} ctx
 * @param {PullInfo} pr
 */
async function mergedCode(ctx, pr) {
  if (!pr.mergeCommit) throw new ReleaseError(`pull request #${pr.number} has no merge commit`)
  if (!(await ctx.git.hasObject(pr.mergeCommit))) await ctx.git.fetch()
  const info = await ctx.git.commitInfo(pr.mergeCommit)
  if (info.parents.length === 2 && info.parents[1] === pr.headSha) return pr.headSha
  return pr.mergeCommit
}

/**
 * Lists pull requests GitHub retargeted to main from the deleted release branch.
 * @param {Context} ctx
 * @param {string} branch
 */
async function listRetargeted(ctx, branch) {
  const list = await ctx.gh.retargetedFrom(branch).catch(() => [])
  if (list.length) {
    ctx.ui.warn(
      `GitHub retargeted these pull requests from ${branch} to main; merging them would bring unreleased code into main:\n${list
        .map((p) => `  #${p.number} ${p.title} ${p.url}`)
        .join('\n')}`,
    )
  }
}

/**
 * The version is released: tag, commit, GitHub Release, merge (final) or changelog pull request (hotfix), cleanup.
 * @param {Context} ctx
 * @param {Project} project
 * @param {Rel} rel
 * @param {TagInfo | null} tag
 */
export async function finishReleased(ctx, project, rel, tag) {
  const V = rel.version
  if (!tag) {
    ctx.ui.step(`${V} is released but its tag is missing; restoring it`)
    await project.restoreReleasedTag(V, null)
    tag = await ctx.gh.tag(V)
    if (!tag) throw new ReleaseError(`the tag ${V} could not be restored`)
    await ctx.git.fetch()
  }
  const H = await verifiedCommit(ctx, project, V, tag)
  await ensureRelease(ctx, project, V, H)
  if (rel.kind === 'release') {
    await mergeReleased(ctx, project, rel, H)
    await cleanupRelease(ctx, project, rel, H)
  } else {
    await hotfixChangelog(ctx, project, V, H)
    await cleanupHotfix(ctx, project, rel, H)
    ctx.ui.info('Is the bug in the latest version too? Make a patch release.')
  }
}

/**
 * The commit a released version was built from, checked against its tag.
 * @param {Context} ctx
 * @param {Project} project
 * @param {string} version
 * @param {TagInfo} tag
 */
export async function verifiedCommit(ctx, project, version, tag) {
  const r = await project.releasedCommit(version)
  let commit = r.commit
  if (!commit) {
    const ok = await ctx.ui.confirm(`${version} has no ${project.npm ? 'provenance on npm' : 'commit in its GitHub Release'}. Take the commit of its tag (${tag.commit.slice(0, 12)}) as the released commit?`)
    if (!ok) throw new ReleaseError(`the released commit of ${version} is unknown`)
    commit = tag.commit
  }
  if (commit !== tag.commit) {
    ctx.ui.warn(`${version} was released from ${commit.slice(0, 12)}, but its tag points to ${tag.commit.slice(0, 12)}`)
    const ok = await ctx.ui.confirm(`Move the tag ${version} to ${commit.slice(0, 12)}, the released commit?`)
    if (!ok) throw new ReleaseError(`the tag of ${version} does not point to the released commit`)
    await ctx.git.push([`:refs/tags/${version}`], { leases: [`refs/tags/${version}:${tag.refSha}`], description: `delete the tag ${version}` })
    const kind = toolTag(tag)?.message.kind ?? 'final'
    await project.createTag({ name: version, commit, kind: /** @type {any} */ (kind) })
    await ctx.git.fetch()
  }
  if (!(await ctx.git.hasObject(commit))) await ctx.git.fetch()
  return commit
}

/**
 * The GitHub Release of a released version exists and is published (drafts only when the tag points to the commit).
 * @param {Context} ctx
 * @param {Project} project
 * @param {string} version
 * @param {string} commit
 */
export async function ensureRelease(ctx, project, version, commit) {
  const rel = await project.release(version)
  const released = await project.released()
  const info = classifyVersion(version)
  const prerelease = info?.kind !== 'stable'
  const others = new Set([...released].filter((v) => v !== version))
  const latest = !prerelease && stableDesc(others).every((v) => semver.gt(version, v))
  if (rel && !rel.draft) return rel
  const tag = await ctx.gh.tag(version)
  if (!tag || tag.commit !== commit) throw new ReleaseError(`the tag ${version} does not point to the released commit ${commit.slice(0, 12)}`)
  if (rel?.draft) {
    ctx.ui.step(`publishing the draft GitHub Release ${version}`)
    return ctx.gh.publishDraft(rel.id, { tag: version, prerelease, latest, commit })
  }
  const build = await buildSettingsAt(ctx, commit)
  const path = `${build.changelogDir}/${info?.core ?? version}.md`
  const text = await ctx.git.show(commit, path)
  const changelog = text ? absolutizeLinks(text, { repo: ctx.settings.repo, ref: version, fileDir: posix.dirname(path) }) : null
  const body = composeBody({ repo: ctx.settings.repo, tag: version, commit, changelog, changelogPath: text ? path : null, branch: null })
  ctx.ui.step(`creating the GitHub Release ${version}`)
  return ctx.gh.createRelease({
    tag: version,
    name: version,
    body: withFooter(body, { commit, createdBy: 'release-tools CLI' }),
    prerelease,
    latest,
    commit,
  })
}

/**
 * Merges exactly the released commit H into main (steps 7 and 8, rules 2 and 3).
 * @param {Context} ctx
 * @param {Project} project
 * @param {Rel} rel
 * @param {string} H
 */
async function mergeReleased(ctx, project, rel, H) {
  const V = rel.version
  for (let round = 0; round < 30; round++) {
    await ctx.git.fetch()
    if (await ctx.git.isAncestor(H, MAIN)) {
      const tt = await project.toolTag(V)
      const pr = await releasePull(ctx, rel, tt?.message?.pr ?? null)
      if (pr?.state === 'merged' && pr.headSha !== H && (await ctx.git.hasObject(pr.headSha))) {
        // Commits of the merged head that are neither in the release nor came from main before the merge.
        const before = pr.mergeCommit ? `^${pr.mergeCommit}^1` : null
        const foreign = (await ctx.git.log(`${H}..${pr.headSha}`, before ? [before] : [])).filter((c) => c.parents.length < 2 || !before)
        if (foreign.length) {
          ctx.ui.warn(
            `these commits reached main without being in ${V}; they go out with the next release:\n${foreign.map((c) => `  ${c.sha.slice(0, 12)} ${c.subject}`).join('\n')}`,
          )
        }
      }
      if (pr?.state === 'merged') await listRetargeted(ctx, rel.branch)
      await deleteMergeBranch(ctx, V)
      ctx.ui.step(`${V} is in main`)
      return
    }
    const released = await project.released()
    const top = lastStable(released)
    if (top && semver.gt(top, V)) throw new ReleaseError(`${top} is released and higher than ${V}; ${V} is not merged into main`)
    const tt = await project.toolTag(V)
    const pr = await releasePull(ctx, rel, tt?.message?.pr ?? null)
    const confirmedBypass = !!tt?.message?.confirmedBy
    if (!pr || pr.state !== 'open') {
      if (pr) await listRetargeted(ctx, rel.branch)
      await mergeThroughNewPull(ctx, project, rel, H, pr, confirmedBypass)
      continue
    }
    await handlePullsInto(ctx, rel.branch, pr.number, await otherOpenReleases(ctx, rel.branch))
    const head = pr.headSha
    if (!(await ctx.git.hasObject(head))) await ctx.git.fetch()
    const ok = head === H || (await onlyMainMerges(ctx, H, head, { confirm: true }))
    if (!ok) {
      ctx.ui.warn(`the release pull request has commits after the released commit:\n${(await commitLines(ctx.git, `${H}..${head}`)).join('\n')}`)
      await mergeThroughNewPull(ctx, project, rel, H, pr, confirmedBypass)
      continue
    }
    const w = await waitMergeable(ctx, pr.number, { expectHead: head, allowBypass: true, bypassConfirmed: confirmedBypass && head === H })
    if (w.state === 'merged' || w.state === 'closed' || w.state === 'head-changed') continue
    if (w.state === 'behind') {
      await bringUpToDate(ctx, rel, head)
      continue
    }
    const m = await ctx.gh.mergePull(pr.number, { sha: head, title: `release: ${V}` })
    if (m.merged) {
      ctx.checkpoint('merge')
      ctx.ui.step(`merged the release pull request #${pr.number} into main`)
      continue
    }
    if ('reason' in m && m.reason === 'not-mergeable') await bringUpToDate(ctx, rel, head)
  }
  throw new ReleaseError(`${V} could not be merged into main`, { hint: 'run the command again' })
}

/**
 * Between H and head there are only merges of main whose trees are the automatic merge result (version and
 * index resolved), or a conflict resolution the user confirms now.
 * @param {Context} ctx
 * @param {string} H
 * @param {string} head
 * @param {{ confirm: boolean }} o
 */
export async function onlyMainMerges(ctx, H, head, o) {
  if (!(await ctx.git.isAncestor(H, head))) return false
  const commits = (await ctx.git.log(`${H}..${head}`, [`^${MAIN}`])).reverse()
  const ok = new Set([H])
  for (const c of commits) {
    if (c.parents.length !== 2) return false
    const [p1, p2] = c.parents
    if (!ok.has(p1) || !(await ctx.git.isAncestor(p2, MAIN))) return false
    const tree = await ctx.git.treeOf(c.sha)
    const expected = await autoMergeTree(ctx, p1, p2)
    if (expected !== tree) {
      if (!o.confirm) return false
      const diff = expected
        ? (await ctx.git.raw(['diff', '--stat', expected, tree])).stdout
        : '(the merge has other conflicts; its resolution is below)\n' + (await ctx.git.raw(['diff', '--stat', `${p1}`, c.sha])).stdout
      ctx.ui.info(`The merge of main ${c.sha.slice(0, 12)} differs from the automatic result:\n${diff}`)
      if (!(await ctx.ui.confirm('Is this a resolution of conflicts with main only?', { default: false }))) return false
    }
    ok.add(c.sha)
  }
  return ok.has(head)
}

/**
 * The tree `git merge-tree` gives for merging p2 into p1, with the version and index conflicts resolved; null
 * when other conflicts remain.
 * @param {Context} ctx
 * @param {string} p1
 * @param {string} p2
 */
async function autoMergeTree(ctx, p1, p2) {
  const r = await ctx.git.mergeTree(p1, p2)
  if (r.clean) return r.tree
  const pkgText = await ctx.git.show(p1, 'package.json')
  const version = pkgText ? JSON.parse(pkgText).version : null
  const build = await buildSettingsAt(ctx, p1)
  /** @type {Map<string, { base: string | null, ours: string | null, theirs: string | null }>} */
  const files = new Map()
  for (const c of r.conflicts) {
    const e = files.get(c.path) ?? { base: null, ours: null, theirs: null }
    const text = await ctx.git.blob(c.sha)
    if (c.stage === 1) e.base = text
    if (c.stage === 2) e.ours = text
    if (c.stage === 3) e.theirs = text
    files.set(c.path, e)
  }
  const replaced = []
  for (const [path, stages] of files) {
    let resolved = null
    if (VERSION_FILES.includes(path) && version) resolved = await resolveVersionConflict(stages, version)
    else if (build.changelogIndex && path === build.changelogIndex) {
      const merged = await changelogFiles(ctx.git, r.tree, build.changelogDir)
      resolved = await resolveIndexConflict(stages, indexLines(releasedEntries(merged), build.changelogIndex, build.changelogDir))
    }
    if (resolved === null) return null
    replaced.push({ path, blob: await ctx.git.writeBlob(resolved) })
  }
  return ctx.git.replaceInTree(r.tree, replaced)
}

/**
 * Merges origin/main into the head of the release pull request locally (after the release) and pushes.
 * @param {Context} ctx
 * @param {Rel} rel
 * @param {string} head
 */
async function bringUpToDate(ctx, rel, head) {
  const cur = await rel.git.commitOf('HEAD')
  if (cur !== head) {
    const s = await folderState(rel.git, `refs/remotes/origin/${rel.branch}`)
    if (s.tracked.length || s.mergeHead) throw new ReleaseError(`the release folder ${rel.git.dir} has unfinished changes`, { hint: 'commit or discard them' })
    if (!(await rel.git.mergeFfOnly(head))) throw new ReleaseError(`the release folder is not at the head of the pull request`)
  }
  const merged = await mergeMainAfterRelease(ctx, rel)
  if (merged) await rel.git.push([`HEAD:refs/heads/${rel.branch}`], { description: `push ${rel.branch}` })
}

/**
 * @param {Context} ctx
 * @param {Rel} rel
 */
async function mergeMainAfterRelease(ctx, rel) {
  try {
    return await mergeMain(ctx, rel.git, rel.version, rel.branch)
  } catch (e) {
    if (e instanceof ReleaseError && (await rel.git.hasMergeHead())) {
      throw new ReleaseError(`${e.message}\nAfter you commit the resolution, the command shows what it changed against the automatic result and asks you to confirm it.`, {
        hint: e.hint,
      })
    }
    throw e
  }
}

/**
 * Rule 3 and foreign commits: a new pull request from the released commit (release-merge/X.Y.Z).
 * @param {Context} ctx
 * @param {Project} project
 * @param {Rel} rel
 * @param {string} H
 * @param {PullInfo | null} original
 * @param {boolean} confirmedBypass
 */
async function mergeThroughNewPull(ctx, project, rel, H, original, confirmedBypass) {
  const V = rel.version
  const branch = `release-merge/${V}`
  void project
  void confirmedBypass
  let sha = await ctx.gh.branchSha(branch)
  if (!sha) {
    let head = H
    if (!(await ctx.git.isAncestor(MAIN, H))) {
      const tree = await autoMergeTree(ctx, H, /** @type {string} */ (await ctx.git.commitOf(MAIN)))
      if (!tree) {
        throw new ReleaseError(`main conflicts with the released commit of ${V} beyond the version and the index`, {
          hint: `create ${branch} from the tag ${V}, merge main into it, resolve the conflicts, push it and run the command again`,
        })
      }
      const mainSha = /** @type {string} */ (await ctx.git.commitOf(MAIN))
      ctx.git.mutate(`create a merge of main on top of ${H.slice(0, 12)}`)
      head = await ctx.git.out(['commit-tree', tree, '-p', H, '-p', mainSha, '-m', `Merge main into ${branch}`])
    }
    await ctx.git.push([`${head}:refs/heads/${branch}`], { description: `push ${branch}` })
    sha = head
  }
  const existing = (await ctx.gh.pulls({ head: branch, base: 'main', state: 'open' }))[0]
  let pr = existing ? await ctx.gh.pull(existing.number) : null
  if (!pr) {
    pr = await ctx.gh.createPull({
      head: branch,
      base: 'main',
      title: `release: ${V}`,
      body: `Merges the released commit ${H} of ${V} into main${original ? ` (instead of #${original.number})` : ''}.`,
    })
    ctx.ui.step(`opened ${pr.url} with the released commit`)
  }
  if (original?.state === 'open') {
    await ctx.gh.comment(original.number, `Replaced by #${pr.number}, which merges exactly the released commit of ${V}.`)
    await ctx.gh.updatePull(original.number, { state: 'closed' })
  }
  for (;;) {
    await ctx.git.fetch()
    const cur = await ctx.gh.pull(pr.number)
    if (cur.state === 'merged') break
    if (cur.headSha !== H && !(await onlyMainMerges(ctx, H, cur.headSha, { confirm: true }))) {
      throw new ReleaseError(`${branch} has commits besides the released commit and merges of main`, { hint: `reset ${branch} to the tag ${V} and run again` })
    }
    const w = await waitMergeable(ctx, pr.number, { expectHead: cur.headSha })
    if (w.state === 'head-changed') continue
    if (w.state === 'closed') throw new ReleaseError(`${cur.url} was closed`, { hint: 'reopen it and run the command again' })
    if (w.state === 'merged') break
    if (w.state === 'behind') {
      const mainSha = /** @type {string} */ (await ctx.git.commitOf(MAIN))
      const tree = await autoMergeTree(ctx, cur.headSha, mainSha)
      if (!tree) throw new ReleaseError(`main conflicts with ${branch}`, { hint: `merge main into ${branch}, resolve, push and run again` })
      ctx.git.mutate(`merge main into ${branch}`)
      const merged = await ctx.git.out(['commit-tree', tree, '-p', cur.headSha, '-p', mainSha, '-m', `Merge main into ${branch}`])
      await ctx.git.push([`${merged}:refs/heads/${branch}`], { description: `push ${branch}`, leases: [`refs/heads/${branch}:${cur.headSha}`] })
      continue
    }
    const m = await ctx.gh.mergePull(pr.number, { sha: cur.headSha, title: `release: ${V}` })
    if (m.merged) {
      ctx.ui.step(`merged ${cur.url} into main`)
      break
    }
  }
}

/**
 * @param {Context} ctx
 * @param {string} version
 */
async function deleteMergeBranch(ctx, version) {
  const branch = `release-merge/${version}`
  const sha = await ctx.gh.branchSha(branch)
  if (sha && (await ctx.git.hasObject(sha)) && (await ctx.git.isAncestor(sha, MAIN))) {
    await ctx.gh.deleteBranch(branch)
    ctx.ui.step(`deleted ${branch}`)
  }
}

/**
 * Step 9: removes the folder, the local and the remote branch, but only what holds nothing unreleased.
 * @param {Context} ctx
 * @param {Project} project
 * @param {Rel} rel
 * @param {string} H
 */
async function cleanupRelease(ctx, project, rel, H) {
  void project
  await ctx.git.fetch()
  const tt = await project.toolTag(rel.version)
  const pr = await releasePull(ctx, rel, tt?.message?.pr ?? null)
  const mergedHead = pr?.state === 'merged' ? pr.headSha : null
  const safe = async (/** @type {string | null} */ sha) => {
    if (!sha) return true
    if (!(await ctx.git.hasObject(sha))) return false
    if (await ctx.git.isAncestor(sha, MAIN)) return true
    if (mergedHead && sha === mergedHead) return true
    return onlyMainMerges(ctx, H, sha, { confirm: false })
  }
  await removeBranchAndFolder(ctx, rel, safe, `${MAIN}`)
}

/**
 * @param {Context} ctx
 * @param {Rel} rel
 * @param {(sha: string | null) => Promise<boolean>} safe
 * @param {string} against where the kept commits are listed against
 */
async function removeBranchAndFolder(ctx, rel, safe, against) {
  const b = (await releaseBranches(ctx)).find((x) => x.branch === rel.branch)
  if (!b) return
  const problems = []
  let untracked = []
  if (b.worktree && existsSync(b.worktree)) {
    const wg = ctx.git.at(b.worktree)
    const s = await folderState(wg, b.remote ? `refs/remotes/origin/${rel.branch}` : null)
    if (s.tracked.length) problems.push(`uncommitted changes:\n  ${s.tracked.join('\n  ')}`)
    if (s.mergeHead) problems.push('an unfinished merge')
    untracked = s.untracked
    const head = await wg.commitOf('HEAD')
    if (b.remote && head !== b.remote && !(await ctx.git.isAncestor(/** @type {string} */ (head), b.remote))) problems.push('commits that are not pushed')
    if (!(await safe(head))) problems.push(`commits that are not in main:\n${(await commitLines(wg, `${against}..HEAD`)).join('\n')}`)
  }
  if (b.local && !(await safe(b.local))) problems.push(`the local branch has commits that are not in main:\n${(await commitLines(ctx.git, `${against}..${b.local}`)).join('\n')}`)
  if (b.remote && !(await safe(b.remote))) problems.push(`${rel.branch} on GitHub has commits that are not in main:\n${(await commitLines(ctx.git, `${against}..${b.remote}`)).join('\n')}`)
  if (problems.length) {
    ctx.ui.warn(`${rel.branch} and its folder stay, because they hold:\n${problems.join('\n')}\nrelease:start offers them as a leftover of ${rel.version}.`)
    return
  }
  if (b.remote && rel.kind === 'release') await handlePullsInto(ctx, rel.branch, null, await otherOpenReleases(ctx, rel.branch))
  if (b.worktree && existsSync(b.worktree)) {
    let force = false
    if (untracked.length) {
      ctx.ui.info(`Files that git does not track in ${b.worktree}:\n  ${untracked.slice(0, 50).join('\n  ')}${untracked.length > 50 ? '\n  …' : ''}`)
      force = await ctx.ui.confirm('Delete them together with the folder?', { default: false })
      if (!force) {
        ctx.ui.warn(`the folder ${b.worktree} stays because of those files; delete it yourself when you no longer need them`)
      }
    }
    if (!untracked.length || force) {
      await ctx.mainGit.worktreeRemove(b.worktree, force)
      ctx.ui.step(`removed the folder ${b.worktree}`)
    }
  }
  if (b.local && !(b.worktree && existsSync(b.worktree))) {
    await ctx.mainGit.deleteBranch(rel.branch)
  }
  if (b.remote && (await ctx.gh.branchSha(rel.branch))) {
    await ctx.gh.deleteBranch(rel.branch)
    ctx.ui.step(`deleted ${rel.branch} on GitHub`)
  }
}

/**
 * Hotfix step 5: the changelog of the hotfix reaches main through `docs: changelog X.Y.Z` (GitHub API only).
 * @param {Context} ctx
 * @param {Project} project
 * @param {string} V
 * @param {string} H
 */
async function hotfixChangelog(ctx, project, V, H) {
  void project
  const tagBuild = await buildSettingsAt(ctx, H)
  const path = `${tagBuild.changelogDir}/${V}.md`
  const content = await ctx.git.show(H, path)
  if (content === null) throw new ReleaseError(`${path} is missing in the released commit`)
  const branch = `docs/changelog-${V}`
  for (let round = 0; round < 20; round++) {
    await ctx.git.fetch()
    const mainBuild = await buildSettingsAt(ctx, MAIN)
    const mainPath = `${mainBuild.changelogDir}/${V}.md`
    const inMain = await ctx.git.show(MAIN, mainPath)
    const open = (await ctx.gh.pulls({ head: branch, base: 'main', state: 'open' }))[0]
    if (inMain !== null && parseHeader(inMain)?.date && !open) {
      const merged = (await ctx.gh.pulls({ head: branch, base: 'main', state: 'closed' })).find((p) => p.state === 'merged')
      const sha = await ctx.gh.branchSha(branch)
      if (sha && merged && sha === merged.headSha) {
        await ctx.gh.deleteBranch(branch)
        ctx.ui.step(`deleted ${branch}`)
      } else if (sha) {
        ctx.ui.warn(`${branch} stays on GitHub: it does not point to the merged pull request`)
      }
      return
    }
    let pr = open ? await ctx.gh.pull(open.number) : null
    if (!pr) {
      const commit = await changelogCommit(ctx, V, content, mainBuild, mainPath)
      if (await ctx.gh.branchSha(branch)) await ctx.gh.forceBranch(branch, commit)
      else await ctx.gh.createBranch(branch, commit)
      pr = await ctx.gh.createPull({ head: branch, base: 'main', title: `docs: changelog ${V}`, body: `The changelog of the hotfix ${V}.` })
      ctx.ui.step(`opened ${pr.url}`)
      continue
    }
    const w = await waitMergeable(ctx, pr.number, { expectHead: pr.headSha })
    if (w.state === 'behind') {
      const commit = await changelogCommit(ctx, V, content, mainBuild, mainPath)
      await ctx.gh.forceBranch(branch, commit)
      continue
    }
    if (w.state !== 'mergeable') continue
    const m = await ctx.gh.mergePull(pr.number, { sha: w.pull.headSha, title: `docs: changelog ${V}` })
    if (m.merged) ctx.ui.step(`merged ${pr.url}`)
  }
  throw new ReleaseError(`the changelog of ${V} did not reach main`, { hint: 'run the command again' })
}

/**
 * A commit on the current main with the changelog file and the rebuilt index.
 * @param {Context} ctx
 * @param {string} V
 * @param {string} content
 * @param {import('../config.mjs').BuildSettings} mainBuild
 * @param {string} mainPath
 */
async function changelogCommit(ctx, V, content, mainBuild, mainPath) {
  const mainSha = /** @type {string} */ (await ctx.git.commitOf(MAIN))
  /** @type {Record<string, string>} */
  const files = { [mainPath]: content }
  if (mainBuild.changelogIndex) {
    const current = (await ctx.git.show(MAIN, mainBuild.changelogIndex)) ?? '# Changelog\n'
    const dirFiles = (await changelogFiles(ctx.git, MAIN, mainBuild.changelogDir)).filter((f) => f.name !== `${V}.md`)
    dirFiles.push({ name: `${V}.md`, text: content })
    files[mainBuild.changelogIndex] = rebuildIndex(current, releasedEntries(dirFiles), mainBuild.changelogIndex, mainBuild.changelogDir)
  }
  return ctx.gh.commitFiles({ parent: mainSha, files, message: `docs: changelog ${V}` })
}

/**
 * Hotfix step 6: the branch and the folder go only when their head is in the tag.
 * @param {Context} ctx
 * @param {Project} project
 * @param {Rel} rel
 * @param {string} H
 */
async function cleanupHotfix(ctx, project, rel, H) {
  void project
  const safe = async (/** @type {string | null} */ sha) => !sha || ((await ctx.git.hasObject(sha)) && (await ctx.git.isAncestor(sha, H)))
  await removeBranchAndFolder(ctx, rel, safe, H)
}

