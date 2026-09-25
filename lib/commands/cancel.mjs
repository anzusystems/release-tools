// @ts-check
import { existsSync } from 'node:fs'
import { toolTag } from '../tags.mjs'
import { ReleaseError } from '../util.mjs'
import { folderState, sameFolderState, handlePullsInto, releaseBranches, commitLines } from './common.mjs'

/**
 * @typedef {import('../context.mjs').Context} Context
 * @typedef {import('../project.mjs').Project} Project
 * @typedef {import('./common.mjs').ReleaseBranch} ReleaseBranch
 */

/**
 * Withdraws an unreleased stable tag without creating a new one: two-phase delete, then its finished runs.
 * @param {Context} ctx
 * @param {Project} project
 * @param {import('../github.mjs').TagInfo} tag
 * @returns {Promise<'withdrawn' | 'released'>}
 */
export async function withdrawOnly(ctx, project, tag) {
  await project.deleteFinishedRuns(tag.name)
  const r = await project.withdrawTag(tag)
  if (r === 'released') {
    ctx.ui.warn(`${tag.name} was released meanwhile; its tag is restored`)
    return r
  }
  await project.deleteFinishedRuns(tag.name)
  await project.dropSaved(tag.name)
  ctx.ui.step(`withdrew the tag ${tag.name}`)
  return r
}

/**
 * Cancels an open release or hotfix. Refuses a released version and a release pull request merged into main.
 * @param {Context} ctx
 * @param {Project} project
 * @param {ReleaseBranch} b
 */
export async function cancelRelease(ctx, project, b) {
  const V = b.version
  // 1. Nothing that would be lost.
  /** @type {Awaited<ReturnType<typeof folderState>> | null} */
  let confirmed = null
  if (b.worktree && existsSync(b.worktree)) {
    const wg = ctx.git.at(b.worktree)
    const s = await folderState(wg, b.remote ? `refs/remotes/origin/${b.branch}` : null)
    confirmed = s
    const lost = []
    if (s.tracked.length) lost.push(`uncommitted changes:\n  ${s.tracked.join('\n  ')}`)
    if (s.unmerged.length) lost.push(`conflicts that are not resolved:\n  ${s.unmerged.join('\n  ')}`)
    if (s.untracked.length) lost.push(`files git does not track:\n  ${s.untracked.slice(0, 30).join('\n  ')}`)
    if (s.ahead) lost.push(`commits not pushed:\n${(await commitLines(wg, `refs/remotes/origin/${b.branch}..HEAD`)).join('\n')}`)
    if (s.mergeHead) lost.push(`${s.operation ?? 'a merge'} that is not finished`)
    if (lost.length) {
      ctx.ui.info(`${b.worktree} has:\n${lost.join('\n')}`)
      if (!(await ctx.ui.confirm('Throw all of that away?', { default: false }))) throw new ReleaseError(`${b.branch} is not cancelled`)
    }
  } else if (b.local && b.remote && b.local !== b.remote && !(await ctx.git.isAncestor(b.local, b.remote))) {
    ctx.ui.info(`the local branch ${b.branch} has commits not pushed:\n${(await commitLines(ctx.git, `${b.remote}..${b.local}`)).join('\n')}`)
    if (!(await ctx.ui.confirm('Throw them away?', { default: false }))) throw new ReleaseError(`${b.branch} is not cancelled`)
  }
  // 2. The state before anything changes.
  const refuse = async () => {
    if (await project.isReleased(V)) {
      throw new ReleaseError(`${V} is already released and cannot be cancelled`, { hint: 'finish it with release:publish' })
    }
    if (b.kind === 'release') {
      const merged = (await ctx.gh.pulls({ head: b.branch, base: 'main', state: 'closed' })).find((p) => p.state === 'merged')
      if (merged) throw new ReleaseError(`the release pull request #${merged.number} of ${V} is merged into main`, { hint: 'finish it with release:publish' })
    }
  }
  await refuse()
  // 3. Pull requests into the branch, then the release pull request; the hotfix branch.
  if (b.remote) {
    const others = (await releaseBranches(ctx)).filter((x) => x.kind === b.kind && x.remote && x.branch !== b.branch).map((x) => x.branch)
    const releasePr = b.kind === 'release' ? (await ctx.gh.pulls({ head: b.branch, base: 'main', state: 'open' }))[0] ?? null : null
    await handlePullsInto(ctx, b.branch, releasePr?.number ?? null, others)
    await refuse()
    if (releasePr) {
      await ctx.gh.comment(releasePr.number, `The release ${V} was cancelled with release-tools.`)
      await ctx.gh.updatePull(releasePr.number, { state: 'closed' })
      ctx.ui.step(`closed the release pull request #${releasePr.number}`)
    }
    if (b.kind === 'hotfix') {
      if (!(await ctx.mainGit.deleteRemoteBranch(b.branch, b.remote))) {
        throw new ReleaseError(`${b.branch} on GitHub changed meanwhile; it is not deleted`, { hint: 'look at the new commits and cancel again' })
      }
      ctx.ui.step(`deleted ${b.branch} on GitHub`)
    }
  }
  // 4. The tag of the version (two-phase) and its finished runs, after checking the state again.
  await refuse()
  await project.deleteFinishedRuns(V)
  const tag = await ctx.gh.tag(V)
  if (tag && toolTag(tag)) {
    const r = await withdrawOnly(ctx, project, tag)
    if (r === 'released') {
      throw new ReleaseError(`${V} was released while it was being cancelled; its tag is restored`, { hint: 'finish it with release:publish' })
    }
  }
  // 5. Folder, local branch, remote branch; each only if nothing new appeared since it was confirmed.
  if (b.worktree && existsSync(b.worktree)) {
    const now = await folderState(ctx.git.at(b.worktree), b.remote ? `refs/remotes/origin/${b.branch}` : null)
    if (confirmed && !sameFolderState(confirmed, now)) {
      throw new ReleaseError(`${b.worktree} changed after it was checked; the folder and the branches stay`, { hint: 'cancel again in release:start' })
    }
    await ctx.mainGit.worktreeRemove(b.worktree, true)
    ctx.ui.step(`removed the folder ${b.worktree}`)
  }
  await ctx.mainGit.worktreePrune()
  const local = await ctx.mainGit.commitOf(`refs/heads/${b.branch}`)
  if (local) {
    if (b.local && local !== b.local && !(await ctx.mainGit.isAncestor(local, b.local))) {
      throw new ReleaseError(`the local branch ${b.branch} got new commits; it stays`, { hint: 'cancel again in release:start' })
    }
    await ctx.mainGit.deleteBranch(b.branch, local)
  }
  const remote = await ctx.gh.branchSha(b.branch)
  if (remote) {
    if (b.remote && remote !== b.remote) throw new ReleaseError(`${b.branch} on GitHub changed meanwhile; it stays`, { hint: 'look at the new commits and cancel again' })
    if (await ctx.mainGit.deleteRemoteBranch(b.branch, remote)) ctx.ui.step(`deleted ${b.branch} on GitHub`)
  }
  ctx.ui.info(`${b.branch} is cancelled. Its prereleases stay; release:cleanup deletes tags that never became a release.`)
}
