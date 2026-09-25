// @ts-check
import { createHash } from 'node:crypto'
import { repoFromUrl, globToRegExp } from './util.mjs'

/**
 * `publishConfig` keys that only change the packed manifest. Everything else (registry, scoped registries,
 * auth keys, provenance, access, tag, dry-run, …) is refused; the command line sets those.
 */
export const PUBLISH_CONFIG_ALLOWED = [
  'bin',
  'browser',
  'directories',
  'es2015',
  'esnext',
  'executableFiles',
  'exports',
  'imports',
  'jsnext:main',
  'main',
  'module',
  'type',
  'types',
  'typesVersions',
  'typings',
  'umd:main',
  'unpkg',
]

/**
 * Checks the manifest inside a packed tarball.
 * @param {any} manifest package/package.json
 * @param {{ packageName: string, version: string, repo: string, npm: boolean }} expected
 * @returns {string[]} problems
 */
export function checkManifest(manifest, expected) {
  const problems = []
  if (!manifest || typeof manifest !== 'object') return ['package.json is missing in the package']
  if (manifest.name !== expected.packageName) problems.push(`name is ${JSON.stringify(manifest.name)}, expected ${expected.packageName}`)
  if (manifest.version !== expected.version) problems.push(`version is ${JSON.stringify(manifest.version)}, expected ${expected.version}`)
  if (manifest.private === true) problems.push('the package is private')
  if (expected.npm) {
    const url = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
    const repo = typeof url === 'string' ? repoFromUrl(url.replace(/^git\+/, '').replace(/^github:/, 'https://github.com/')) : null
    if (!repo || repo.toLowerCase() !== expected.repo.toLowerCase()) {
      problems.push(`repository.url is ${JSON.stringify(url ?? null)}, expected the repository ${expected.repo}`)
    }
  }
  const pc = manifest.publishConfig
  if (pc !== undefined) {
    if (!pc || typeof pc !== 'object' || Array.isArray(pc)) {
      problems.push('publishConfig is not an object')
    } else {
      for (const key of Object.keys(pc)) {
        if (!PUBLISH_CONFIG_ALLOWED.includes(key)) problems.push(`publishConfig.${key} is not allowed`)
      }
    }
  }
  return problems
}

/**
 * @param {Buffer} data
 */
function hash(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * The comparable form of a file for the tested-prerelease comparison: package.json without its version and
 * without a dependency on the package itself; npm-shrinkwrap.json without its versions.
 * @param {string} path
 * @param {Buffer} data
 * @param {string} packageName
 */
export function comparableHash(path, data, packageName) {
  if (path === 'package.json') {
    try {
      const m = JSON.parse(data.toString('utf8'))
      delete m.version
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        if (m[field] && typeof m[field] === 'object') delete m[field][packageName]
      }
      return hash(Buffer.from(JSON.stringify(m)))
    } catch {
      return hash(data)
    }
  }
  if (path === 'npm-shrinkwrap.json') {
    try {
      const m = JSON.parse(data.toString('utf8'))
      delete m.version
      if (m.packages?.['']) delete m.packages[''].version
      return hash(Buffer.from(JSON.stringify(m)))
    } catch {
      return hash(data)
    }
  }
  return hash(data)
}

/**
 * Compares a stable package with its tested prerelease. CHANGELOG.md and files in the changelog directory are
 * left out (the final commit changes the changelog header).
 * @param {{ path: string, data: Buffer }[]} stable
 * @param {{ path: string, data: Buffer }[]} candidate
 * @param {{ packageName: string, changelogDir: string }} o
 * @returns {string[]} differences
 */
export function compareWithCandidate(stable, candidate, o) {
  const skip = (/** @type {string} */ p) => p === 'CHANGELOG.md' || p === o.changelogDir || p.startsWith(`${o.changelogDir.replace(/\/$/, '')}/`)
  const a = new Map(stable.filter((e) => !skip(e.path)).map((e) => [e.path, comparableHash(e.path, e.data, o.packageName)]))
  const b = new Map(candidate.filter((e) => !skip(e.path)).map((e) => [e.path, comparableHash(e.path, e.data, o.packageName)]))
  const diffs = []
  for (const [p, h] of a) {
    if (!b.has(p)) diffs.push(`only in the stable package: ${p}`)
    else if (b.get(p) !== h) diffs.push(`different: ${p}`)
  }
  for (const p of b.keys()) if (!a.has(p)) diffs.push(`only in the prerelease: ${p}`)
  return diffs.sort()
}

/**
 * pack.verify: files of the tarball in the `compare` directories must equal the local build (path and hash);
 * outside them the tarball may only hold files matching `allow`.
 * @param {{ path: string, data: Buffer }[]} entries
 * @param {Map<string, Buffer>} local files of the local build under the compare directories, by package path
 * @param {{ compare?: string[], allow?: string[] }} verify
 * @returns {string[]} problems
 */
export function verifyPack(entries, local, verify) {
  const compare = (verify.compare ?? []).map((d) => d.replace(/\/+$/, ''))
  const allow = (verify.allow ?? []).map(globToRegExp)
  const inCompare = (/** @type {string} */ p) => compare.some((d) => p === d || p.startsWith(`${d}/`))
  const problems = []
  const seen = new Set()
  for (const e of entries) {
    if (inCompare(e.path)) {
      seen.add(e.path)
      const l = local.get(e.path)
      if (!l) problems.push(`not in the local build: ${e.path}`)
      else if (hash(l) !== hash(e.data)) problems.push(`differs from the local build: ${e.path}`)
    } else if (!allow.some((re) => re.test(e.path))) {
      problems.push(`not allowed in the package: ${e.path}`)
    }
  }
  for (const p of local.keys()) if (!seen.has(p)) problems.push(`missing in the package: ${p}`)
  return problems.sort()
}

/**
 * The file name of a packed tarball: the package without `@`, `/` replaced by `-`, then `-<version>.tgz`.
 * @param {string} packageName
 * @param {string} version
 */
export function tarballName(packageName, version) {
  return `${packageName.replace(/^@/, '').replace(/\//g, '-')}-${version}.tgz`
}
