// @ts-check
import { posix } from 'node:path'
import * as semver from './semver.mjs'

export const DEFAULT_TEMPLATE = `{version} — unreleased
===

### Added

### Changed

### Deprecated

### Removed

### Fixed

### Security
`

const HEADER_RE = /^(\S+) — (unreleased|\d{4}-\d{2}-\d{2})\s*$/
const INDEX_LINE_RE = /^- \[([^\]]+)\]\(([^)\s]+)\) — (\d{4}-\d{2}-\d{2})\s*$/

/**
 * @param {string} text
 * @returns {{ version: string, date: string | null, lineIndex: number } | null}
 */
export function parseHeader(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    const m = HEADER_RE.exec(lines[i].replace(/^#+\s+/, ''))
    if (!m) return null
    return { version: m[1], date: m[2] === 'unreleased' ? null : m[2], lineIndex: i }
  }
  return null
}

/**
 * The file has at least one line that is not a heading, a heading underline or empty.
 * @param {string} text
 */
export function hasContent(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim()
    if (!l) continue
    if (/^#{1,6}(\s|$)/.test(l)) continue
    if (/^(=+|-+)$/.test(l)) continue
    const next = (lines[i + 1] ?? '').trim()
    if (/^(=+|-+)$/.test(next) && next.length > 0) continue
    if (/^<!--.*-->$/.test(l)) continue
    return true
  }
  return false
}

/**
 * @param {string} template
 * @param {string} version
 */
export function renderTemplate(template, version) {
  return template.replaceAll('{version}', version)
}

/**
 * Replaces `unreleased` in the header with the date. A header that already has a date is kept.
 * @param {string} text
 * @param {string} version
 * @param {string} date YYYY-MM-DD
 */
export function setReleaseDate(text, version, date) {
  const header = parseHeader(text)
  if (!header) throw new Error(`the changelog of ${version} has no header "${version} — unreleased"`)
  if (header.version !== version) throw new Error(`the changelog header names ${header.version}, not ${version}`)
  if (header.date) return text
  const lines = text.split('\n')
  lines[header.lineIndex] = lines[header.lineIndex].replace(/ — unreleased(\s*)$/, ` — ${date}$1`)
  return lines.join('\n')
}

/**
 * @param {string} indexPath repository path of the index file, e.g. CHANGELOG.md
 * @param {string} changelogDir e.g. doc/changelog
 * @param {string} version
 */
export function indexLink(indexPath, changelogDir, version) {
  const rel = posix.relative(posix.dirname(indexPath), posix.join(changelogDir, `${version}.md`))
  return rel
}

/**
 * Index lines, newest version first.
 * @param {{ version: string, date: string }[]} entries
 * @param {string} indexPath
 * @param {string} changelogDir
 */
export function indexLines(entries, indexPath, changelogDir) {
  return [...entries]
    .filter((e) => semver.isStable(e.version))
    .sort((a, b) => semver.compare(b.version, a.version))
    .map((e) => `- [${e.version}](${indexLink(indexPath, changelogDir, e.version)}) — ${e.date}`)
}

/**
 * The entries of released changelog files: `X.Y.Z.md` whose header has a date.
 * @param {{ name: string, text: string }[]} files files of the changelog directory
 */
export function releasedEntries(files) {
  const entries = []
  for (const f of files) {
    const m = /^(.+)\.md$/.exec(f.name)
    if (!m || !semver.isStable(m[1])) continue
    const header = parseHeader(f.text)
    if (header && header.version === m[1] && header.date) entries.push({ version: m[1], date: header.date })
  }
  return entries
}

/**
 * Rewrites the block of `- [X](…) — date` lines; everything else stays. Without a block, it is inserted after
 * the first paragraph (or at the end).
 * @param {string} text current index file content
 * @param {string[]} lines
 */
export function replaceIndexBlock(text, lines) {
  const src = text.replace(/\r\n/g, '\n').split('\n')
  let start = -1
  let end = -1
  for (let i = 0; i < src.length; i++) {
    if (INDEX_LINE_RE.test(src[i])) {
      start = i
      end = i
      while (end + 1 < src.length && INDEX_LINE_RE.test(src[end + 1])) end++
      break
    }
  }
  if (start >= 0) {
    const out = [...src.slice(0, start), ...lines, ...src.slice(end + 1)]
    return out.join('\n')
  }
  // Insert after the first paragraph that is not a heading.
  let insertAt = -1
  for (let i = 0; i < src.length; i++) {
    const l = src[i].trim()
    if (!l || /^#{1,6}(\s|$)/.test(l)) continue
    if (/^(=+|-+)$/.test((src[i + 1] ?? '').trim())) {
      i++
      continue
    }
    let j = i
    while (j + 1 < src.length && src[j + 1].trim()) j++
    insertAt = j + 1
    break
  }
  if (insertAt < 0) {
    const body = src.join('\n').replace(/\n*$/, '')
    return `${body}\n\n${lines.join('\n')}\n`
  }
  const out = [...src.slice(0, insertAt), '', ...lines, ...src.slice(insertAt)]
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

/**
 * @param {string} text
 * @param {{ version: string, date: string }[]} entries
 * @param {string} indexPath
 * @param {string} changelogDir
 */
export function rebuildIndex(text, entries, indexPath, changelogDir) {
  return replaceIndexBlock(text, indexLines(entries, indexPath, changelogDir))
}

/** @param {string} text */
export function stripIndexBlock(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !INDEX_LINE_RE.test(l))
    .join('\n')
}

/**
 * Turns relative links into absolute links at a git ref (GitHub Releases do not resolve relative links).
 * Code spans and fenced code blocks are left alone.
 * @param {string} markdown
 * @param {{ repo: string, ref: string, fileDir: string }} o fileDir: repository directory of the markdown file
 */
export function absolutizeLinks(markdown, o) {
  const toAbs = (/** @type {string} */ url, /** @type {boolean} */ image) => {
    if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('#') || url.startsWith('//')) return url
    const m = /^([^?#]*)(.*)$/.exec(url)
    const pathPart = m?.[1] ?? url
    const rest = m?.[2] ?? ''
    const joined = pathPart.startsWith('/') ? pathPart.slice(1) : posix.normalize(posix.join(o.fileDir, pathPart))
    if (joined.startsWith('..')) return url
    const kind = image ? 'raw' : 'blob'
    return `https://github.com/${o.repo}/${kind}/${o.ref}/${joined}${rest}`
  }
  const lines = markdown.split('\n')
  let fence = null
  for (let i = 0; i < lines.length; i++) {
    const fm = /^\s*(```+|~~~+)/.exec(lines[i])
    if (fm) {
      if (!fence) fence = fm[1][0]
      else if (fm[1][0] === fence) fence = null
      continue
    }
    if (fence) continue
    const def = /^(\s{0,3}\[[^\]]+\]:\s*)(<?)(\S+?)(>?)(\s.*)?$/.exec(lines[i])
    if (def) {
      lines[i] = `${def[1]}${def[2]}${toAbs(def[3], false)}${def[4]}${def[5] ?? ''}`
      continue
    }
    // Split out code spans so their content is not rewritten.
    const segments = lines[i].split(/(`+[^`]*`+)/)
    for (let s = 0; s < segments.length; s += 2) {
      segments[s] = segments[s].replace(/(!?)\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(\s+"[^"]*")?\s*\)/g, (all, bang, text, url, title) => {
        const bare = url.startsWith('<') ? url.slice(1, -1) : url
        return `${bang}[${text}](${toAbs(bare, bang === '!')}${title ?? ''})`
      })
    }
    lines[i] = segments.join('')
  }
  return lines.join('\n')
}

/**
 * Changelog files of other versions that are not released: `X.Y.Z.md` other than `version`, with `unreleased`
 * in the header or of a version that was never released.
 * @param {{ name: string, text: string }[]} files
 * @param {string} version
 * @param {Set<string>} released
 */
export function otherUnreleased(files, version, released) {
  const out = []
  for (const f of files) {
    const m = /^(.+)\.md$/.exec(f.name)
    if (!m || !semver.isStable(m[1]) || m[1] === version) continue
    const header = parseHeader(f.text)
    if ((header && !header.date) || !released.has(m[1])) out.push(m[1])
  }
  return out
}
