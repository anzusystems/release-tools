// @ts-check
import { existsSync } from 'node:fs'
import { toolTag } from '../tags.mjs'
import { ReleaseError } from '../util.mjs'
import { folderState, sameFolderState, losses, handlePullsInto, releaseBranches, commitLines, unreleasedInMain, copiesOf, inMainFolder } from './common.mjs'
import { MAIN } from '../project.mjs'

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
  if (inMainFolder(ctx, b)) {
    throw new ReleaseError(`${b.branch} is checked out in the main folder ${ctx.mainDir}`, { hint: 'switch it to main (git switch main) and cancel again' })
  }
  const upstream = b.remote ? `refs/remotes/origin/${b.branch}` : null
  // 1. Nothing that would be lost without being shown and confirmed.
  /** @type {Awaited<ReturnType<typeof folderState>> | null} */
  let confirmed = null
  const lost = []
  if (b.worktree && existsSync(b.worktree)) {
    const wg = ctx.git.at(b.worktree)
    confirmed = await folderState(wg, upstream, copiesOf(ctx))
    if (confirmed.unverifiable) {
      throw new ReleaseError(`${b.worktree} has changes in a submodule, which the tool cannot check`, { hint: 'commit or discard them, then cancel again' })
    }
    lost.push(...(await losses(wg, confirmed, upstream)))
    if (!upstream && confirmed.head && !(await ctx.git.isAncestor(confirmed.head, MAIN))) {
      lost.push(`commits that are only in this folder:\n${(await commitLines(wg, `${MAIN}..HEAD`)).join('\n')}`)
    }
  } else if (b.local && (b.remote ? !(await ctx.git.isAncestor(b.local, b.remote)) : !(await ctx.git.isAncestor(b.local, MAIN)))) {
    lost.push(`commits of the local branch that are not on GitHub:\n${(await commitLines(ctx.git, `${b.remote ?? MAIN}..${b.local}`)).join('\n')}`)
  }
  if (lost.length) {
    ctx.ui.info(`${b.worktree ?? `the local branch ${b.branch}`} has:\n${lost.join('\n')}`)
    if (!(await ctx.ui.confirm('Throw all of that away?', { default: false }))) throw new ReleaseError(`${b.branch} is not cancelled`)
  }
  /** Right before each deletion: the folder and both branches are exactly as they were checked and confirmed. */
  const assertUnchanged = async () => {
    if (b.worktree && existsSync(b.worktree)) {
      const now = await folderState(ctx.git.at(b.worktree), upstream, copiesOf(ctx))
      if (!confirmed || !sameFolderState(confirmed, now)) {
        throw new ReleaseError(`${b.worktree} changed after it was checked; nothing more is deleted`, { hint: 'cancel again in release:start' })
      }
    }
    if ((await ctx.mainGit.commitOf(`refs/heads/${b.branch}`)) !== (b.local ?? null)) {
      throw new ReleaseError(`the local branch ${b.branch} changed after it was checked; nothing more is deleted`, { hint: 'cancel again in release:start' })
    }
    if ((await ctx.gh.branchSha(b.branch)) !== (b.remote ?? null)) {
      throw new ReleaseError(`${b.branch} on GitHub changed after it was checked; nothing more is deleted`, { hint: 'look at it and cancel again' })
    }
  }
  // 2. The state before anything changes.
  const refuse = async () => {
    if (await project.isReleased(V)) {
      throw new ReleaseError(`${V} is already released and cannot be cancelled`, { hint: 'finish it with release:publish' })
    }
    if (b.kind === 'release') {
      // Only "an unreleased version in main" (the version of main is V and its release pull request is merged)
      // is refused; a pull request from the branch merged before the final commit does not block the cancel.
      await ctx.git.fetch()
      const inMain = await unreleasedInMain(ctx, await project.released())
      if (inMain?.version === V) throw new ReleaseError(`main holds ${V}: its release pull request #${inMain.pr.number} is merged`, { hint: 'finish it with release:publish' })
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
      await assertUnchanged()
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
  // 5. Folder, local branch, remote branch: exactly what was checked, nothing that appeared since.
  if (b.kind === 'hotfix' && b.remote) b = { ...b, remote: null }
  await assertUnchanged()
  if (b.worktree && existsSync(b.worktree)) {
    await ctx.mainGit.worktreeRemove(b.worktree, true)
    ctx.ui.step(`removed the folder ${b.worktree}`)
  }
  await ctx.mainGit.worktreePrune()
  if (b.local) await ctx.mainGit.deleteBranch(b.branch, b.local)
  if (b.remote) {
    if (await ctx.mainGit.deleteRemoteBranch(b.branch, b.remote)) ctx.ui.step(`deleted ${b.branch} on GitHub`)
    else if (await ctx.gh.branchSha(b.branch)) throw new ReleaseError(`${b.branch} on GitHub changed meanwhile; it stays`, { hint: 'look at it and cancel again' })
  }
  ctx.ui.info(`${b.branch} is cancelled. Its prereleases stay; release:cleanup deletes tags that never became a release.`)
}
