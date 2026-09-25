// @ts-check
import { readFileSync } from 'node:fs'
import { ReleaseError } from './util.mjs'

// Loaded at start: npx may replace the package folder while a command runs.
export const SCHEMA = JSON.parse(readFileSync(new URL('../schema/release.config.schema.json', import.meta.url), 'utf8'))

export const CONFIG_FILE = 'release.config.json'
export const SUPPORTED_SCHEMA_VERSIONS = [1]

/**
 * @typedef {object} RepoSettings settings read from origin/main
 * @property {string} repo
 * @property {string} package
 * @property {'npm' | 'none'} publish
 * @property {string} releaseWorkflow
 * @property {boolean} requireTestedPrerelease
 * @property {string[]} worktreeCopy
 * @property {string} npmEnvironment
 */

/**
 * @typedef {object} BuildSettings settings read from the built commit
 * @property {string} changelogDir
 * @property {string} changelogTemplate
 * @property {string | null} changelogIndex
 * @property {string | false | null} build null: the package manager's `run build`
 * @property {string | null} node
 * @property {boolean} installScripts
 * @property {Record<string, string>} ciEnv
 * @property {string[]} ciSetup
 * @property {string[]} ciChecks
 * @property {{ compare: string[], allow: string[] } | null} packVerify
 * @property {string[] | null} worktreeInstall
 */

/**
 * Validates a configuration object; unknown keys are ignored (newer versions of the tool may add keys).
 * @param {any} raw
 * @param {string} where
 */
export function validateConfig(raw, where) {
  const problems = []
  const isStr = (/** @type {any} */ v) => typeof v === 'string' && v.length > 0
  const isStrArray = (/** @type {any} */ v) => Array.isArray(v) && v.every((x) => typeof x === 'string')
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ReleaseError(`${where}: ${CONFIG_FILE} is not a JSON object`)
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(raw.version)) {
    problems.push(`version ${JSON.stringify(raw.version)} is not supported (supported: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')})`)
  }
  if (!isStr(raw.repo) || !/^[\w.-]+\/[\w.-]+$/.test(raw.repo)) problems.push('repo must be owner/name')
  if (raw.package !== undefined && !isStr(raw.package)) problems.push('package must be a string')
  if (raw.publish !== undefined && !['npm', 'none'].includes(raw.publish)) problems.push('publish must be "npm" or "none"')
  if (raw.releaseWorkflow !== undefined && !(isStr(raw.releaseWorkflow) && /^[\w.-]+\.ya?ml$/.test(raw.releaseWorkflow))) {
    problems.push('releaseWorkflow must be a file name in .github/workflows')
  }
  for (const k of ['changelogDir', 'changelogTemplate', 'node', 'npmEnvironment']) {
    if (raw[k] !== undefined && !isStr(raw[k])) problems.push(`${k} must be a string`)
  }
  if (raw.changelogIndex !== undefined && raw.changelogIndex !== null && !isStr(raw.changelogIndex)) problems.push('changelogIndex must be a string')
  if (raw.build !== undefined && raw.build !== false && !isStr(raw.build)) problems.push('build must be a command or false')
  for (const k of ['installScripts', 'requireTestedPrerelease']) {
    if (raw[k] !== undefined && typeof raw[k] !== 'boolean') problems.push(`${k} must be true or false`)
  }
  const ci = raw.ci
  if (!ci || typeof ci !== 'object') {
    problems.push('ci.checks is required')
  } else {
    if (!isStrArray(ci.checks) || ci.checks.length === 0) problems.push('ci.checks must be a non-empty list of commands')
    if (ci.setup !== undefined && !isStrArray(ci.setup)) problems.push('ci.setup must be a list of commands')
    if (ci.env !== undefined && (typeof ci.env !== 'object' || Array.isArray(ci.env) || !Object.values(ci.env).every((v) => typeof v === 'string'))) {
      problems.push('ci.env must map names to strings')
    }
  }
  const verify = raw.pack?.verify
  if (verify !== undefined) {
    if (!verify || typeof verify !== 'object') problems.push('pack.verify must be an object')
    else {
      if (verify.compare !== undefined && !isStrArray(verify.compare)) problems.push('pack.verify.compare must be a list')
      if (verify.allow !== undefined && !isStrArray(verify.allow)) problems.push('pack.verify.allow must be a list')
    }
  }
  const wt = raw.worktree
  if (wt !== undefined) {
    if (wt.copy !== undefined && !isStrArray(wt.copy)) problems.push('worktree.copy must be a list of paths')
    if (wt.install !== undefined && !isStr(wt.install) && !isStrArray(wt.install)) problems.push('worktree.install must be a command or a list')
  }
  if (problems.length) {
    throw new ReleaseError(`${where}: invalid ${CONFIG_FILE}:\n- ${problems.join('\n- ')}`)
  }
}

/**
 * @param {string} text
 * @param {string} where
 */
export function parseConfig(text, where) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new ReleaseError(`${where}: ${CONFIG_FILE} is not valid JSON: ${e.message}`)
  }
  validateConfig(raw, where)
  return raw
}

/**
 * @param {any} raw
 * @param {any} packageJson package.json of the same commit
 * @returns {RepoSettings}
 */
export function repoSettings(raw, packageJson) {
  const pkg = raw.package ?? packageJson?.name
  if (!pkg) throw new ReleaseError(`${CONFIG_FILE} has no package and package.json has no name`)
  return {
    repo: raw.repo,
    package: pkg,
    publish: raw.publish ?? 'npm',
    releaseWorkflow: raw.releaseWorkflow ?? 'release.yml',
    requireTestedPrerelease: raw.requireTestedPrerelease ?? false,
    worktreeCopy: raw.worktree?.copy ?? [],
    npmEnvironment: raw.npmEnvironment ?? 'npmjs-publish',
  }
}

/**
 * @param {any} raw
 * @returns {BuildSettings}
 */
export function buildSettings(raw) {
  const install = raw.worktree?.install
  return {
    changelogDir: (raw.changelogDir ?? 'doc/changelog').replace(/\/+$/, ''),
    changelogTemplate: raw.changelogTemplate ?? 'doc/changelog/template.md',
    changelogIndex: raw.changelogIndex ?? null,
    build: raw.build === undefined ? null : raw.build,
    node: raw.node ?? null,
    installScripts: raw.installScripts ?? false,
    ciEnv: raw.ci?.env ?? {},
    ciSetup: raw.ci?.setup ?? [],
    ciChecks: raw.ci?.checks ?? [],
    packVerify: raw.pack?.verify ? { compare: raw.pack.verify.compare ?? [], allow: raw.pack.verify.allow ?? [] } : null,
    worktreeInstall: install === undefined ? null : Array.isArray(install) ? install : [install],
  }
}
