// @ts-check
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from './exec.mjs'
import { stripIndexBlock, replaceIndexBlock } from './changelog.mjs'

/** Files whose conflicts on the version alone are resolved automatically. */
export const VERSION_FILES = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json']

/**
 * Line numbers (0-based) of the values of the root `version` and of `packages[""].version`.
 * A small scanner that follows the JSON structure; it does not need the whole file to be valid.
 * @param {string} text
 * @returns {number[]}
 */
export function rootVersionLines(text) {
  /** @type {{ type: 'object' | 'array', key: string | null, expectKey: boolean }[]} */
  const stack = []
  const lines = []
  let line = 0
  let i = 0
  const pathIs = (/** @type {string[]} */ target) => {
    if (stack.length !== target.length) return false
    for (let d = 0; d < stack.length; d++) {
      if (stack[d].type !== 'object' || stack[d].key !== target[d]) return false
    }
    return true
  }
  while (i < text.length) {
    const c = text[i]
    if (c === '\n') {
      line++
      i++
      continue
    }
    if (c === '"') {
      let j = i + 1
      let value = ''
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          value += text[j + 1]
          j += 2
          continue
        }
        if (text[j] === '\n') line++
        value += text[j]
        j++
      }
      const top = stack[stack.length - 1]
      if (top && top.type === 'object' && top.expectKey) {
        top.key = value
        top.expectKey = false
      } else if (pathIs(['version']) || pathIs(['packages', '', 'version'])) {
        lines.push(line)
      }
      i = j + 1
      continue
    }
    if (c === '{') {
      stack.push({ type: 'object', key: null, expectKey: true })
    } else if (c === '[') {
      stack.push({ type: 'array', key: null, expectKey: false })
    } else if (c === '}' || c === ']') {
      stack.pop()
    } else if (c === ',') {
      const top = stack[stack.length - 1]
      if (top && top.type === 'object') {
        top.expectKey = true
        top.key = null
      }
    }
    i++
  }
  return lines
}

/**
 * Sets the root version (and `packages[""].version` in lockfiles) without touching the formatting.
 * @param {string} text
 * @param {string} version
 */
export function setRootVersion(text, version) {
  const lines = text.split('\n')
  for (const n of rootVersionLines(text)) {
    lines[n] = lines[n].replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`)
  }
  return lines.join('\n')
}

/**
 * Three-way merge of texts with `git merge-file`.
 * @param {{ base: string, ours: string, theirs: string }} t
 * @returns {Promise<{ clean: boolean, text: string }>}
 */
export async function mergeTexts(t) {
  const dir = await mkdtemp(join(tmpdir(), 'release-tools-merge-'))
  try {
    await writeFile(join(dir, 'ours'), t.ours)
    await writeFile(join(dir, 'base'), t.base)
    await writeFile(join(dir, 'theirs'), t.theirs)
    const r = await run('git', ['merge-file', '-p', '-L', 'ours', '-L', 'base', '-L', 'theirs', 'ours', 'base', 'theirs'], {
      cwd: dir,
      allowFail: true,
    })
    if (r.code < 0 || r.code > 127) throw new Error(`git merge-file failed: ${r.stderr}`)
    return { clean: r.code === 0, text: r.stdout }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Resolves a conflict in package.json or a lockfile when the conflicting blocks differ only in the version:
 * every side gets the release version, then git merges the rest. Any other conflicting block stays a conflict.
 * @param {{ base: string | null, ours: string | null, theirs: string | null }} stages
 * @param {string} version
 * @returns {Promise<string | null>} the resolved text, or null when it is another conflict
 */
export async function resolveVersionConflict(stages, version) {
  if (stages.base === null || stages.ours === null || stages.theirs === null) return null
  const r = await mergeTexts({
    base: setRootVersion(stages.base, version),
    ours: setRootVersion(stages.ours, version),
    theirs: setRootVersion(stages.theirs, version),
  })
  if (!r.clean) return null
  try {
    JSON.parse(r.text)
  } catch {
    return null
  }
  return r.text
}

const PLACEHOLDER = '<!-- release-tools: changelog index -->'

/**
 * Resolves a conflict in the changelog index: the lines of the index block are rebuilt; other conflicting lines
 * stay a conflict.
 * @param {{ base: string | null, ours: string | null, theirs: string | null }} stages
 * @param {string[]} lines the rebuilt index lines
 * @returns {Promise<string | null>}
 */
export async function resolveIndexConflict(stages, lines) {
  if (stages.ours === null || stages.theirs === null) return null
  const mark = (/** @type {string} */ s) => {
    const stripped = stripIndexBlock(s)
    if (stripped === s.replace(/\r\n/g, '\n')) return s
    // Keep the position of the block as one placeholder line.
    const src = s.replace(/\r\n/g, '\n').split('\n')
    const out = []
    let placed = false
    for (const l of src) {
      if (/^- \[[^\]]+\]\([^)\s]+\) — \d{4}-\d{2}-\d{2}\s*$/.test(l)) {
        if (!placed) out.push(PLACEHOLDER)
        placed = true
      } else {
        out.push(l)
      }
    }
    return out.join('\n')
  }
  const r = await mergeTexts({ base: mark(stages.base ?? ''), ours: mark(stages.ours), theirs: mark(stages.theirs) })
  if (!r.clean) return null
  if (r.text.includes(PLACEHOLDER)) {
    return r.text
      .split('\n')
      .flatMap((l) => (l === PLACEHOLDER ? lines : [l]))
      .join('\n')
  }
  return replaceIndexBlock(r.text, lines)
}
