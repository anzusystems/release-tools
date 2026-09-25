// @ts-check
import * as semver from './semver.mjs'
import { classifyVersion, toolTag, formatTagMessage, mktagContent, parseTagMessage } from './tags.mjs'
import { lastStable } from './versions.mjs'
import { parseFooter } from './release-body.mjs'
import { MOVING_NS, TAGS_NS } from './git.mjs'
import { ReleaseError, sleep, pollMs, randomHex } from './util.mjs'

const ACTIVE = ['queued', 'in_progress', 'waiting', 'pending', 'requested']
export const MAIN = 'refs/remotes/origin/main'

/**
 * @typedef {import('./github.mjs').TagInfo} TagInfo
 * @typedef {import('./github.mjs').RunInfo} RunInfo
 * @typedef {import('./github.mjs').ReleaseInfo} ReleaseInfo
 */

/**
 * @typedef {object} RunOutcome
 * @property {RunInfo} run
 * @property {'active' | 'success' | 'failure' | 'cancelled' | 'ref-deletion'} state
 * @property {string | null} code result code the action reported (released, invalid-tag, checks-failed, …)
 * @property {string | null} message
 * @property {'build' | 'publish' | null} failedJob
 */

/**
 * State of a project read from GitHub and the registry. Nothing here is cached across calls unless stated.
 */
export class Project {
  /** @param {import('./context.mjs').Context} ctx */
  constructor(ctx) {
    this.ctx = ctx
  }

  get gh() {
    return this.ctx.gh
  }

  get git() {
    return this.ctx.git
  }

  get settings() {
    return this.ctx.settings
  }

  get npm() {
    return this.settings.publish === 'npm'
  }

  // --- tags ------------------------------------------------------------------------

  /** @returns {Promise<{ name: string, sha: string, type: string }[]>} */
  async tagRefs() {
    return this.gh.tagRefs()
  }

  /**
   * A tag of the tool on GitHub, with its parsed message.
   * @param {string} name
   */
  async toolTag(name) {
    const tag = await this.gh.tag(name)
    if (!tag) return null
    const t = toolTag(tag)
    return t ? { tag, ...t } : { tag, info: null, message: null }
  }

  // --- releases and released versions ---------------------------------------------

  /** @returns {Promise<ReleaseInfo[]>} */
  async releases() {
    return this.gh.releases()
  }

  /**
   * Released versions (stable and prereleases; never dev builds): npm versions (packument plus tags that the
   * per-version endpoint confirms), or GitHub Releases, drafts included, for publish: "none".
   * @returns {Promise<Set<string>>}
   */
  async released() {
    if (!this.npm) {
      const set = new Set()
      for (const r of await this.releases()) {
        const info = classifyVersion(r.tagName)
        if (info && info.kind !== 'dev') set.add(r.tagName)
      }
      return set
    }
    const registry = /** @type {import('./registry.mjs').Registry} */ (this.ctx.registry)
    const set = new Set((await registry.versions(this.settings.package)).filter((v) => {
      const info = classifyVersion(v)
      return info ? info.kind !== 'dev' : semver.valid(v)
    }))
    for (const t of await this.tagRefs()) {
      const info = classifyVersion(t.name)
      if (!info || info.kind === 'dev' || set.has(t.name)) continue
      if (await registry.version(this.settings.package, t.name)) set.add(t.name)
    }
    return set
  }

  /**
   * Fresh check of one version.
   * @param {string} version
   */
  async isReleased(version) {
    if (this.npm) return !!(await /** @type {any} */ (this.ctx.registry).version(this.settings.package, version))
    return (await this.releases()).some((r) => r.tagName === version)
  }

  /**
   * The GitHub Release of a version, drafts included.
   * @param {string} version
   */
  async release(version) {
    return (await this.releases()).find((r) => r.tagName === version) ?? null
  }

  /**
   * The commit a released version was built from: npm provenance, or the footer of the GitHub Release.
   * @param {string} version
   * @param {{ waitMs?: number }} [options]
   * @returns {Promise<{ commit: string | null, source: 'provenance' | 'release' | 'none' }>}
   */
  async releasedCommit(version, options = {}) {
    if (this.npm) {
      const c = await /** @type {any} */ (this.ctx.registry).provenanceCommit(this.settings.package, version, { waitMs: options.waitMs ?? 90000 })
      if (c) return { commit: c, source: 'provenance' }
      return { commit: null, source: 'none' }
    }
    const rel = await this.release(version)
    const footer = parseFooter(rel?.body)
    return footer?.commit ? { commit: footer.commit, source: 'release' } : { commit: null, source: 'none' }
  }

