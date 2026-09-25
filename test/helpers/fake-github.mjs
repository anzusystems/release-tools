// @ts-check
// An in-memory GitHub for integration tests. Refs live in a real bare repository (the origin of the clones);
// pushes are seen through a post-receive hook. Pull requests, releases, runs and settings live in memory.
// Workflow runs are executed in-process with the real action code when someone looks at them (pump).
import { readFile, writeFile, mkdtemp, rm, chmod } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { run } from '../../lib/exec.mjs'
import { GitHubError } from '../../lib/github.mjs'
import { integrity } from '../../lib/tar.mjs'
import { runMode } from '../../publish/main.mjs'

const TRIGGER = /^[0-9][^.]*\.[0-9][^.]*\.[0-9]/

/**
 * @param {string} dir
 * @param {string[]} args
 * @param {import('../../lib/exec.mjs').RunOptions} [o]
 */
async function git(dir, args, o = {}) {
  return (await run('git', args, { cwd: dir, ...o, extraEnv: { GIT_TERMINAL_PROMPT: '0', ...(o.extraEnv ?? {}) } })).stdout.replace(/\n$/, '')
}

export class FakeRegistry {
  constructor() {
    /** @type {Map<string, { integrity: string, tarball: Buffer, commit: string | null }>} */
    this.store = new Map()
    /** @type {Record<string, string>} */
    this.tags = {}
    this.provenance = true
    this.failPublish = 0
  }

  /**
   * @param {string} pkg
   * @param {string} version
   */
  async version(pkg, version) {
    const v = this.store.get(version)
    return v ? { version, integrity: v.integrity, tarball: `fake:${version}`, attestations: v.commit ? `fake:${version}` : null } : null
  }

  /** @param {string} pkg */
  async versions(pkg) {
    return [...this.store.keys()]
  }

  /** @param {string} pkg */
  async distTags(pkg) {
    return { ...this.tags }
  }

  /**
   * @param {string} pkg
   * @param {string} version
   */
  async provenanceCommit(pkg, version) {
    const v = this.store.get(version)
    if (!v) return undefined
    return v.commit
  }

  /**
   * @param {string} pkg
   * @param {string} version
   */
  async tarball(pkg, version) {
    const v = this.store.get(version)
    if (!v) throw new Error(`no ${version}`)
    return v.tarball
  }

  /**
   * @param {string} version
   * @param {Buffer} data
   * @param {string} tag
   * @param {string | null} commit
   */
  publish(version, data, tag, commit) {
    if (this.failPublish > 0) {
      this.failPublish--
      return { ok: false, exists: false, output: 'npm error network ECONNRESET (fake)' }
    }
    if (this.store.has(version)) return { ok: false, exists: true, output: 'npm error You cannot publish over the previously published versions' }
    this.store.set(version, { integrity: integrity(data), tarball: data, commit: this.provenance ? commit : null })
    this.tags[tag] = version
    return { ok: true, exists: false, output: 'published' }
  }
}

export class FakeGitHub {
  /**
   * @param {{ bare: string, repo: string, login?: string, registry?: FakeRegistry, workflow?: string, tmp?: string }} o
   */
  constructor(o) {
    this.bare = o.bare
    this.tmp = o.tmp ?? null
    this.repo = o.repo
    const [owner, name] = o.repo.split('/')
    this.owner = owner
    this.name = name
    this.login = o.login ?? 'dev'
    this.registry = o.registry ?? new FakeRegistry()
    /** @type {import('../../lib/git.mjs').Guard} */
    this.guard = { mutate() {} }
    this.offsetMs = 0
    this.nextId = 100
    /** @type {any[]} */
    this.pullList = []
    /** @type {any[]} */
    this.releaseList = []
    /** @type {any[]} */
    this.runList = []
    this.latestReleaseId = null
    this.eventsRead = 0
    this.autoRun = true
    this.pumping = false
    this.artifactsExpired = false
    this.draftsVisible = true
    this.settings = {
      mergeCommitAllowed: true,
      linearHistory: false,
      mergeQueue: false,
      requireApproval: false,
      dismissStale: true,
      strict: false,
      canBypass: true,
      classicProtection: false,
      deleteBranchOnMerge: false,
      rulesetMergeMethods: null,
    }
    this.scopes = ['repo', 'workflow']
    /** @type {string[]} */
    this.calls = []
    /** @type {((run: any) => void) | null} */
    this.beforeRun = null
    /** @type {((run: any) => Promise<void>) | null} */
    this.betweenJobs = null
    /** @type {((run: any) => Promise<void>) | null} */
    this.afterRun = null
    this.env = { ...process.env }
  }

