// @ts-check
import { isSha } from './util.mjs'

const FOOTER_START = '<!-- release-tools'
const FOOTER_END = '-->'

/**
 * The machine-readable footer of a GitHub Release. The action always writes the commit the version was built
 * from and the run that released it; `publish: "none"` projects read the released commit from it.
 * @param {{ commit: string, runId?: string | number, createdBy?: string, kind?: string }} f
 */
export function formatFooter(f) {
  const lines = [FOOTER_START, `commit: ${f.commit}`]
  if (f.kind) lines.push(`kind: ${f.kind}`)
  if (f.runId) lines.push(`run-id: ${f.runId}`)
  if (f.createdBy) lines.push(`created-by: ${f.createdBy}`)
  lines.push(FOOTER_END)
  return lines.join('\n')
}

/**
 * Reads the last footer of a Release body; unknown keys are ignored.
 * @param {string | null | undefined} body
 * @returns {{ commit: string | null, runId: string | null, fields: Record<string, string> } | null}
 */
export function parseFooter(body) {
  if (!body) return null
  const start = body.lastIndexOf(FOOTER_START)
  if (start < 0) return null
  const end = body.indexOf(FOOTER_END, start + FOOTER_START.length)
  if (end < 0) return null
  /** @type {Record<string, string>} */
  const fields = {}
  for (const line of body.slice(start + FOOTER_START.length, end).split('\n')) {
    const m = /^\s*([a-z][a-z0-9-]*):\s*(\S*)\s*$/.exec(line)
    if (m && !(m[1] in fields)) fields[m[1]] = m[2]
  }
  const commit = isSha(fields.commit) ? fields.commit : null
  const runId = fields['run-id'] && /^\d+$/.test(fields['run-id']) ? fields['run-id'] : null
  return { commit, runId, fields }
}

/**
 * The visible part of a Release body. The footer is appended by whoever creates the Release.
 * @param {object} o
 * @param {string} o.repo
 * @param {string} o.tag
 * @param {string} o.commit
 * @param {string | null} o.changelog changelog text with absolute links, or null
 * @param {string | null} [o.changelogPath] repository path of the changelog file
 * @param {string | null} [o.branch]
 * @param {string | null} [o.installLine] dev builds: the line for package.json
 * @param {boolean} [o.dev] a dev build
 */
export function composeBody(o) {
  const parts = []
  if (o.dev && !o.installLine) {
    parts.push(`Dev build of \`${o.branch ?? 'unknown branch'}\` at ${o.commit}.`)
  } else if (o.changelog) {
    parts.push(stripHeader(o.changelog).trim())
    if (o.changelogPath) parts.push(`[Changelog file](https://github.com/${o.repo}/blob/${o.tag}/${o.changelogPath})`)
  } else if (o.installLine) {
    parts.push(`Dev build of \`${o.branch ?? 'unknown branch'}\` at ${o.commit}.`)
    parts.push('Install it with this line in `package.json`:')
    parts.push('```json\n' + o.installLine + '\n```')
  } else {
    parts.push(`Built from \`${o.branch ?? 'unknown branch'}\` at ${o.commit}; no changelog yet.`)
  }
  parts.push(`Commit: https://github.com/${o.repo}/commit/${o.commit}`)
  return parts.join('\n\n')
}

/**
 * Drops the `<version> — <date>` header and its `===` underline; the Release title already has the version.
 * @param {string} text
 */
export function stripHeader(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  if (i < lines.length && /^\S+ — \S+/.test(lines[i]) && /^=+\s*$/.test(lines[i + 1] ?? '')) {
    return lines.slice(i + 2).join('\n')
  }
  if (i < lines.length && /^#\s+\S+ — \S+/.test(lines[i])) return lines.slice(i + 1).join('\n')
  return lines.join('\n')
}

/**
 * @param {string} visible
 * @param {{ commit: string, runId?: string | number, createdBy?: string, kind?: string }} footer
 */
export function withFooter(visible, footer) {
  return `${visible.trimEnd()}\n\n${formatFooter(footer)}\n`
}
