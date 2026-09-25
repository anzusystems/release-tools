// @ts-check
import { classifyVersion } from '../tags.mjs'
import { Project } from '../project.mjs'
import { ReleaseError, isoDate, sleep, pollMs } from '../util.mjs'
import { releaseBranches } from './common.mjs'
import { ensureRelease } from './final.mjs'

const TWO_HOURS = 2 * 60 * 60 * 1000
const DAY = 24 * 60 * 60 * 1000

/**
 * @typedef {import('../context.mjs').Context} Context
 */

/**
 * @typedef {object} Item
 * @property {string} name tag name
 * @property {'dev' | 'prerelease' | 'stable' | 'runs' | 'restore'} kind restore: released, but its tag is gone
 * @property {Date} date
 * @property {string | null} refSha the tag object listed (null: no tag)
 * @property {number | null} releaseId the GitHub Release listed
 * @property {number[]} runIds runs: the finished runs of the tool listed
 */

/**
 * release:cleanup — dev builds, tags that never became a release, and finished runs of such tags.
 * @param {Context} ctx
 */
export async function cleanup(ctx) {
  const project = new Project(ctx)
  await project.recoverMoves()
  const now = await ctx.gh.serverTime()
  const found = await collect(ctx, project, now)
  // Repairs first: a released version never stays without its tag.
  for (const item of found.filter((i) => i.kind === 'restore')) {
    ctx.ui.step(`${item.name} is released but its tag is missing; restoring it`)
    // One repair that cannot be done (for example no provenance) does not stop the cleanup; release:publish offers it.
    try {
      await project.restoreReleasedTag(item.name, null)
    } catch (e) {
      if (!(e instanceof ReleaseError)) throw e
      ctx.ui.warn(`the tag of ${item.name} could not be restored: ${e.message}${e.hint ? ` (${e.hint})` : ''}`)
      continue
    }
    try {
      const restored = await ctx.gh.tag(item.name)
      if (restored) await ensureRelease(ctx, project, item.name, restored.commit)
    } catch (e) {
      if (!(e instanceof ReleaseError)) throw e
      ctx.ui.warn(`the tag of ${item.name} is restored, but its GitHub Release is not: ${e.message} (run release:publish to add it)`)
    }
  }
  const items = found.filter((i) => i.kind !== 'restore')
  if (!items.length) {
    ctx.ui.info('Nothing to clean up.')
    return []
  }
  const dev = items.filter((i) => i.kind === 'dev')
  const tags = items.filter((i) => i.kind === 'prerelease' || i.kind === 'stable')
  const runs = items.filter((i) => i.kind === 'runs')
  const oldest = items.reduce((a, b) => (a.date < b.date ? a : b))
  ctx.ui.info(
    `${dev.length} dev build(s), ${tags.length} tag(s) that never became a release${runs.length ? `, finished runs of ${runs.length} deleted tag(s)` : ''}; the oldest from ${isoDate(oldest.date)}`,
  )
  const how = await ctx.ui.select('What to delete?', [
    { label: 'delete all', value: 'all' },
    { label: 'delete those older than … days', value: 'days' },
  ])
  let selected = items
  if (how === 'days') {
    const days = Number(await ctx.ui.input('Older than how many days', { validate: (v) => (/^\d+$/.test(v) ? null : 'a number of days') }))
    selected = items.filter((i) => now.getTime() - i.date.getTime() > days * DAY)
  }
  if (!selected.length) {
    ctx.ui.info('Nothing is that old.')
    return []
  }
  ctx.ui.info(selected.map((i) => `  ${i.name}  (${i.kind === 'runs' ? 'finished runs' : i.kind}, ${isoDate(i.date)})`).join('\n'))
  if (!(await ctx.ui.confirm(`Delete these ${selected.length}?`, { default: false }))) return []
  const done = []
  for (const item of selected) {
    if (await remove(ctx, project, item)) done.push(item.name)
  }
  const left = (await collect(ctx, project, await ctx.gh.serverTime())).filter((i) => selected.some((s) => s.name === i.name && s.kind === i.kind))
  if (left.length) throw new ReleaseError(`${left.length} item(s) are still there: ${left.map((i) => i.name).join(', ')}`, { hint: 'run release:cleanup again' })
  ctx.ui.info(`Deleted ${done.length}.`)
  return done
}

/**
 * @param {Context} ctx
 * @param {Project} project
 * @param {Date} now
 * @returns {Promise<Item[]>}
 */
