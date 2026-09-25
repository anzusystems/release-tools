// @ts-check
import * as semver from './semver.mjs'
import { classifyVersion, PRERELEASE_IDS } from './tags.mjs'

/**
 * @param {Iterable<string>} versions
 * @returns {string[]} released stable versions, highest first
 */
export function stableDesc(versions) {
  return [...versions].filter((v) => semver.isStable(v)).sort((a, b) => semver.compare(b, a))
}

/** @param {Iterable<string>} versions */
export function lastStable(versions) {
  return stableDesc(versions)[0] ?? null
}

/**
 * @param {Iterable<string>} versions
 * @param {string} line `X.Y`
 */
export function lastOfLine(versions, line) {
  return stableDesc(versions).find((v) => semver.line(v) === line) ?? null
}

/** @param {Iterable<string>} versions */
export function latestLine(versions) {
  const last = lastStable(versions)
  return last ? semver.line(last) : null
}

/**
 * The last released version of every line older than the latest one, highest first.
 * @param {Iterable<string>} versions
 */
export function olderLineHeads(versions) {
  const latest = latestLine(versions)
  const seen = new Set()
  const out = []
  for (const v of stableDesc(versions)) {
    const l = semver.line(v)
    if (l === latest || seen.has(l)) continue
    seen.add(l)
    out.push(v)
  }
  return out
}

/**
 * Next prerelease number: one above the highest in the tags and in the registry.
 * @param {string} core X.Y.Z
 * @param {string} id alpha | beta | rc
 * @param {Iterable<string>} names tag names and registry versions
 */
export function nextPrereleaseNumber(core, id, names) {
  let highest = 0
  for (const name of names) {
    const info = classifyVersion(name)
    if (info && info.kind === 'prerelease' && info.core === core && info.id === id) highest = Math.max(highest, info.n)
  }
  return highest + 1
}

/**
 * The tested candidate of a stable version: the highest released prerelease of it.
 * @param {string} core
 * @param {Iterable<string>} released
 */
export function candidateFor(core, released) {
  let best = null
  for (const v of released) {
    const info = classifyVersion(v)
    if (info && info.kind === 'prerelease' && info.core === core && (best === null || semver.gt(v, best))) best = v
  }
  return best
}

/**
 * The line of the version is older than the latest released line.
 * @param {string} version
 * @param {Iterable<string>} released
 */
export function isOlderLine(version, released) {
  const latest = latestLine(released)
  if (!latest) return false
  const [lm, ln] = latest.split('.').map(Number)
  const p = semver.parse(version)
  if (!p) return false
  return p.major < lm || (p.major === lm && p.minor < ln)
}

/**
 * The npm tag of a version. npm tags never move back to a lower version and `latest` never moves on a prerelease.
 * @param {object} o
 * @param {string} o.version
 * @param {'final' | 'hotfix' | 'prerelease'} o.kind
 * @param {Record<string, string>} o.distTags current npm tags
 * @param {Iterable<string>} o.released released versions (without this one)
 */
export function npmTagFor(o) {
  const info = classifyVersion(o.version)
  if (!info) throw new Error(`invalid version ${o.version}`)
  const lineOf = semver.line(o.version)
  if (o.kind === 'hotfix') return `latest-${lineOf}`
  if (o.kind === 'final') return 'latest'
  if (info.kind !== 'prerelease') throw new Error(`no npm tag for ${o.version}`)
  if (isOlderLine(o.version, o.released)) return `${info.id}-${lineOf}`
  const current = o.distTags[info.id]
  if (current && semver.valid(current) && !semver.gt(o.version, current)) return `${info.id}-${lineOf}`
  return info.id
}

/**
 * A stable version is the Latest release when it is higher than every other released stable version.
 * @param {string} version
 * @param {Iterable<string>} released
 */
export function isLatest(version, released) {
  if (!semver.isStable(version)) return false
  return stableDesc(released).every((v) => v === version || semver.gt(version, v))
}

/**
 * Dev build version from the nearest tag the branch comes from.
 * @param {string | null} nearest a stable or prerelease version, or null
 * @param {string} packageVersion version in package.json (used without its prerelease part when there is no tag)
 * @param {string} label time YYYYMMDDHHMMSS or a name
 */
export function devVersion(nearest, packageVersion, label) {
  const base = nearest ?? semver.core(packageVersion)
  const info = classifyVersion(base)
  const v = info?.kind === 'prerelease' ? `${base}.dev.${label}` : `${semver.core(base)}-dev.${label}`
  const check = classifyVersion(v)
  if (!check || check.kind !== 'dev') throw new Error(`invalid dev build version ${v}`)
  return v
}

export { PRERELEASE_IDS }
