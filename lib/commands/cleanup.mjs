// @ts-check
import { classifyVersion, toolTag } from '../tags.mjs'
import { Project } from '../project.mjs'
import { ReleaseError, isoDate, sleep, pollMs } from '../util.mjs'
import { releaseBranches } from './common.mjs'

const TWO_HOURS = 2 * 60 * 60 * 1000
const DAY = 24 * 60 * 60 * 1000

/**
 * @typedef {import('../context.mjs').Context} Context
 */

/**
 * @typedef {object} Item
 * @property {string} name tag name
 * @property {'dev' | 'prerelease' | 'stable' | 'runs'} kind
 * @property {Date} date
 * @property {boolean} hasTag
 * @property {number | null} releaseId
 */

/**
 * release:cleanup — dev builds, tags that never became a release, and finished runs of such tags.
 * @param {Context} ctx
 */
export async function cleanup(ctx) {
  const project = new Project(ctx)
  await project.recoverMoves()
  const now = await ctx.gh.serverTime()
  const items = await collect(ctx, project, now)
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
    items.push({ name: r.name, kind, date: tag.taggerDate, hasTag: true, releaseId: release?.id ?? null })
  }
  for (const rel of releases) {
    const info = classifyVersion(rel.tagName)
    if (!info || info.kind !== 'dev' || names.has(rel.tagName)) continue
    items.push({ name: rel.tagName, kind: 'dev', date: new Date(rel.createdAt), hasTag: false, releaseId: rel.id })
  }
  const byName = new Map()
  for (const run of await ctx.gh.workflowRuns(ctx.settings.releaseWorkflow)) {
    if (run.status !== 'completed' || names.has(run.headBranch)) continue
    const info = classifyVersion(run.headBranch)
    if (!info || items.some((i) => i.name === run.headBranch)) continue
    if (info.kind !== 'dev' && released.has(run.headBranch)) continue
    if (!byName.has(run.headBranch) || byName.get(run.headBranch) > run.createdAt) byName.set(run.headBranch, run.createdAt)
  }
  for (const [name, date] of byName) items.push({ name, kind: 'runs', date, hasTag: false, releaseId: null })
  return items.sort((a, b) => a.date.getTime() - b.date.getTime())
}

/**
 * Checks the state, deletes the finished runs, the tag, checks again, and deletes the GitHub Release last.
 * @param {Context} ctx
 * @param {Project} project
 * @param {Item} item
 */
async function remove(ctx, project, item) {
  const check = item.kind === 'prerelease' || item.kind === 'stable' || item.kind === 'runs'
  if (check && classifyVersion(item.name)?.kind !== 'dev' && (await project.isReleased(item.name))) {
    ctx.ui.info(`${item.name} is released now; skipped`)
    return false
  }
  await project.deleteFinishedRuns(item.name)
  const tag = await ctx.gh.tag(item.name)
  if (tag && toolTag(tag)) {
    await ctx.git.push([`:refs/tags/${item.name}`], { leases: [`refs/tags/${item.name}:${tag.refSha}`], description: `delete the tag ${item.name}`, allowFail: true })
    ctx.checkpoint('cleanup-tag')
  }
  for (;;) {
    const runs = await ctx.gh.tagRuns(ctx.settings.releaseWorkflow, item.name)
    if (!runs.some((r) => r.status !== 'completed')) break
    ctx.ui.status(`waiting for a run of ${item.name} to finish`)
    await sleep(pollMs(5000))
  }
  await project.deleteFinishedRuns(item.name)
  if (check && classifyVersion(item.name)?.kind !== 'dev' && (await project.isReleased(item.name))) {
    ctx.ui.warn(`${item.name} was released meanwhile; its tag is restored`)
    if (tag) await project.pushTagObject(item.name, tag.refSha)
    else await project.restoreReleasedTag(item.name, null)
    const rel = await project.release(item.name)
    const restored = await ctx.gh.tag(item.name)
    if (rel?.draft && restored) {
      await ctx.gh.publishDraft(rel.id, { tag: item.name, prerelease: classifyVersion(item.name)?.kind !== 'stable', latest: false, commit: restored.commit })
    }
    return false
  }
  const rel = (await project.releases()).find((r) => r.tagName === item.name)
  if (rel) await ctx.gh.deleteRelease(rel.id)
  ctx.ui.step(`deleted ${item.name}`)
  return true
}
