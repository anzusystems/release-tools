// @ts-check
import { randomBytes } from 'node:crypto'

/** An expected stop: a failed check or a state the user has to resolve. Printed without a stack. */
export class ReleaseError extends Error {
  /**
   * @param {string} message
   * @param {{ hint?: string, code?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message)
    this.name = 'ReleaseError'
    this.hint = options.hint
    this.code = options.code
  }
}

/** Thrown by `--dry-run` at the first step that would change something. */
export class DryRunStop extends Error {
  constructor(message) {
    super(message)
    this.name = 'DryRunStop'
  }
}

/** Thrown by `RELEASE_TOOLS_FAIL_AT=<step>` right after that step (test mode). */
export class Interrupted extends Error {
  constructor(step) {
    super(`interrupted after ${step} (RELEASE_TOOLS_FAIL_AT)`)
    this.name = 'Interrupted'
    this.step = step
  }
}

/** @param {number} ms */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function randomHex(bytes = 8) {
  return randomBytes(bytes).toString('hex')
}

/**
 * Poll interval; tests shorten it through RELEASE_TOOLS_POLL_MS.
 * @param {number} ms
 */
export function pollMs(ms) {
  const override = Number(process.env.RELEASE_TOOLS_POLL_MS)
  return Number.isFinite(override) && override > 0 ? override : ms
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ attempts?: number, baseMs?: number, maxMs?: number, retryIf?: (e: any) => boolean }} [options]
 * @returns {Promise<T>}
 */
export async function retry(fn, options = {}) {
  const { attempts = 6, baseMs = 1000, maxMs = 30000, retryIf = () => true } = options
  let last
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      if (i === attempts - 1 || !retryIf(e)) throw e
      await sleep(Math.min(maxMs, pollMs(baseMs) * 2 ** i))
    }
  }
  throw last
}

/**
 * Stable sort by a key, descending when `desc`.
 * @template T
 * @param {T[]} items
 * @param {(a: T, b: T) => number} compare
 */
export function sorted(items, compare) {
  return [...items].sort(compare)
}

/** @param {string} s */
export function indent(s, prefix = '  ') {
  return s
    .split('\n')
    .map((line) => (line ? prefix + line : line))
    .join('\n')
}

/**
 * Minimal glob → RegExp for pack.verify: `**` any path, `*` within a segment, `?` one character.
 * @param {string} glob
 */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

/**
 * @param {Date} date
 * @returns {string} YYYY-MM-DD in UTC
 */
export function isoDate(date) {
  return date.toISOString().slice(0, 10)
}

/**
 * @param {Date} date
 * @returns {string} YYYYMMDDHHMMSS in UTC
 */
export function compactTime(date) {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

/** @param {string} s */
export function isSha(s) {
  return typeof s === 'string' && /^[0-9a-f]{40}$/.test(s)
}

/**
 * Parses owner/name from a git remote URL or a `owner/name` string.
 * @param {string} url
 * @returns {string | null}
 */
export function repoFromUrl(url) {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim())
  if (m) return `${m[1]}/${m[2]}`
  if (/^[\w.-]+\/[\w.-]+$/.test(url.trim())) return url.trim()
  return null
}
