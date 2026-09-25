// @ts-check

const NUM = '0|[1-9]\\d*'
const PRE_ID = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)'
const BUILD_ID = '[0-9a-zA-Z-]+'
const SEMVER = new RegExp(
  `^(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+(${BUILD_ID}(?:\\.${BUILD_ID})*))?$`,
)
const STABLE = new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})$`)

/**
 * @typedef {object} SemVer
 * @property {number} major
 * @property {number} minor
 * @property {number} patch
 * @property {string[]} pre
 * @property {string[]} build
 * @property {string} raw
 */

/**
 * @param {string} v
 * @returns {SemVer | null}
 */
export function parse(v) {
  if (typeof v !== 'string') return null
  const m = SEMVER.exec(v)
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
    build: m[5] ? m[5].split('.') : [],
    raw: v,
  }
}

/** @param {string} v */
export function valid(v) {
  return parse(v) !== null
}

/** Exactly `X.Y.Z`: no prerelease part, no build metadata. @param {string} v */
export function isStable(v) {
  return typeof v === 'string' && STABLE.test(v)
}

/**
 * @param {string} a
 * @param {string} b
 */
function compareIds(a, b) {
  const an = /^\d+$/.test(a)
  const bn = /^\d+$/.test(b)
  if (an && bn) return Math.sign(Number(a) - Number(b))
  if (an) return -1
  if (bn) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Semver precedence; build metadata is ignored.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compare(a, b) {
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) throw new Error(`invalid version: ${!pa ? a : b}`)
  for (const k of /** @type {const} */ (['major', 'minor', 'patch'])) {
    if (pa[k] !== pb[k]) return Math.sign(pa[k] - pb[k])
  }
  if (!pa.pre.length && !pb.pre.length) return 0
  if (!pa.pre.length) return 1
  if (!pb.pre.length) return -1
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    if (pa.pre[i] === undefined) return -1
    if (pb.pre[i] === undefined) return 1
    const c = compareIds(pa.pre[i], pb.pre[i])
    if (c) return c
  }
  return 0
}

/** @param {string} a @param {string} b */
export const gt = (a, b) => compare(a, b) > 0
/** @param {string} a @param {string} b */
export const gte = (a, b) => compare(a, b) >= 0
/** @param {string} a @param {string} b */
export const lt = (a, b) => compare(a, b) < 0
/** @param {string} a @param {string} b */
export const eq = (a, b) => compare(a, b) === 0

/**
 * @param {string[]} versions
 * @returns {string[]} ascending
 */
export function sortAsc(versions) {
  return [...versions].sort(compare)
}

/**
 * @param {string[]} versions
 * @returns {string | null}
 */
export function max(versions) {
  let best = null
  for (const v of versions) if (best === null || gt(v, best)) best = v
  return best
}

/** `X.Y` of a version. @param {string} v */
export function line(v) {
  const p = parse(v)
  if (!p) throw new Error(`invalid version: ${v}`)
  return `${p.major}.${p.minor}`
}

/** `X.Y.Z` of a version. @param {string} v */
export function core(v) {
  const p = parse(v)
  if (!p) throw new Error(`invalid version: ${v}`)
  return `${p.major}.${p.minor}.${p.patch}`
}

/**
 * @param {string} v
 * @param {'patch' | 'minor' | 'major'} kind
 */
export function bump(v, kind) {
  const p = parse(v)
  if (!p) throw new Error(`invalid version: ${v}`)
  if (kind === 'major') return `${p.major + 1}.0.0`
  if (kind === 'minor') return `${p.major}.${p.minor + 1}.0`
  return `${p.major}.${p.minor}.${p.patch + 1}`
}