  /** Installs the hook that records pushes. */
  async install() {
    const hook = join(this.bare, 'hooks', 'post-receive')
    await writeFile(
      hook,
      `#!/bin/sh\nwhile read old new ref; do echo "$(date +%s%N) $old $new $ref" >> "${join(this.bare, 'events.log')}"; done\n`,
    )
    await chmod(hook, 0o755)
    await writeFile(join(this.bare, 'events.log'), '')
  }

  now() {
    return new Date(Date.now() + this.offsetMs)
  }

  /** @param {string} action */
  mutate(action) {
    this.guard.mutate(action)
  }

  // --- events -------------------------------------------------------------------

  /** Reads pushes recorded by the hook. */
  async sync() {
    const text = readFileSync(join(this.bare, 'events.log'), 'utf8')
    const lines = text.split('\n').filter(Boolean)
    for (const line of lines.slice(this.eventsRead)) {
      const [ms, oldSha, newSha, ref] = line.split(' ')
      await this.onRefChange(ref, oldSha, newSha, new Date(Number(BigInt(ms) / 1000000n) + this.offsetMs))
    }
    this.eventsRead = lines.length
  }

  /**
   * @param {string} ref
   * @param {string} oldSha
   * @param {string} newSha
   * @param {Date} at
   */
  async onRefChange(ref, oldSha, newSha, at) {
    const zero = /^0+$/
    if (ref.startsWith('refs/tags/')) {
      const name = ref.slice('refs/tags/'.length)
      if (zero.test(newSha)) {
        for (const r of this.releaseList) if (r.tagName === name && !r.draft) r.draft = true
      }
      if (!TRIGGER.test(name)) return
      if (!(await this.hasWorkflowAt(zero.test(newSha) ? null : newSha))) return
      const deleted = zero.test(newSha)
      const commit = deleted ? await this.refSha('refs/heads/main') : await git(this.bare, ['rev-parse', `${newSha}^{commit}`])
      this.runList.push({
        id: this.nextId++,
        event: 'push',
        headBranch: name,
        headSha: commit,
        status: deleted ? 'completed' : 'queued',
        conclusion: deleted ? 'skipped' : null,
        createdAt: new Date(Math.floor(at.getTime() / 1000) * 1000),
        attempt: 1,
        deleted,
        jobs: deleted
          ? [
              { id: this.nextId++, name: 'build', status: 'completed', conclusion: 'skipped', annotations: [] },
              { id: this.nextId++, name: 'publish', status: 'completed', conclusion: 'skipped', annotations: [] },
            ]
          : [],
        outputs: {},
        log: [],
      })
    } else if (ref.startsWith('refs/heads/')) {
      const name = ref.slice('refs/heads/'.length)
      if (zero.test(newSha)) this.onBranchDeleted(name, false)
    }
  }

  /** @param {string | null} sha */
  async hasWorkflowAt(sha) {
    const at = sha ?? 'refs/heads/main'
    const r = await run('git', ['ls-tree', '--name-only', `${at}^{commit}`, '.github/workflows/'], { cwd: this.bare, allowFail: true })
    return r.code === 0 && r.stdout.trim().length > 0
  }

  /**
   * @param {string} name
   * @param {boolean} byMerge
   */
  onBranchDeleted(name, byMerge) {
    for (const p of this.pullList) {
      if (p.state !== 'open') continue
      if (p.head === name) p.state = 'closed'
      if (p.base === name) {
        if (byMerge) {
          p.timeline.push({ type: 'base_ref_changed', previousRefName: name, currentRefName: 'main' })
          p.base = 'main'
        } else {
          p.state = 'closed'
        }
      }
    }
  }

