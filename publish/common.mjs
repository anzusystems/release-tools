// @ts-check
import { appendFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { parseConfig, repoSettings, CONFIG_FILE } from '../lib/config.mjs'
import { ReleaseError } from '../lib/util.mjs'
import { classifyVersion, toolTag } from '../lib/tags.mjs'
import * as semver from '../lib/semver.mjs'

/** Version of the artifact format between the build and the publish job. */
export const ARTIFACT_SCHEMA = 1
export const SUPPORTED_ARTIFACT_SCHEMAS = [1]
export const ARTIFACT_NAME = 'release-tools'

/** A result the action reports to the CLI as an annotation titled `release-tools`. */
export class ActionResult extends Error {
  /**
   * @param {string} code nothing | unverified (failed before the tag was known to be the tool's) | invalid-tag |
   *   invalid-run | checks-failed | build-failed | package-mismatch |
   *   publish-failed | integrity-mismatch (another content on npm) | commit-mismatch (npm provenance names another
   *   commit) | release-deferred
   * @param {string} message
   * @param {{ fail?: boolean }} [options] fail: the job fails (default true, except for nothing)
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'ActionResult'
    this.code = code
    this.fail = options.fail ?? code !== 'nothing'
  }
}

/**
 * @typedef {object} ActionEnv
 * @property {string} repo
 * @property {string} sha
 * @property {string} tagName
 * @property {string} runId
 * @property {string} runAttempt
 * @property {string} workspace
 * @property {string} temp
 * @property {import('../lib/github.mjs').GitHub} gh
 * @property {(settings: import('../lib/config.mjs').RepoSettings) => import('../lib/registry.mjs').Registry | null} registry
 * @property {(name: string, value: string) => void} output
 * @property {(markdown: string) => void} summary
 * @property {(level: 'notice' | 'warning' | 'error', code: string, message: string) => void} annotate
 * @property {(message: string) => void} log
 * @property {NodeJS.ProcessEnv} env environment for commands of the project
 * @property {(o: { file: string, tag: string, cwd: string }) => Promise<{ ok: boolean, exists: boolean, output: string }>} [npmPublish]
 */

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 */
export function required(env, name) {
  const v = env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

/**
 * Writes step outputs in the GITHUB_OUTPUT format.
 * @param {string} file
 */
export function outputWriter(file) {
  return (/** @type {string} */ name, /** @type {string} */ value) => {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`invalid output name ${name}`)
    const delimiter = `ghadelimiter_${randomBytes(8).toString('hex')}`
    appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`)
  }
}

/**
 * @param {string} s
 */
export function escapeData(s) {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

/**
 * @param {string} s
 */
export function escapeProperty(s) {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C')
}

/**
 * The tag that triggered the run, checked against the run's commit.
 * @param {ActionEnv} a
 */
export async function currentTag(a) {
  const tag = await a.gh.tag(a.tagName)
  if (!tag) throw new ActionResult('invalid-run', `the tag ${a.tagName} no longer exists on GitHub (moved or deleted)`)
  if (tag.commit !== a.sha) {
    throw new ActionResult('invalid-run', `the tag ${a.tagName} now points to ${tag.commit.slice(0, 12)}, not to the commit of this run (${a.sha.slice(0, 12)})`)
  }
  return tag
}

/**
 * Repository settings from main through the API (the publish job has no checkout).
 * @param {import('../lib/github.mjs').GitHub} gh
 */
export async function settingsFromMain(gh) {
  const text = await gh.file(CONFIG_FILE, 'main')
  if (text === null) throw new ActionResult('invalid-tag', `${CONFIG_FILE} is not in main`)
  const raw = parseConfig(text, 'main')
  const pkg = await gh.file('package.json', 'main')
  return { raw, settings: repoSettings(raw, pkg ? JSON.parse(pkg) : null) }
}

/**
 * The tool tag of the run: format and message.
 * @param {import('../lib/github.mjs').TagInfo} tag
 */
export function classifyRunTag(tag) {
  if (!classifyVersion(tag.name)) throw new ActionResult('nothing', `${tag.name} is not a version in the tool's format`)
  const t = toolTag(tag)
  if (!t) throw new ActionResult('nothing', `${tag.name} is not a tag of release-tools (annotated, with "release-tools: …" in its message)`)
  return t
}

/**
 * Released versions and helpers the action needs, fresh.
 * @param {import('../lib/config.mjs').RepoSettings} settings
 * @param {import('../lib/github.mjs').GitHub} gh
 * @param {import('../lib/registry.mjs').Registry | null} registry
 */
export async function releaseState(settings, gh, registry) {
  const npm = settings.publish === 'npm'
  const releases = await gh.releases()
  /** @type {Set<string>} */
  const released = new Set()
  if (npm) {
    const reg = /** @type {import('../lib/registry.mjs').Registry} */ (registry)
    for (const v of await reg.versions(settings.package)) {
      const info = classifyVersion(v)
      if (info ? info.kind !== 'dev' : semver.valid(v)) released.add(v)
    }
    for (const t of await gh.tagRefs()) {
      const info = classifyVersion(t.name)
      if (!info || info.kind === 'dev' || released.has(t.name)) continue
      if (await reg.version(settings.package, t.name)) released.add(t.name)
    }
  } else {
    for (const r of releases) {
      const info = classifyVersion(r.tagName)
      if (info && info.kind !== 'dev') released.add(r.tagName)
    }
  }
  /** @param {string} version */
  const isReleased = async (version) => {
    if (npm) return !!(await /** @type {any} */ (registry).version(settings.package, version))
    return (await gh.releases()).some((r) => r.tagName === version)
  }
  return { released, releases, isReleased }
}

/**
 * @param {unknown} e
 */
export function asMessage(e) {
  return e instanceof Error ? e.message : String(e)
}

export { ReleaseError }
