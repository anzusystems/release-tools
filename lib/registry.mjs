// @ts-check
import { sleep, pollMs, isSha } from './util.mjs'

/**
 * @typedef {object} RegistryVersion
 * @property {string} version
 * @property {string | null} integrity
 * @property {string | null} tarball
 * @property {string | null} attestations
 */

/**
 * @typedef {object} Registry
 * @property {(pkg: string, version: string) => Promise<RegistryVersion | null>} version fresh (the per-version endpoint is not cached)
 * @property {(pkg: string) => Promise<string[]>} versions from the packument (cached up to 5 minutes)
 * @property {(pkg: string) => Promise<Record<string, string>>} distTags fresh
 * @property {(pkg: string, version: string, options?: { waitMs?: number }) => Promise<string | null | undefined>} provenanceCommit
 *   the commit a version was built from; null without provenance, undefined while it cannot be read yet
 * @property {(pkg: string, version: string) => Promise<Buffer>} tarball
 */

/** @param {string} pkg */
function encodePackage(pkg) {
  return pkg.startsWith('@') ? `@${encodeURIComponent(pkg.slice(1))}` : encodeURIComponent(pkg)
}

/** @implements {Registry} */
export class NpmRegistry {
  constructor(url = 'https://registry.npmjs.org') {
    this.url = url.replace(/\/$/, '')
  }

  /**
   * @param {string} url
   * @param {{ allow404?: boolean }} [o]
   */
  async get(url, o = {}) {
    let lastError
    for (let i = 0; i < 8; i++) {
      try {
        const res = await fetch(url, { headers: { accept: 'application/json', 'cache-control': 'no-cache', 'user-agent': 'anzusystems-release-tools' } })
        if (res.status === 404 && o.allow404) return null
        if (res.status >= 500 || res.status === 429) {
          lastError = new Error(`GET ${url}: ${res.status}`)
          await sleep(Math.min(30000, pollMs(1000) * 2 ** i))
          continue
        }
        if (!res.ok) throw new Error(`GET ${url}: ${res.status}`)
        return await res.json()
      } catch (e) {
        if (/GET .*: 4\d\d$/.test(e.message)) throw e
        lastError = e
        await sleep(Math.min(30000, pollMs(1000) * 2 ** i))
      }
    }
    throw lastError
  }

  /**
   * @param {string} pkg
   * @param {string} version
   */
  async version(pkg, version) {
    const d = await this.get(`${this.url}/${encodePackage(pkg)}/${encodeURIComponent(version)}`, { allow404: true })
    if (!d || d.version !== version) return null
    return { version, integrity: d.dist?.integrity ?? null, tarball: d.dist?.tarball ?? null, attestations: d.dist?.attestations?.url ?? null }
  }

  /** @param {string} pkg */
  async versions(pkg) {
    const d = await this.get(`${this.url}/${encodePackage(pkg)}`, { allow404: true })
    return d?.versions ? Object.keys(d.versions) : []
  }

  /** @param {string} pkg */
  async distTags(pkg) {
    const d = await this.get(`${this.url}/-/package/${encodePackage(pkg)}/dist-tags`, { allow404: true })
    return d ?? {}
  }

  /**
   * SLSA provenance: resolvedDependencies[0].digest.gitCommit. A 404 of the attestations is cached for 60 s,
   * so it is read again for a while after publishing.
   * @param {string} pkg
   * @param {string} version
   * @param {{ waitMs?: number }} [options]
   */
  async provenanceCommit(pkg, version, options = {}) {
    const deadline = Date.now() + (options.waitMs ?? 0)
    for (;;) {
      const v = await this.version(pkg, version)
      if (v?.attestations) {
        const a = await this.get(v.attestations, { allow404: true })
        const commit = a ? provenanceFromAttestations(a) : undefined
        if (commit !== undefined) return commit
      } else if (v && Date.now() >= deadline) {
        return null
      }
      if (Date.now() >= deadline) return undefined
      await sleep(pollMs(10000))
    }
  }