  /** @param {string} ref */
  async refSha(ref) {
    const r = await run('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: this.bare, allowFail: true })
    return r.code === 0 ? r.stdout.trim() : null
  }

  // --- the API used by the tool -----------------------------------------------------

  async serverTime() {
    await this.sync()
    return new Date(Math.floor(this.now().getTime() / 1000) * 1000)
  }

  async viewer() {
    return { login: this.login, scopes: this.scopes }
  }

  async repoInfo() {
    return { defaultBranch: 'main', visibility: 'public', deleteBranchOnMerge: this.settings.deleteBranchOnMerge, allowMergeCommit: this.settings.mergeCommitAllowed, empty: false }
  }

  async mergeRequirements() {
    const problems = []
    if (!this.settings.mergeCommitAllowed) problems.push('the repository does not allow merge commits')
    if (this.settings.mergeQueue) problems.push('main requires a merge queue, which the tool does not support')
    if (this.settings.linearHistory) problems.push('the branch protection of main requires a linear history')
    if (this.settings.rulesetMergeMethods && !this.settings.rulesetMergeMethods.includes('merge')) problems.push('the ruleset 1 does not allow merge commits')
    return { problems }
  }

  /** @param {number} pr */
  async canBypass(pr) {
    return this.settings.canBypass
  }

  /** @param {string} name */
  async branchSha(name) {
    await this.sync()
    return this.refSha(`refs/heads/${name}`)
  }

  /** @param {string} prefix */
  async branches(prefix) {
    await this.sync()
    const text = await git(this.bare, ['for-each-ref', '--format=%(refname:strip=2) %(objectname)', `refs/heads/${prefix}`])
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, sha] = l.split(' ')
        return { name, sha }
      })
  }

  /**
   * @param {string} name
   * @param {string} sha
   */
  async createBranch(name, sha) {
    this.mutate(`create ${name}`)
    if (await this.refSha(`refs/heads/${name}`)) throw new GitHubError('Reference already exists', 422, null)
    await git(this.bare, ['update-ref', `refs/heads/${name}`, sha])
  }

  /**
   * @param {string} name
   * @param {string} sha
   */
  async forceBranch(name, sha) {
    this.mutate(`move ${name}`)
    await git(this.bare, ['update-ref', `refs/heads/${name}`, sha])
  }

  /** @param {string} name */
  async deleteBranch(name) {
    this.mutate(`delete ${name}`)
    await this.sync()
    if (!(await this.refSha(`refs/heads/${name}`))) return false
    await git(this.bare, ['update-ref', '-d', `refs/heads/${name}`])
    this.onBranchDeleted(name, false)
    return true
  }

  /** @param {string} name */
  async tag(name) {
    await this.sync()
    const sha = await this.refSha(`refs/tags/${name}`)
    if (!sha) return null
    const type = await git(this.bare, ['cat-file', '-t', sha])
    if (type === 'commit') return { name, refSha: sha, annotated: false, commit: sha, taggerDate: null }
    const raw = await git(this.bare, ['cat-file', 'tag', sha])
    const [head, ...rest] = raw.split('\n\n')
    const tagger = /^tagger .* (\d+) [+-]\d{4}$/m.exec(head)
    const commit = await git(this.bare, ['rev-parse', `${sha}^{commit}`])
    return { name, refSha: sha, annotated: true, commit, message: `${rest.join('\n\n')}\n`, taggerDate: tagger ? new Date(Number(tagger[1]) * 1000) : null }
  }

  async tagRefs() {
    await this.sync()
    const text = await git(this.bare, ['for-each-ref', '--format=%(refname:strip=2) %(objectname) %(objecttype)', 'refs/tags/'])
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, sha, type] = l.split(' ')
        return { name, sha, type }
      })
  }

  /**
   * @param {string} name
   * @param {string} commit
   * @param {string} message
   * @param {boolean} force
   * @param {{ name: string, email: string, date: Date }} [tagger]
   */
  async createApiTag(name, commit, message, force = false, tagger) {
    this.mutate(`create the tag ${name} through the API`)
    await this.sync()
    const t = tagger ?? { name: this.login, email: `${this.login}@example.com`, date: this.now() }
    const content = `object ${commit}\ntype commit\ntag ${name}\ntagger ${t.name} <${t.email}> ${Math.floor(t.date.getTime() / 1000)} +0000\n\n${message}`
    const sha = (await run('git', ['mktag'], { cwd: this.bare, input: content })).stdout.trim()
    const old = await this.refSha(`refs/tags/${name}`)
    if (old && !force) throw new GitHubError('Reference already exists', 422, null)
    await git(this.bare, ['update-ref', `refs/tags/${name}`, sha])
    await this.onRefChange(`refs/tags/${name}`, old ?? '0'.repeat(40), sha, this.now())
    return sha
  }

  /** @param {string} name */
  async deleteTag(name) {
    this.mutate(`delete the tag ${name}`)
    const sha = await this.refSha(`refs/tags/${name}`)
    if (!sha) return false
    await git(this.bare, ['update-ref', '-d', `refs/tags/${name}`])
    await this.onRefChange(`refs/tags/${name}`, sha, '0'.repeat(40), this.now())
    return true
  }

  /**
   * @param {string} path
   * @param {string} ref
   */
  async file(path, ref) {
    const r = await run('git', ['show', `${ref}:${path}`], { cwd: this.bare, allowFail: true })
    return r.code === 0 ? r.stdout : null
  }

  /**
   * @param {string} path
   * @param {string} ref
   */
  async dir(path, ref) {
    const r = await run('git', ['ls-tree', '--name-only', `${ref}:${path}`], { cwd: this.bare, allowFail: true })
    return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : []
  }

  /** @param {{ parent: string, files: Record<string, string>, message: string }} o */
  async commitFiles(o) {
    this.mutate(`commit ${o.message}`)
    const dir = await mkdtemp(join(tmpdir(), 'fake-gh-index-'))
    const extraEnv = { GIT_INDEX_FILE: join(dir, 'index') }
    try {
      await git(this.bare, ['read-tree', o.parent], { extraEnv })
      for (const [path, content] of Object.entries(o.files)) {
        const blob = (await run('git', ['hash-object', '-w', '--stdin'], { cwd: this.bare, input: content })).stdout.trim()
        await git(this.bare, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { extraEnv })
      }
      const tree = await git(this.bare, ['write-tree'], { extraEnv })
      return await git(this.bare, ['commit-tree', tree, '-p', o.parent, '-m', o.message], {
        extraEnv: { GIT_AUTHOR_NAME: this.login, GIT_AUTHOR_EMAIL: `${this.login}@example.com`, GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com' },
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /**
   * @param {string} base
   * @param {string} head
   */
  async compare(base, head) {
    const b = await this.refSha(`${base}^{commit}`).catch(() => null) ?? (await this.refSha(`refs/heads/${base}`))
    const h = (await this.refSha(`${head}^{commit}`)) ?? (await this.refSha(`refs/heads/${head}`))
    if (!b || !h) throw new GitHubError('Not Found', 404, null)
    const anc = (/** @type {string} */ x, /** @type {string} */ y) => run('git', ['merge-base', '--is-ancestor', x, y], { cwd: this.bare, allowFail: true }).then((r) => r.code === 0)
    if (b === h) return { status: 'identical', aheadBy: 0, behindBy: 0 }
    if (await anc(b, h)) return { status: 'ahead', aheadBy: 1, behindBy: 0 }
    if (await anc(h, b)) return { status: 'behind', aheadBy: 0, behindBy: 1 }
    return { status: 'diverged', aheadBy: 1, behindBy: 1 }
  }

  // --- pull requests ------------------------------------------------------------------

  /** @param {any} p */
  async headOf(p) {
    if (p.state === 'open' || p.state === 'closed') {
      const sha = await this.refSha(`refs/heads/${p.head}`)
      if (sha && p.state === 'open') p.headSha = sha
    }
    return p.headSha
  }

  /** @param {any} p */
  async info(p) {
    await this.headOf(p)
    return {
      number: p.number,
      state: p.state,
      headRef: p.head,
      headSha: p.headSha,
      baseRef: p.base,
      title: p.title,
      url: `https://github.com/${this.repo}/pull/${p.number}`,
      mergedBy: p.mergedBy ?? null,
      mergeCommit: p.mergeCommit ?? null,
    }
  }

  /** @param {{ head?: string, base?: string, state?: string }} f */
  async pulls(f) {
    await this.sync()
    const out = []
    for (const p of this.pullList) {
      if (f.head && p.head !== f.head) continue
      if (f.base && p.base !== f.base) continue
      const st = f.state ?? 'open'
      if (st === 'open' && p.state !== 'open') continue
      if (st === 'closed' && p.state === 'open') continue
      out.push(await this.info(p))
    }
    return out
  }

  /** @param {any} p */
  async status(p) {
    const head = await this.headOf(p)
    const base = await this.refSha(`refs/heads/${p.base}`)
    if (!base) return { state: 'DIRTY', decision: null }
    const mt = await run('git', ['merge-tree', '--write-tree', base, head], { cwd: this.bare, allowFail: true })
    const approved = p.approvals.some((/** @type {any} */ a) => !this.settings.dismissStale || a.sha === head)
    const decision = this.settings.requireApproval ? (approved ? 'APPROVED' : 'REVIEW_REQUIRED') : null
    if (mt.code === 1) return { state: 'DIRTY', decision }
    const upToDate = (await run('git', ['merge-base', '--is-ancestor', base, head], { cwd: this.bare, allowFail: true })).code === 0
    if (p.base === 'main' && this.settings.requireApproval && !approved) return { state: 'BLOCKED', decision }
    if (p.base === 'main' && this.settings.strict && !upToDate) return { state: 'BEHIND', decision }
    return { state: 'CLEAN', decision }
  }

  /** @param {number} number */
  async pull(number) {
    await this.sync()
    const p = this.pullList.find((x) => x.number === number)
    if (!p) throw new GitHubError('Not Found', 404, null)
    const info = await this.info(p)
    const s = p.state === 'open' ? await this.status(p) : { state: 'UNKNOWN', decision: null }
    return {
      ...info,
      mergeStateStatus: s.state,
      reviewDecision: s.decision,
      viewerCanMergeAsAdmin: this.settings.canBypass,
      approvedBy: p.approvals.map((/** @type {any} */ a) => a.login),
    }
  }

  /** @param {number} number */
  async pullRest(number) {
    await this.sync()
    const p = this.pullList.find((x) => x.number === number)
    if (!p) throw new GitHubError('Not Found', 404, null)
    return this.info(p)
  }

  /** @param {{ head: string, base: string, title: string, body: string }} o */
  async createPull(o) {
    this.mutate(`open ${o.title}`)
    await this.sync()
    if (this.pullList.some((p) => p.state === 'open' && p.head === o.head && p.base === o.base)) throw new GitHubError('A pull request already exists', 422, null)
    const headSha = await this.refSha(`refs/heads/${o.head}`)
    if (!headSha) throw new GitHubError('head does not exist', 422, null)
    const p = { number: this.nextId++, state: 'open', head: o.head, base: o.base, title: o.title, body: o.body, headSha, approvals: [], timeline: [], author: this.login }
    this.pullList.push(p)
    return this.info(p)
  }

  /**
   * @param {number} number
   * @param {{ base?: string, state?: string, title?: string, body?: string }} c
   */
  async updatePull(number, c) {
    this.mutate(`update #${number}`)
    const p = this.pullList.find((x) => x.number === number)
    if (!p) throw new GitHubError('Not Found', 404, null)
    if (c.base) p.base = c.base
    if (c.state === 'closed' && p.state === 'open') p.state = 'closed'
    if (c.state === 'open' && p.state === 'closed') {
      if (!(await this.refSha(`refs/heads/${p.head}`))) throw new GitHubError('head branch is gone', 422, null)
      p.state = 'open'
    }
    if (c.title) p.title = c.title
    if (c.body) p.body = c.body
  }

  /**
   * @param {number} number
   * @param {string} body
   */
  async comment(number, body) {
    this.mutate(`comment #${number}`)
    const p = this.pullList.find((x) => x.number === number)
    if (p) p.timeline.push({ type: 'comment', body })
  }

  /**
   * @param {number} number
   * @param {{ sha: string, title: string }} o
   */
  async mergePull(number, o) {
    this.mutate(`merge #${number}`)
    await this.sync()
    const p = this.pullList.find((x) => x.number === number)
    if (!p || p.state !== 'open') return { merged: false, reason: 'not-mergeable', message: 'not open' }
    const head = await this.headOf(p)
    if (head !== o.sha) return { merged: false, reason: 'head-changed', message: 'Head branch was modified' }
    const s = await this.status(p)
    if (s.state === 'DIRTY' || s.state === 'BEHIND') return { merged: false, reason: 'not-mergeable', message: s.state }
    if (s.state === 'BLOCKED' && !this.settings.canBypass) return { merged: false, reason: 'not-mergeable', message: 'review required' }
    const sha = await this.mergeInto(p, 'merge', o.title)
    return { merged: true, sha }
  }

  /**
   * Merges a pull request (also used by tests to merge "by hand").
   * @param {any} p
   * @param {'merge' | 'squash' | 'rebase'} method
   * @param {string} title
   * @param {string} [by]
   */
  async mergeInto(p, method, title, by) {
    const head = await this.headOf(p)
    const base = /** @type {string} */ (await this.refSha(`refs/heads/${p.base}`))
    const mt = await run('git', ['merge-tree', '--write-tree', base, head], { cwd: this.bare, allowFail: true })
    if (mt.code !== 0) throw new Error(`fake merge conflict in #${p.number}`)
    const tree = mt.stdout.split('\n')[0].trim()
    const env = { GIT_AUTHOR_NAME: by ?? this.login, GIT_AUTHOR_EMAIL: `${by ?? this.login}@example.com`, GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com' }
    let sha
    if (method === 'merge') sha = await git(this.bare, ['commit-tree', tree, '-p', base, '-p', head, '-m', title], { extraEnv: env })
    else sha = await git(this.bare, ['commit-tree', tree, '-p', base, '-m', `${title} (#${p.number})`], { extraEnv: env })
    await git(this.bare, ['update-ref', `refs/heads/${p.base}`, sha, base])
    p.state = 'merged'
    p.mergedBy = by ?? this.login
    p.mergeCommit = sha
    p.headSha = head
    if (this.settings.deleteBranchOnMerge && p.head !== 'main') {
      await git(this.bare, ['update-ref', '-d', `refs/heads/${p.head}`])
      this.onBranchDeleted(p.head, true)
    }
    return sha
  }

  /** @param {string} branch */
  async retargetedFrom(branch) {
    return this.pullList
      .filter((p) => p.state === 'open' && p.base === 'main' && p.timeline.some((/** @type {any} */ e) => e.type === 'base_ref_changed' && e.previousRefName === branch))
      .map((p) => ({ number: p.number, url: `https://github.com/${this.repo}/pull/${p.number}`, title: p.title }))
  }

  // --- releases --------------------------------------------------------------------------

  /** @param {any} r */
  releaseInfo(r) {
    return {
      id: r.id,
      tagName: r.tagName,
      name: r.name,
      draft: r.draft,
      prerelease: r.prerelease,
      body: r.body,
      targetCommitish: r.targetCommitish,
      url: `https://github.com/${this.repo}/releases/tag/${r.tagName}`,
      createdAt: r.createdAt.toISOString(),
      assets: r.assets.map((/** @type {any} */ a) => ({ id: a.id, name: a.name, url: `https://github.com/${this.repo}/releases/download/${r.tagName}/${a.name}` })),
    }
  }

  async releases() {
    await this.sync()
    return this.releaseList.filter((r) => this.canSeeDrafts || !r.draft).map((r) => this.releaseInfo(r))
  }

  get canSeeDrafts() {
    return this.draftsVisible !== false
  }

  /** @param {string} tag */
  async releaseByTag(tag) {
    const r = this.releaseList.find((x) => x.tagName === tag && !x.draft)
    return r ? this.releaseInfo(r) : null
  }

  async latestRelease() {
    const r = this.releaseList.find((x) => x.id === this.latestReleaseId && !x.draft)
    return r ? this.releaseInfo(r) : null
  }

  /** @param {{ tag: string, name: string, body: string, prerelease: boolean, latest: boolean, commit: string }} o */
  async createRelease(o) {
    this.mutate(`create release ${o.tag}`)
    await this.sync()
    if (this.releaseList.some((r) => r.tagName === o.tag)) throw new GitHubError('Validation Failed: already_exists', 422, null)
    if (!(await this.refSha(`refs/tags/${o.tag}`))) await git(this.bare, ['update-ref', `refs/tags/${o.tag}`, o.commit])
    const r = { id: this.nextId++, tagName: o.tag, name: o.name, body: o.body, draft: false, prerelease: o.prerelease, targetCommitish: o.commit, createdAt: this.now(), assets: [] }
    this.releaseList.push(r)
    if (!o.prerelease && o.latest) this.latestReleaseId = r.id
    return this.releaseInfo(r)
  }

  /**
   * @param {number} id
   * @param {{ tag: string, prerelease: boolean, latest: boolean, commit: string }} o
   */
  async publishDraft(id, o) {
    this.mutate(`publish draft ${o.tag}`)
    const r = this.releaseList.find((x) => x.id === id)
    if (!r) throw new GitHubError('Not Found', 404, null)
    if (!(await this.refSha(`refs/tags/${o.tag}`))) await git(this.bare, ['update-ref', `refs/tags/${o.tag}`, o.commit])
    r.draft = false
    r.tagName = o.tag
    r.prerelease = o.prerelease
    if (!o.prerelease && o.latest) this.latestReleaseId = r.id
    return this.releaseInfo(r)
  }

  /** @param {number} id */
  async deleteRelease(id) {
    this.mutate(`delete release ${id}`)
    this.releaseList = this.releaseList.filter((r) => r.id !== id)
  }

  /**
   * @param {number} id
   * @param {string} file
   */
  async uploadAsset(id, file) {
    this.mutate(`upload ${file}`)
    const r = this.releaseList.find((x) => x.id === id)
    const a = { id: this.nextId++, name: basename(file), data: await readFile(file) }
    r.assets.push(a)
    return `https://github.com/${this.repo}/releases/download/${r.tagName}/${a.name}`
  }

  /**
   * @param {number} releaseId
   * @param {number} assetId
   */
  async downloadAsset(releaseId, assetId) {
    const r = this.releaseList.find((x) => x.id === releaseId)
    return r.assets.find((/** @type {any} */ a) => a.id === assetId).data
  }

  // --- actions ---------------------------------------------------------------------------

  /** @param {any} r */
  runInfo(r) {
    return { id: r.id, status: r.status, conclusion: r.conclusion, headSha: r.headSha, headBranch: r.headBranch, event: r.event, createdAt: r.createdAt, attempt: r.attempt, url: `https://github.com/${this.repo}/actions/runs/${r.id}` }
  }

  /**
   * @param {string} workflow
   * @param {string} tag
   */
  async tagRuns(workflow, tag) {
    await this.sync()
    await this.pump()
    return this.runList.filter((r) => r.headBranch === tag).map((r) => this.runInfo(r)).reverse()
  }

  /** @param {string} workflow */
  async workflowRuns(workflow) {
    await this.sync()
    await this.pump()
    return this.runList.map((r) => this.runInfo(r)).reverse()
  }

  /** @param {number} id */
  async run(id) {
    const r = this.runList.find((x) => x.id === id)
    if (!r) throw new GitHubError('Not Found', 404, null)
    return this.runInfo(r)
  }

  /** @param {number} runId */
  async jobs(runId) {
    const r = this.runList.find((x) => x.id === runId)
    return (r?.jobs ?? []).map((/** @type {any} */ j) => ({ id: j.id, name: j.name, status: j.status, conclusion: j.conclusion }))
  }

  /** @param {number} jobId */
  async annotations(jobId) {
    for (const r of this.runList) for (const j of r.jobs) if (j.id === jobId) return j.annotations
    return []
  }

  /** @param {number} id */
  async cancelRun(id) {
    this.mutate(`cancel ${id}`)
    const r = this.runList.find((x) => x.id === id)
    if (r && r.status !== 'completed') {
      r.status = 'completed'
      r.conclusion = 'cancelled'
    }
  }

  /** @param {number} id */
  async deleteRun(id) {
    this.mutate(`delete run ${id}`)
    this.runList = this.runList.filter((r) => r.id !== id)
  }

  /** @param {number} id */
  async rerunFailed(id) {
    this.mutate(`rerun ${id}`)
    const r = this.runList.find((x) => x.id === id)
    if (!r || r.status !== 'completed' || r.conclusion === 'success') throw new GitHubError('cannot re-run', 403, null)
    r.attempt++
    r.status = 'queued'
    r.conclusion = null
    r.rerun = true
  }

  /** @param {number} runId */
  async artifacts(runId) {
    const r = this.runList.find((x) => x.id === runId)
    return r?.artifactDir ? [{ name: 'release-tools', expired: this.artifactsExpired }] : []
  }

  /** @param {number} runId */
  async failedLog(runId) {
    const r = this.runList.find((x) => x.id === runId)
    return (r?.log ?? []).join('\n')
  }

  // --- running workflows --------------------------------------------------------------------

  /** Runs all queued runs in order (FIFO), unless autoRun is off. */
  async pump() {
    if (!this.autoRun || this.pumping) return
    await this.sync()
    this.pumping = true
    try {
      for (;;) {
        const next = this.runList.find((r) => r.status === 'queued' && !r.hold)
        if (!next) break
        await this.execute(next)
      }
    } finally {
      this.pumping = false
    }
  }

  /**
   * Executes a run with the real action: build job (validate, build), then publish job.
   * @param {any} r
   */
  async execute(r) {
    if (this.beforeRun) this.beforeRun(r)
    r.status = 'in_progress'
    const guard = this.guard
    this.guard = { mutate() {} }
    try {
      await this.executeJobs(r)
    } finally {
      this.guard = guard
      this.draftsVisible = true
    }
  }

  /** @param {any} r */
  async executeJobs(r) {
    const temp = await mkdtemp(join(this.tmp ?? tmpdir(), `fake-run-${r.id}-`))
    const log = (/** @type {string} */ m) => r.log.push(m)
    const makeEnv = (/** @type {any} */ job, /** @type {string} */ workspace, /** @type {boolean} */ drafts) => {
      /** @type {any} */
      const view = this
      view.draftsVisible = drafts
      return {
        repo: this.repo,
        sha: r.headSha,
        tagName: r.headBranch,
        runId: String(r.id),
        runAttempt: String(r.attempt),
        workspace,
        temp,
        gh: view,
        registry: (/** @type {any} */ settings) => (settings.publish === 'npm' ? this.registry : null),
        output: (/** @type {string} */ k, /** @type {string} */ v) => {
          job.outputs[k] = v
        },
        summary: (/** @type {string} */ md) => log(md),
        annotate: (/** @type {string} */ level, /** @type {string} */ code, /** @type {string} */ message) => {
          job.annotations.push({ title: 'release-tools', message: `${code}: ${message}`, level })
          log(`${level}: ${code}: ${message}`)
        },
        log,
        env: this.env,
        npmPublish: async (/** @type {{ file: string, tag: string }} */ o) => this.registry.publish(r.headBranch, await readFile(o.file), o.tag, r.headSha),
      }
    }
    try {
      let build = r.jobs.find((/** @type {any} */ j) => j.name === 'build')
      if (!build || build.conclusion !== 'success') {
        r.jobs = r.jobs.filter((/** @type {any} */ j) => j.name !== 'build' && j.name !== 'publish')
        build = { id: this.nextId++, name: 'build', status: 'in_progress', conclusion: null, annotations: [], outputs: {} }
        r.jobs.push(build)
        const ws = join(temp, 'ws')
        await run('git', ['clone', '--quiet', this.bare, ws])
        await run('git', ['checkout', '--quiet', '--detach', r.headSha], { cwd: ws })
        const env = makeEnv(build, ws, false)
        const artifactDir = join(temp, 'artifact')
        let res = await runMode('validate', env, { artifactDir })
        if (res.ok && build.outputs.release === 'true') {
          res = await runMode('build', env, { artifactDir, statePath: build.outputs['state-file'] })
          if (res.ok) {
            r.artifactDir = join(temp, 'kept-artifact')
            await run('cp', ['-r', artifactDir, r.artifactDir])
          }
        }
        build.status = 'completed'
        build.conclusion = res.ok ? 'success' : 'failure'
      }
      let conclusion = build.conclusion
      if (this.betweenJobs) await this.betweenJobs(r)
      if (build.conclusion === 'success' && build.outputs.release === 'true') {
        const old = r.jobs.find((/** @type {any} */ j) => j.name === 'publish')
        if (!old || old.conclusion !== 'success') {
          r.jobs = r.jobs.filter((/** @type {any} */ j) => j.name !== 'publish')
          const publish = { id: this.nextId++, name: 'publish', status: 'in_progress', conclusion: null, annotations: [], outputs: {} }
          r.jobs.push(publish)
          const env = makeEnv(publish, temp, true)
          const res = await runMode('publish', env, {
            artifactDir: r.artifactDir,
            tagObject: build.outputs['tag-object'],
            tarballSha512: build.outputs['tarball-sha512'],
          })
          publish.status = 'completed'
          publish.conclusion = res.ok ? 'success' : 'failure'
          conclusion = publish.conclusion
        } else {
          conclusion = 'success'
        }
      } else if (build.conclusion === 'success') {
        r.jobs.push({ id: this.nextId++, name: 'publish', status: 'completed', conclusion: 'skipped', annotations: [], outputs: {} })
      }
      r.status = 'completed'
      r.conclusion = conclusion
      if (this.afterRun) await this.afterRun(r)
    } catch (e) {
      r.status = 'completed'
      r.conclusion = 'failure'
      log(String(e?.stack ?? e))
    }
  }

  // --- helpers for tests ----------------------------------------------------------------------

  /**
   * @param {number} number
   * @param {string} login
   */
  async approve(number, login = 'colleague') {
    const p = this.pullList.find((x) => x.number === number)
    p.approvals.push({ login, sha: await this.headOf(p) })
  }

  /** @param {string} head */
  openPull(head) {
    return this.pullList.find((p) => p.head === head && p.state === 'open')
  }
}