async function collect(ctx, project, now) {
  const released = await project.released()
  const releases = await project.releases()
  const branches = await releaseBranches(ctx)
  const refs = await project.tagRefs()
  const names = new Set(refs.map((r) => r.name))
  /** @type {Item[]} */
  const items = []
  for (const r of refs) {
    const info = classifyVersion(r.name)
    if (!info || (info.kind !== 'dev' && released.has(r.name))) continue
    const tt = await project.toolTag(r.name)
    if (!tt?.message) continue
    const tag = tt.tag
    if (!tag.taggerDate || now.getTime() - tag.taggerDate.getTime() < TWO_HOURS) continue
    const release = releases.find((x) => x.tagName === r.name) ?? null
    /** @type {Item['kind'] | null} */
    let kind = null
    if (info.kind === 'dev') kind = 'dev'
    else if (!released.has(r.name)) {
      if (info.kind === 'prerelease') kind = 'prerelease'
      else if (!branches.some((b) => b.version === r.name && (b.remote || b.local))) kind = 'stable'
    }
    if (!kind) continue
    const runs = await project.tagRuns(tag)
    if (runs.some((x) => x.state === 'active')) continue
    items.push({ name: r.name, kind, date: tag.taggerDate, refSha: tag.refSha, releaseId: release?.id ?? null, runIds: [] })
  }
  for (const rel of releases) {
    const info = classifyVersion(rel.tagName)
    if (!info || info.kind !== 'dev' || names.has(rel.tagName)) continue
    items.push({ name: rel.tagName, kind: 'dev', date: new Date(rel.createdAt), refSha: null, releaseId: rel.id, runIds: [] })
  }
  /** @type {Map<string, Item>} */
  const byName = new Map()
  for (const run of await ctx.gh.workflowRuns(ctx.settings.releaseWorkflow)) {
    if (run.status !== 'completed' || names.has(run.headBranch)) continue
    const info = classifyVersion(run.headBranch)
    if (!info || items.some((i) => i.name === run.headBranch)) continue
    // A released version whose tag is gone (an interrupted cleanup raced a release): its tag is restored.
    const kind = info.kind !== 'dev' && released.has(run.headBranch) ? 'restore' : 'runs'
    // The runs of an open release stay with it.
    if (kind === 'runs' && info.kind === 'stable' && branches.some((b) => b.version === run.headBranch && (b.remote || b.local))) continue
    if (!(await project.toolRun(run))) continue
    const item = byName.get(run.headBranch) ?? { name: run.headBranch, kind, date: run.createdAt, refSha: null, releaseId: null, runIds: [] }
    if (run.createdAt < item.date) item.date = run.createdAt
    item.runIds.push(run.id)
    byName.set(run.headBranch, item)
  }
  items.push(...byName.values())
  return items.sort((a, b) => a.date.getTime() - b.date.getTime())
}

/**
 * Checks the state, deletes the finished runs, the tag, checks again, and deletes the GitHub Release last. Only what
 * was listed goes: a tag, a GitHub Release or runs that changed since then keep the whole item.
 * @param {Context} ctx
 * @param {Project} project
 * @param {Item} item
 */
async function remove(ctx, project, item) {
  const check = item.kind !== 'dev' && classifyVersion(item.name)?.kind !== 'dev'
  if (check && (await project.isReleased(item.name))) {
    ctx.ui.info(`${item.name} is released now; skipped`)
    return false
  }
  const skip = (/** @type {string} */ why) => {
    ctx.ui.warn(`${item.name}: ${why} since it was listed; skipped`)
    return false
  }
  // The same tag object has the same date: it is still two hours old.
  const tag = await ctx.gh.tag(item.name)
  if ((tag?.refSha ?? null) !== item.refSha) return skip(tag ? 'its tag is another one' : 'its tag is gone')
  if (classifyVersion(item.name)?.kind === 'stable' && (await releaseBranches(ctx)).some((b) => b.version === item.name && (b.remote || b.local))) {
    return skip('its release branch appeared')
  }
  if (tag) {
    if ((await project.tagRuns(tag)).some((r) => r.state === 'active')) return skip('a run started')
  } else if ((await ctx.gh.tagRuns(ctx.settings.releaseWorkflow, item.name)).some((r) => r.status !== 'completed')) {
    return skip('a run started')
  }
  if (((await project.release(item.name))?.id ?? null) !== item.releaseId) return skip('its GitHub Release changed')
  if (item.kind === 'runs') {
    for (const id of item.runIds) await ctx.gh.deleteRun(id)
  } else {
    await project.deleteFinishedRuns(item.name)
  }
  if (tag) {
    // Checked again right before the deletion: a run started meanwhile (a re-run) keeps the tag.
    if ((await project.tagRuns(tag)).some((r) => r.state === 'active')) return skip('a run started')
    const deleted = await ctx.git.push([`:refs/tags/${item.name}`], { leases: [`refs/tags/${item.name}:${item.refSha}`], description: `delete the tag ${item.name}`, allowFail: true })
    if (!deleted && (await ctx.gh.tag(item.name))) return skip('its tag changed')
    ctx.checkpoint('cleanup-tag')
    for (;;) {
      const runs = await ctx.gh.tagRuns(ctx.settings.releaseWorkflow, item.name)
      if (!runs.some((r) => r.status !== 'completed')) break
      ctx.ui.status(`waiting for a run of ${item.name} to finish`)
      await sleep(pollMs(5000))
    }
  }
  // The state again before the runs that finished meanwhile go: while the tag is gone, they are the only trace a
  // version released meanwhile leaves (cleanup and publish find it by them).
  if (check && (await project.isReleased(item.name))) {
    ctx.ui.warn(`${item.name} was released meanwhile; its tag is restored`)
    try {
      const { commit } = await project.releasedCommit(item.name)
      if (tag && (!commit || commit === tag.commit)) await project.pushTagObject(item.name, tag.refSha)
      if (!(await ctx.gh.tag(item.name))) await project.restoreReleasedTag(item.name, null)
      const restored = await ctx.gh.tag(item.name)
      // The GitHub Release (a draft once the tag was gone) is finished like any released version: Latest included.
      if (restored) await ensureRelease(ctx, project, item.name, restored.commit)
    } catch (e) {
      if (!(e instanceof ReleaseError)) throw e
      ctx.ui.warn(`${item.name} is not finished: ${e.message}${e.hint ? ` (${e.hint})` : ''}`)
    }
    return false
  }
  // Runs of a tag created again meanwhile stay with it.
  if (tag && !(await ctx.gh.tag(item.name))) await project.deleteFinishedRuns(item.name)
  const rel = await project.release(item.name)
  if (rel && rel.id === item.releaseId) await ctx.gh.deleteRelease(rel.id)
  else if (rel) ctx.ui.warn(`a new GitHub Release ${item.name} appeared meanwhile; it stays`)
  ctx.ui.step(`deleted ${item.name}`)
  return true
}