  /**
   * @param {string} pkg
   * @param {string} version
   */
  async tarball(pkg, version) {
    const v = await this.version(pkg, version)
    if (!v?.tarball) throw new Error(`${pkg}@${version} has no tarball in the registry`)
    const res = await fetch(v.tarball)
    if (!res.ok) throw new Error(`GET ${v.tarball}: ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
}

/**
 * @param {any} attestations response of dist.attestations.url
 * @returns {string | null | undefined} commit, null when there is no SLSA provenance, undefined when unreadable
 */
export function provenanceFromAttestations(attestations) {
  const list = attestations?.attestations
  if (!Array.isArray(list)) return undefined
  const slsa = list.find((a) => /slsa\.dev\/provenance/.test(a.predicateType ?? ''))
  if (!slsa) return null
  try {
    const payload = JSON.parse(Buffer.from(slsa.bundle.dsseEnvelope.payload, 'base64').toString('utf8'))
    const deps = payload.predicate?.buildDefinition?.resolvedDependencies
    const commit = deps?.[0]?.digest?.gitCommit
    return isSha(commit) ? commit : undefined
  } catch {
    return undefined
  }
}

/**
 * Test mode (RELEASE_TOOLS_REGISTRY=mock): the registry is kept as tags of the repository.
 * `mock-npm/versions/<version>` marks a published version (its message holds the integrity), the tarball is an
 * asset of the GitHub Release with the same tag, and `mock-npm/tags/<tag>` is an npm tag.
 * @implements {Registry}
 */
export class MockRegistry {
  /** @param {import('./github.mjs').GitHub} gh */
  constructor(gh) {
    this.gh = gh
  }

  /**
   * @param {string} pkg
   * @param {string} version
   */
  async version(pkg, version) {
    const t = await this.gh.tag(`mock-npm/versions/${version}`)
    if (!t) return null
    const integrity = /integrity: (\S+)/.exec(t.message ?? '')?.[1] ?? null
    return { version, integrity, tarball: `mock:${version}`, attestations: `mock:${version}` }
  }

  /** @param {string} pkg */
  async versions(pkg) {
    const refs = await this.gh.tagRefs()
    return refs.filter((r) => r.name.startsWith('mock-npm/versions/')).map((r) => r.name.slice('mock-npm/versions/'.length))
  }

  /** @param {string} pkg */
  async distTags(pkg) {
    const refs = await this.gh.tagRefs()
    /** @type {Record<string, string>} */
    const out = {}
    for (const r of refs.filter((x) => x.name.startsWith('mock-npm/tags/'))) {
      const t = await this.gh.tag(r.name)
      const v = /version: (\S+)/.exec(t?.message ?? '')?.[1]
      if (v) out[r.name.slice('mock-npm/tags/'.length)] = v
    }
    return out
  }

  /**
   * @param {string} pkg
   * @param {string} version
   */
  async provenanceCommit(pkg, version) {
    const t = await this.gh.tag(`mock-npm/versions/${version}`)
    if (!t) return undefined
    if (/provenance: none/.test(t.message ?? '')) return null
    return t.commit
  }

  /**
   * @param {string} pkg
   * @param {string} version
   */
  async tarball(pkg, version) {
    const rel = (await this.gh.releases()).find((r) => r.tagName === `mock-npm/versions/${version}`)
    const asset = rel?.assets[0]
    if (!rel || !asset) throw new Error(`mock registry: no tarball of ${version}`)
    return this.gh.downloadAsset(rel.id, asset.id)
  }

  /**
   * "Publishes": the version tag, the tarball and the npm tag.
   * @param {{ version: string, commit: string, integrity: string, tarballFile: string, tag: string }} o
   * @returns {Promise<'published' | 'exists'>}
   */
  async publish(o) {
    if (await this.gh.tag(`mock-npm/versions/${o.version}`)) return 'exists'
    await this.gh.createApiTag(`mock-npm/versions/${o.version}`, o.commit, `mock npm version\nintegrity: ${o.integrity}\n`)
    const rel = await this.gh.createRelease({
      tag: `mock-npm/versions/${o.version}`,
      name: `mock npm ${o.version}`,
      body: 'mock registry',
      prerelease: true,
      latest: false,
      commit: o.commit,
    })
    await this.gh.uploadAsset(rel.id, o.tarballFile)
    await this.setDistTag(o.tag, o.version, o.commit)
    return 'published'
  }

  /**
   * @param {string} tag
   * @param {string} version
   * @param {string} commit
   */
  async setDistTag(tag, version, commit) {
    await this.gh.createApiTag(`mock-npm/tags/${tag}`, commit, `mock npm tag\nversion: ${version}\n`, true)
  }
}

/**
 * @param {import('./github.mjs').GitHub} gh
 * @returns {Registry}
 */
export function registryFor(gh) {
  if (process.env.RELEASE_TOOLS_REGISTRY === 'mock') return new MockRegistry(gh)
  return new NpmRegistry(process.env.RELEASE_TOOLS_NPM_REGISTRY || 'https://registry.npmjs.org')
}