  /**
   * Bootstrap lasts while the last released stable version has no tag of the tool (final or hotfix).
   * @param {Set<string>} [released]
   */
  async bootstrap(released) {
    const last = lastStable(released ?? (await this.released()))
    if (!last) return true
    const t = await this.toolTag(last)
    return !(t?.message && (t.message.kind === 'final' || t.message.kind === 'hotfix'))
  }

  // --- workflow runs -----------------------------------------------------------------

  /**
   * Runs of the release workflow that belong to this very tag: push event, head_branch = tag name, head_sha =
   * the tag's commit, created at or after the tag date. Runs of a ref deletion (skipped build job) do not count.
   * Only the waiting or running runs and the newest finished one are returned: nothing older decides anything.
   * @param {TagInfo} tag
   * @returns {Promise<RunOutcome[]>} newest first
   */
  async tagRuns(tag) {
    const since = tag.taggerDate ? Math.floor(tag.taggerDate.getTime() / 1000) * 1000 : 0
    const runs = (await this.gh.tagRuns(this.settings.releaseWorkflow, tag.name))
      .filter((r) => r.event === 'push' && r.headSha === tag.commit && r.createdAt.getTime() >= since)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id)
    /** @type {RunOutcome[]} */
    const out = []
    let finished = false
    for (const r of runs) {
      if (ACTIVE.includes(r.status)) {
        out.push({ run: r, state: 'active', code: null, message: null, failedJob: null })
        continue
      }
      if (finished) continue
      const o = await this.outcome(r)
      if (o.state === 'ref-deletion') continue
      out.push(o)
      finished = true
    }
    return out
  }

  /**
   * @param {RunInfo} run
   * @returns {Promise<RunOutcome>}
   */
  async outcome(run) {
    if (ACTIVE.includes(run.status)) return { run, state: 'active', code: null, message: null, failedJob: null }
    const jobs = await this.gh.jobs(run.id)
    // A run cancelled in the queue (a full queue, a tag move) never got jobs.
    if (run.conclusion === 'cancelled' && !jobs.some((j) => j.name === 'build' && j.conclusion === 'skipped')) {
      return { run, state: 'cancelled', code: null, message: null, failedJob: null }
    }
    const build = jobs.find((j) => j.name === 'build')
    const publish = jobs.find((j) => j.name === 'publish')
    if (!build || build.conclusion === 'skipped') return { run, state: 'ref-deletion', code: null, message: null, failedJob: null }
    let code = null
    let message = null
    for (const j of [publish, build]) {
      if (!j) continue
      for (const a of await this.gh.annotations(j.id)) {
        if (a.title !== 'release-tools') continue
        const m = /^([a-z-]+)(?::\s*([\s\S]*))?$/.exec(a.message.trim())
        if (m) {
          code = m[1]
          message = m[2] ?? null
          break
        }
      }
      if (code) break
    }
    if (run.conclusion === 'cancelled') return { run, state: 'cancelled', code, message, failedJob: null }
    if (run.conclusion === 'success') return { run, state: 'success', code, message, failedJob: null }
    const failedJob = build.conclusion !== 'success' ? 'build' : publish && publish.conclusion !== 'success' ? 'publish' : null
    return { run, state: 'failure', code, message, failedJob }
  }

  /**
   * Waits until the tag has a run and it is finished; null when no run started within `startMs`.
   * @param {TagInfo} tag
   * @param {{ startMs?: number, quiet?: boolean }} [options]
   * @returns {Promise<RunOutcome | null>}
   */
  async waitForRun(tag, options = {}) {
    const startMs = options.startMs ?? 10 * 60 * 1000
    const started = (await this.gh.serverTime()).getTime()
    let shown = null
    for (;;) {
      const runs = await this.tagRuns(tag)
      const latest = runs[0] ?? null
      if (latest && latest.state !== 'active') return latest
      if (!latest && (await this.gh.serverTime()).getTime() - started > startMs) return null
      const text = latest ? `waiting for the release run of ${tag.name}: ${latest.run.url}` : `waiting for the release run of ${tag.name} to start`
      if (text !== shown && !options.quiet) this.ctx.ui.status(text)
      shown = text
      await sleep(pollMs(10000))
    }
  }

  /**
   * Cancels the waiting runs of a tag name and waits until the running ones finish.
   * @param {string} name
   */
  async stopRuns(name) {
    for (;;) {
      const runs = await this.gh.tagRuns(this.settings.releaseWorkflow, name)
      const waiting = runs.filter((r) => ['queued', 'waiting', 'pending', 'requested'].includes(r.status))
      for (const r of waiting) await this.gh.cancelRun(r.id)
      const running = runs.filter((r) => ACTIVE.includes(r.status))
      if (!running.length) return
      this.ctx.ui.status(`waiting for ${running.length} run(s) of ${name} to finish`)
      await sleep(pollMs(5000))
    }
  }

  /**
   * Deletes the finished runs of a tag name, so nobody can re-run them.
   * @param {string} name
   */
  async deleteFinishedRuns(name) {
    const runs = await this.gh.tagRuns(this.settings.releaseWorkflow, name)
    let deleted = 0
    for (const r of runs) {
      if (r.status === 'completed') {
        await this.gh.deleteRun(r.id)
        deleted++
      }
    }
    return deleted
  }

  /**
   * Stable tags with a waiting or running run (other than runs of a ref deletion).
   * @param {(name: string) => boolean} filter
   */
  async activeStableRuns(filter) {
    const out = []
    for (const t of await this.tagRefs()) {
      const info = classifyVersion(t.name)
      if (!info || info.kind !== 'stable' || !filter(t.name)) continue
      const tag = await this.gh.tag(t.name)
      if (!tag) continue
      const runs = await this.tagRuns(tag)
      if (runs.some((r) => r.state === 'active')) out.push(t.name)
    }
    return out
  }

  // --- creating and moving tags --------------------------------------------------------

  /**
   * Creates an annotated tag with `git mktag` (no local refs/tags) and pushes only it.
   * The tagger date is GitHub's server time; a random id makes every tag a new object.
   * @param {{ name: string, commit: string, kind: 'final' | 'hotfix' | 'prerelease' | 'dev', pr?: number, candidate?: string, confirmedBy?: string }} t
   * @returns {Promise<TagInfo>}
   */
  async createTag(t) {
    const now = await this.gh.serverTime()
    const message = formatTagMessage({ kind: t.kind, pr: t.pr, candidate: t.candidate, confirmedBy: t.confirmedBy, id: randomHex(8) })
    const content = mktagContent({ commit: t.commit, name: t.name, tagger: this.ctx.identity, epochSeconds: now.getTime() / 1000, message })
    this.git.mutate(`push the tag ${t.name} on ${t.commit.slice(0, 12)} (${t.kind})`)
    const sha = await this.git.mktag(content)
    const pushed = await this.git.push([`${sha}:refs/tags/${t.name}`], { allowFail: true, description: `push the tag ${t.name}` })
    if (!pushed) {
      throw new ReleaseError(`the tag ${t.name} could not be pushed; someone may have created it meanwhile`, { hint: 'run the command again' })
    }
    this.ctx.checkpoint('push-tag')
    this.ctx.ui.step(`tagged ${t.commit.slice(0, 12)} as ${t.name}`)
    return { name: t.name, refSha: sha, annotated: true, commit: t.commit, message, taggerDate: now }
  }

  /**
   * Pushes an existing tag object again (restore).
   * @param {string} name
   * @param {string} sha
   */
  async pushTagObject(name, sha) {
    return this.git.push([`${sha}:refs/tags/${name}`], { allowFail: true, description: `restore the tag ${name}` })
  }

  /**
   * First phase of a two-phase tag move (also used by cancel and "withdraw"): the tag object is saved in
   * refs/release-tools/moving/<tag>, then the tag is deleted on GitHub, waiting runs are cancelled and running ones
   * awaited, and the release state is checked again. When the version was released meanwhile, the tag is restored.
   * @param {TagInfo} tag
   * @returns {Promise<'withdrawn' | 'released'>}
   */
  async withdrawTag(tag) {
    const saved = `${MOVING_NS}${tag.name}`
    if (!(await this.git.hasObject(tag.refSha))) await this.git.fetch({ pruneTags: false })
    await this.git.updateRef(saved, tag.refSha)
    this.ctx.checkpoint('save-tag')
    const deleted = await this.git.push([`:refs/tags/${tag.name}`], {
      allowFail: true,
      leases: [`refs/tags/${tag.name}:${tag.refSha}`],
      description: `delete the tag ${tag.name} on GitHub`,
    })
    if (!deleted) {
      const now = await this.gh.tag(tag.name)
      if (now && now.refSha !== tag.refSha) {
        await this.git.deleteRef(saved)
        throw new ReleaseError(`the tag ${tag.name} changed on GitHub meanwhile`, { hint: 'run the command again' })
      }
      if (now) throw new ReleaseError(`the tag ${tag.name} could not be deleted on GitHub`)
    }
    this.ctx.checkpoint('delete-tag')
    await this.stopRuns(tag.name)
    if (await this.isReleased(tag.name)) {
      await this.restoreReleasedTag(tag.name, saved)
      await this.git.deleteRef(saved)
      return 'released'
    }
    return 'withdrawn'
  }

  /**
   * Drops the saved tag of a finished move.
   * @param {string} name
   */
  async dropSaved(name) {
    const saved = `${MOVING_NS}${name}`
    if (await this.git.objectOf(saved)) await this.git.deleteRef(saved)
  }

  /**
   * Restores the missing tag of a released version on the commit it was released from: the saved object if it
   * points there, otherwise a new tag on that commit.
   * @param {string} name
   * @param {string | null} savedRef
   */
  async restoreReleasedTag(name, savedRef) {
    const { commit } = await this.releasedCommit(name)
    const savedSha = savedRef ? await this.git.objectOf(savedRef) : null
    const savedCommit = savedRef ? await this.git.commitOf(savedRef) : null
    const target = commit ?? savedCommit
    if (!target) throw new ReleaseError(`${name} is released, its tag is missing and the released commit is unknown`, { hint: 'restore the tag by hand' })
    if (commit === null) {
      const ok = await this.ctx.ui.confirm(`${name} has no provenance. Restore its tag on ${savedCommit?.slice(0, 12)}, the commit of the saved tag?`)
      if (!ok) throw new ReleaseError(`the tag of ${name} was not restored`)
    }
    if (savedSha && savedCommit === target) {
      if (await this.pushTagObject(name, savedSha)) {
        this.ctx.ui.step(`restored the tag ${name}`)
        return
      }
    }
    let kind = 'prerelease'
    const info = classifyVersion(name)
    if (savedRef) {
      const msg = await this.git.out(['cat-file', '-p', savedSha ?? savedRef]).catch(() => '')
      const parsed = parseTagMessage(msg.split('\n\n').slice(1).join('\n\n'))
      if (parsed) kind = parsed.kind
    } else if (info?.kind === 'stable') {
      kind = 'final'
    }
    if (info?.kind === 'stable' && kind === 'prerelease') kind = 'final'
    await this.createTag({ name, commit: target, kind: /** @type {any} */ (kind) })
  }

  /**
   * Finishes interrupted tag moves and cancels (refs/release-tools/moving/*). Never creates a tag for a version
   * that is not released: GitHub and the registry decide, the saved tag is only a backup.
   */
  async recoverMoves() {
    for (const r of await this.git.refs(MOVING_NS)) {
      const name = r.ref.slice(MOVING_NS.length)
      this.ctx.ui.step(`finishing an interrupted move of the tag ${name}`)
      await this.stopRuns(name)
      const current = await this.gh.tag(name)
      if (!current && (await this.isReleased(name))) await this.restoreReleasedTag(name, r.ref)
      await this.git.deleteRef(r.ref)
    }
  }

  // --- branches and commits -----------------------------------------------------------

  /**
   * Whether the commit contains the tool's release workflow.
   * @param {string} commit
   */
  async hasStub(commit) {
    const text = await this.git.show(commit, `.github/workflows/${this.settings.releaseWorkflow}`)
    return !!text && /uses:\s*anzusystems\/release-tools\/publish@/.test(text)
  }

  /**
   * Tag names on GitHub mapped by name, fetched into refs/release-tools/tags.
   */
  async localToolTagCommit(name) {
    return this.git.commitOf(`${TAGS_NS}${name}`)
  }
}
