// @ts-check
import * as semver from './semver.mjs'

export const PRERELEASE_IDS = /** @type {const} */ (['alpha', 'beta', 'rc'])
export const TAG_KINDS = /** @type {const} */ (['final', 'hotfix', 'prerelease', 'dev'])

const NUM = '(?:0|[1-9]\\d*)'
const STABLE = `${NUM}\\.${NUM}\\.${NUM}`
const PRE = `(${STABLE})-(alpha|beta|rc)\\.(${NUM})`
const LABEL = '(\\d{14}|[a-zA-Z][a-zA-Z0-9-]*)'
const STABLE_RE = new RegExp(`^${STABLE}$`)
const PRE_RE = new RegExp(`^${PRE}$`)
const DEV_RE = new RegExp(`^(${STABLE})-dev\\.${LABEL}$`)
const DEV_PRE_RE = new RegExp(`^${PRE}\\.dev\\.${LABEL}$`)
export const DEV_NAME_RE = /^[a-zA-Z][a-zA-Z0-9-]*$/

/**
 * @typedef {{ kind: 'stable', version: string, core: string }
 *   | { kind: 'prerelease', version: string, core: string, id: 'alpha' | 'beta' | 'rc', n: number }
 *   | { kind: 'dev', version: string, core: string, base: string, label: string }} VersionInfo
 */

/**
 * Classifies a version (or tag name) in the tool's formats: `X.Y.Z`, `X.Y.Z-(alpha|beta|rc).N`,
 * `<X.Y.Z>-dev.<time|name>` and `<X.Y.Z-id.N>.dev.<time|name>`.
 * @param {string} v
 * @returns {VersionInfo | null}
 */
export function classifyVersion(v) {
  if (typeof v !== 'string' || !semver.valid(v)) return null
  if (STABLE_RE.test(v)) return { kind: 'stable', version: v, core: v }
  let m = PRE_RE.exec(v)
  if (m) return { kind: 'prerelease', version: v, core: m[1], id: /** @type {any} */ (m[2]), n: Number(m[3]) }
  m = DEV_RE.exec(v)
  if (m) return { kind: 'dev', version: v, core: m[1], base: m[1], label: m[2] }
  m = DEV_PRE_RE.exec(v)
  if (m) return { kind: 'dev', version: v, core: m[1], base: `${m[1]}-${m[2]}.${m[3]}`, label: m[4] }
  return null
}

/**
 * The tag kinds a version allows.
 * @param {VersionInfo} info
 * @returns {readonly string[]}
 */
export function kindsFor(info) {
  if (info.kind === 'stable') return ['final', 'hotfix']
  if (info.kind === 'prerelease') return ['prerelease']
  return ['dev']
}

/**
 * @typedef {object} TagMessage
 * @property {'final' | 'hotfix' | 'prerelease' | 'dev'} kind
 * @property {number} [pr]
 * @property {string} [candidate]
 * @property {string} [confirmedBy]
 * @property {string} [id]
 * @property {Record<string, string>} fields all key/value pairs, unknown keys included
 */

/**
 * Formats a tag message. Readers accept `key: value` pairs separated by newlines or `; `.
 * @param {{ kind: string, pr?: number, candidate?: string, confirmedBy?: string, id: string }} m
 */
export function formatTagMessage(m) {
  const lines = [`release-tools: ${m.kind}`]
  if (m.pr) lines.push(`pr: ${m.pr}`)
  if (m.candidate) lines.push(`candidate: ${m.candidate}`)
  if (m.confirmedBy) lines.push(`confirmed-by: ${m.confirmedBy}`)
  lines.push(`id: ${m.id}`)
  return `${lines.join('\n')}\n`
}

/**
 * Parses a tag message of the tool; null for any other message. Unknown keys and lines are ignored.
 * @param {string} message
 * @returns {TagMessage | null}
 */
export function parseTagMessage(message) {
  if (typeof message !== 'string') return null
  /** @type {Record<string, string>} */
  const fields = {}
  let first = true
  let kind = null
  for (const rawLine of message.split('\n')) {
    const lineText = rawLine.trim()
    if (lineText.startsWith('-----BEGIN PGP SIGNATURE-----') || lineText.startsWith('-----BEGIN SSH SIGNATURE-----')) break
    if (!lineText) continue
    for (const part of lineText.split(/;\s*/)) {
      const m = /^([a-z][a-z0-9-]*):\s*(.*?)\s*$/.exec(part)
      if (first) {
        if (!m || m[1] !== 'release-tools') return null
        kind = m[2]
        first = false
        continue
      }
      if (m && !(m[1] in fields)) fields[m[1]] = m[2]
    }
  }
  if (!kind || !TAG_KINDS.includes(/** @type {any} */ (kind))) return null
  /** @type {TagMessage} */
  const result = { kind: /** @type {any} */ (kind), fields }
  if (fields.pr !== undefined) {
    if (!/^[1-9]\d*$/.test(fields.pr)) return null
    result.pr = Number(fields.pr)
  }
  if (fields.candidate !== undefined) {
    const c = classifyVersion(fields.candidate)
    if (!c || c.kind !== 'prerelease') return null
    result.candidate = fields.candidate
  }
  if (fields['confirmed-by'] !== undefined) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/.test(fields['confirmed-by'])) return null
    result.confirmedBy = fields['confirmed-by']
  }
  if (fields.id !== undefined) result.id = fields.id
  return result
}

/**
 * Content for `git mktag`. The tagger date is written directly; `git mktag` does not read GIT_COMMITTER_DATE.
 * @param {{ commit: string, name: string, tagger: { name: string, email: string }, epochSeconds: number, message: string }} t
 */
export function mktagContent(t) {
  const clean = (/** @type {string} */ s) => s.replace(/[<>\n]/g, '').trim()
  return (
    `object ${t.commit}\n` +
    `type commit\n` +
    `tag ${t.name}\n` +
    `tagger ${clean(t.tagger.name) || 'release-tools'} <${clean(t.tagger.email)}> ${Math.floor(t.epochSeconds)} +0000\n` +
    `\n` +
    t.message
  )
}

/**
 * A tag of the tool: its name is in a tool format, it is annotated, and its message says `release-tools: <kind>`
 * with a kind that fits the version.
 * @param {{ name: string, annotated: boolean, message?: string }} tag
 * @returns {{ info: VersionInfo, message: TagMessage } | null}
 */
export function toolTag(tag) {
  const info = classifyVersion(tag.name)
  if (!info || !tag.annotated || tag.message === undefined) return null
  const message = parseTagMessage(tag.message)
  if (!message || !kindsFor(info).includes(message.kind)) return null
  return { info, message }
}

const SKIP_MARKERS = ['[skip ci]', '[ci skip]', '[no ci]', '[skip actions]', '[actions skip]']

/**
 * A commit message that would make GitHub skip the workflow run.
 * @param {string} message
 */
export function skipsCi(message) {
  const lower = message.toLowerCase()
  if (SKIP_MARKERS.some((m) => lower.includes(m))) return true
  return /^skip-checks:\s*true\s*$/im.test(message)
}
