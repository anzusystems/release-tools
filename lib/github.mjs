// @ts-check
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { run } from './exec.mjs'
import { ReleaseError, sleep, pollMs } from './util.mjs'

/**
 * @typedef {object} TagInfo a tag on GitHub, peeled to its commit
 * @property {string} name
 * @property {string} refSha sha the ref points to (tag object for an annotated tag)
 * @property {boolean} annotated
 * @property {string} commit
 * @property {string} [message]
 * @property {Date | null} taggerDate
 */

/**
 * @typedef {object} PullInfo
 * @property {number} number
 * @property {'open' | 'closed' | 'merged'} state
 * @property {string} headRef
 * @property {string} headSha
 * @property {string} baseRef
 * @property {string} title
 * @property {string} url
 * @property {string | null} mergedBy
 * @property {string | null} mergeCommit
 * @property {string | null} [mergeStateStatus]
 * @property {string | null} [reviewDecision]
 * @property {boolean} [viewerCanMergeAsAdmin]
 * @property {string[]} [approvedBy]
 */

/**
 * @typedef {object} ReleaseInfo
 * @property {number} id
 * @property {string} tagName
 * @property {string} name
 * @property {boolean} draft
 * @property {boolean} prerelease
 * @property {string} body
 * @property {string} targetCommitish
 * @property {string} url
 * @property {string} createdAt
 * @property {{ id: number, name: string, url: string }[]} assets
 */

/**
 * @typedef {object} RunInfo
 * @property {number} id
 * @property {string} status queued | in_progress | completed | waiting | pending | requested
 * @property {string | null} conclusion
 * @property {string} headSha
 * @property {string} headBranch
 * @property {string} event
 * @property {Date} createdAt
 * @property {number} attempt
 * @property {string} url
 */

/**
 * @typedef {object} JobInfo
 * @property {number} id
 * @property {string} name
 * @property {string} status
 * @property {string | null} conclusion
 */

export class GitHubError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {any} data
   */
  constructor(message, status, data) {
    super(message)
    this.name = 'GitHubError'
    this.status = status
    this.data = data
  }
}

/**
 * The GitHub REST and GraphQL API with a token. The CLI takes the token from `gh auth token`, the action from
 * GITHUB_TOKEN. Every request is retried on network errors, 5xx and rate limits.
 */
export class GitHub {
  /**
   * @param {{ token: string, repo: string, apiUrl?: string, guard?: import('./git.mjs').Guard }} o
   */
  constructor(o) {
    this.token = o.token
    this.repo = o.repo
    const [owner, name] = o.repo.split('/')
    this.owner = owner
    this.name = name
    this.apiUrl = (o.apiUrl ?? process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '')
    this.guard = o.guard ?? { mutate() {} }
    /** @type {Date | null} */
    this.lastServerDate = null
  }

  /**
   * @param {string} method
   * @param {string} path absolute URL or a path below the API
   * @param {{ body?: any, raw?: Buffer, contentType?: string, allow404?: boolean, accept?: string, retries?: number }} [o]
   * @returns {Promise<{ status: number, headers: Headers, data: any }>}
   */
  async request(method, path, o = {}) {
    const url = path.startsWith('http') ? path : `${this.apiUrl}${path.startsWith('/') ? '' : '/'}${path}`
    const attempts = o.retries ?? 8
    let lastError
    for (let i = 0; i < attempts; i++) {
      let res
      try {
        res = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: o.accept ?? 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': 'anzusystems-release-tools',
            ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(o.raw ? { 'content-type': o.contentType ?? 'application/octet-stream' } : {}),
            'cache-control': 'no-cache',
          },
          body: o.raw ? new Uint8Array(o.raw) : o.body !== undefined ? JSON.stringify(o.body) : undefined,
        })
      } catch (e) {
        lastError = e
        await sleep(Math.min(30000, pollMs(1000) * 2 ** i))
        continue
      }
      const date = res.headers.get('date')
      if (date) this.lastServerDate = new Date(date)
      const text = await res.text()
      let data = null
      if (text) {
        try {
          data = JSON.parse(text)
        } catch {
          data = text
        }
      }
      const rateLimited =
        res.status === 429 ||
        (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(String(data?.message ?? ''))))
      if (res.status >= 500 || rateLimited) {
        lastError = new GitHubError(`${method} ${path}: ${res.status} ${data?.message ?? ''}`, res.status, data)
        const retryAfter = Number(res.headers.get('retry-after'))
        const reset = Number(res.headers.get('x-ratelimit-reset'))
        let wait = Math.min(60000, pollMs(1000) * 2 ** i)
        if (retryAfter) wait = retryAfter * 1000
        else if (rateLimited && reset) wait = Math.max(1000, reset * 1000 - Date.now())
        await sleep(Math.min(wait, 15 * 60 * 1000))
        continue
      }
      if (res.status === 404 && o.allow404) return { status: 404, headers: res.headers, data: null }
      if (res.status >= 400) {
        const detail = data?.errors ? ` ${JSON.stringify(data.errors)}` : ''
        throw new GitHubError(`${method} ${path}: ${res.status} ${data?.message ?? text}${detail}`, res.status, data)
      }
      return { status: res.status, headers: res.headers, data }
    }
    throw lastError
  }

  /**
   * @param {string} path
   * @returns {Promise<any[]>}
   */
  async paginate(path, key = null) {
    const items = []
    let url = `${this.apiUrl}${path}${path.includes('?') ? '&' : '?'}per_page=100`
    while (url) {
      const r = await this.request('GET', url)
      const page = key ? r.data[key] : r.data
      items.push(...(page ?? []))
      const link = r.headers.get('link') ?? ''
      const next = /<([^>]+)>;\s*rel="next"/.exec(link)
      url = next ? next[1] : null
    }
    return items
  }

  /**
   * @param {string} query
   * @param {Record<string, any>} variables
   */
  async graphql(query, variables = {}) {
    const url = this.apiUrl.endsWith('/api/v3') ? this.apiUrl.replace(/\/v3$/, '/graphql') : `${this.apiUrl}/graphql`
    const r = await this.request('POST', url, { body: { query, variables } })
    if (r.data?.errors?.length) throw new GitHubError(`GraphQL: ${r.data.errors.map((e) => e.message).join('; ')}`, 200, r.data)
    return r.data.data
  }

  /** @param {string} action */
  mutate(action) {
    this.guard.mutate(action)
  }

  get base() {
    return `/repos/${this.owner}/${this.name}`
  }

  // --- time, user, repository ------------------------------------------------

  /** Time of the GitHub server from the Date header of a fresh response (second precision). */
  async serverTime() {
    const r = await this.request('GET', '/rate_limit')
    const date = r.headers.get('date')
    if (!date) throw new Error('GitHub sent no Date header')
    return new Date(date)
  }

  /** @returns {Promise<{ login: string, scopes: string[] | null }>} */
  async viewer() {
    const r = await this.request('GET', '/user')
    const scopes = r.headers.get('x-oauth-scopes')
    return { login: r.data.login, scopes: scopes === null ? null : scopes.split(',').map((s) => s.trim()).filter(Boolean) }
  }

  async repoInfo() {
    const r = await this.request('GET', this.base)
    return {
      defaultBranch: r.data.default_branch,
      visibility: r.data.visibility,
      deleteBranchOnMerge: !!r.data.delete_branch_on_merge,
      allowMergeCommit: r.data.allow_merge_commit !== false,
      empty: r.data.size === 0,
    }
  }

  /**
   * Whether merge commits into main are allowed, in all three layers, and whether a merge queue is required.
   * @returns {Promise<{ problems: string[] }>}
   */
  async mergeRequirements() {
    const problems = []
    const q = await this.graphql(
      `query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          mergeCommitAllowed
          mergeQueue(branch: "main") { id }
          ref(qualifiedName: "refs/heads/main") {
            branchProtectionRule { requiresLinearHistory }
            refUpdateRule { requiresLinearHistory }
          }
        }
      }`,
      { owner: this.owner, name: this.name },
    )
    const repo = q.repository
    if (!repo.mergeCommitAllowed) problems.push('the repository does not allow merge commits (Settings → General → Allow merge commits)')
    if (repo.mergeQueue) problems.push('main requires a merge queue, which the tool does not support')
    const classic = repo.ref?.branchProtectionRule ?? repo.ref?.refUpdateRule
    if (classic?.requiresLinearHistory) problems.push('the branch protection of main requires a linear history')
    const rules = await this.paginate(`${this.base}/rules/branches/main`)
    for (const rule of rules) {
      if (rule.type === 'required_linear_history') problems.push(`the ruleset ${rule.ruleset_id} requires a linear history on main`)
      if (rule.type === 'merge_queue') problems.push(`the ruleset ${rule.ruleset_id} requires a merge queue on main`)
      if (rule.type === 'pull_request') {
        const methods = rule.parameters?.allowed_merge_methods
        if (Array.isArray(methods) && !methods.includes('merge')) {
          problems.push(`the ruleset ${rule.ruleset_id} does not allow merge commits for pull requests into main`)
        }
      }
    }
    return { problems }
  }

  /**
   * Whether the user may bypass the rules of main for a pull request: `viewerCanMergeAsAdmin` for a classic
   * branch protection (if any) and `current_user_can_bypass` of every ruleset for main.
   * @param {number} pr
   */
  async canBypass(pr) {
    const q = await this.graphql(
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) { viewerCanMergeAsAdmin }
          ref(qualifiedName: "refs/heads/main") {
            branchProtectionRule { id }
            refUpdateRule { requiresLinearHistory }
          }
        }
      }`,
      { owner: this.owner, name: this.name, number: pr },
    )
    const repo = q.repository
    const classic = !!(repo.ref?.branchProtectionRule || repo.ref?.refUpdateRule)
    if (classic && !repo.pullRequest?.viewerCanMergeAsAdmin) return false
    const rules = await this.paginate(`${this.base}/rules/branches/main`)
    const ids = [...new Set(rules.map((r) => r.ruleset_id).filter(Boolean))]
    for (const id of ids) {
      const rs = (await this.request('GET', `${this.base}/rulesets/${id}?includes_parents=true`)).data
      if (!['always', 'pull_requests_only', 'exempt'].includes(rs?.current_user_can_bypass)) return false
    }
    return true
  }

  /**
   * Whether GitHub links commits with this author e-mail in the repository to an account: true, false, or null
   * when there is no such commit to tell.
   * @param {string} email
   * @returns {Promise<boolean | null>}
   */
  async emailLinked(email) {
    const q = encodeURIComponent(`repo:${this.repo} author-email:${email}`)
    const r = await this.request('GET', `/search/commits?q=${q}&per_page=5`, { retries: 2 }).catch(() => null)
    const items = r?.data?.items ?? []
    if (!items.length) return null
    return items.some((/** @type {any} */ i) => i.author)
  }

  // --- refs --------------------------------------------------------------------

  /**
   * @param {string} name
   * @returns {Promise<string | null>}
   */
  async branchSha(name) {
    const r = await this.request('GET', `${this.base}/git/ref/heads/${encodeRef(name)}`, { allow404: true })
    if (r.status === 404 || !r.data?.object) return null
    if (r.data.ref !== `refs/heads/${name}`) return null
    return r.data.object.sha
  }

  /**
   * Branches on GitHub whose name starts with the prefix (e.g. `release/`).
   * @param {string} prefix
   * @returns {Promise<{ name: string, sha: string }[]>}
   */
  async branches(prefix) {
    const refs = await this.paginate(`${this.base}/git/matching-refs/heads/${encodeRef(prefix)}`)
    return refs.filter((r) => r.object?.type === 'commit').map((r) => ({ name: r.ref.replace(/^refs\/heads\//, ''), sha: r.object.sha }))
  }

  /**
   * @param {string} name
   * @param {string} sha
   */
  async createBranch(name, sha) {
    this.mutate(`create the branch ${name} on GitHub`)
    await this.request('POST', `${this.base}/git/refs`, { body: { ref: `refs/heads/${name}`, sha } })
  }

  /**
   * @param {string} name
   * @param {string} sha
   */
  async forceBranch(name, sha) {
    this.mutate(`move the branch ${name} on GitHub`)
    await this.request('PATCH', `${this.base}/git/refs/heads/${encodeRef(name)}`, { body: { sha, force: true } })
  }

  /** @param {string} name */
  async deleteBranch(name) {
    this.mutate(`delete the branch ${name} on GitHub`)
    const r = await this.request('DELETE', `${this.base}/git/refs/heads/${encodeRef(name)}`, { allow404: true }).catch((e) => {
      if (e.status === 422) return { status: 404 }
      throw e
    })
    return r.status !== 404
  }

  /**
   * @param {string} name
   * @returns {Promise<TagInfo | null>}
   */
  async tag(name) {
    const r = await this.request('GET', `${this.base}/git/ref/tags/${encodeRef(name)}`, { allow404: true })
    if (r.status === 404 || !r.data?.object || r.data.ref !== `refs/tags/${name}`) return null
    return this.peel(name, r.data.object.sha, r.data.object.type)
  }

  /**
   * @param {string} name
   * @param {string} sha
   * @param {string} type
   * @returns {Promise<TagInfo>}
   */
  async peel(name, sha, type) {
    if (type === 'commit') return { name, refSha: sha, annotated: false, commit: sha, taggerDate: null }
    let objSha = sha
    let objType = type
    let message
    let taggerDate = null
    for (let depth = 0; objType === 'tag' && depth < 10; depth++) {
      const t = (await this.request('GET', `${this.base}/git/tags/${objSha}`)).data
      if (depth === 0) {
        message = t.message
        taggerDate = t.tagger?.date ? new Date(t.tagger.date) : null
      }
      objSha = t.object.sha
      objType = t.object.type
    }
    if (objType !== 'commit') throw new ReleaseError(`the tag ${name} does not point to a commit`)
    return { name, refSha: sha, annotated: true, commit: objSha, message, taggerDate }
  }

  /** @returns {Promise<{ name: string, sha: string, type: string }[]>} */
  async tagRefs() {
    const refs = await this.paginate(`${this.base}/git/matching-refs/tags/`)
    return refs.map((r) => ({ name: r.ref.replace(/^refs\/tags\//, ''), sha: r.object.sha, type: r.object.type }))
  }

  /** @param {string} name */
  async deleteTag(name) {
    this.mutate(`delete the tag ${name} on GitHub`)
    const r = await this.request('DELETE', `${this.base}/git/refs/tags/${encodeRef(name)}`, { allow404: true }).catch((e) => {
      if (e.status === 422) return { status: 404 }
      throw e
    })
    return r.status !== 404
  }

  /**
   * An annotated tag created through the API: the mock registry, and the tag of a released commit that is not in
   * the local repository. force: replace an existing tag ref.
   * @param {string} name
   * @param {string} commit
   * @param {string} message
   * @param {boolean} force
   * @param {{ name: string, email: string, date: Date }} [tagger]
   */
  async createApiTag(name, commit, message, force = false, tagger) {
    this.mutate(`create the tag ${name} on GitHub`)
    const body = { tag: name, message, object: commit, type: 'commit', ...(tagger ? { tagger: { name: tagger.name || 'release-tools', email: tagger.email, date: tagger.date.toISOString() } } : {}) }
    const obj = (await this.request('POST', `${this.base}/git/tags`, { body })).data
    if (force) {
      const r = await this.request('PATCH', `${this.base}/git/refs/tags/${encodeRef(name)}`, { body: { sha: obj.sha, force: true }, allow404: true }).catch(
        (e) => {
          if (e.status === 422) return { status: 404 }
          throw e
        },
      )
      if (r.status !== 404) return obj.sha
    }
    await this.request('POST', `${this.base}/git/refs`, { body: { ref: `refs/tags/${name}`, sha: obj.sha } })
    return obj.sha
  }

  // --- contents and commits through the API ---------------------------------------

  /**
   * @param {string} path
   * @param {string} ref
   * @returns {Promise<string | null>}
   */
  async file(path, ref) {
    const r = await this.request('GET', `${this.base}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, {
      allow404: true,
    })
    if (r.status === 404 || !r.data || Array.isArray(r.data)) return null
    if (r.data.encoding === 'base64') return Buffer.from(r.data.content, 'base64').toString('utf8')
    if (r.data.download_url) {
      const raw = await this.request('GET', r.data.download_url, { accept: 'application/vnd.github.raw' })
      return typeof raw.data === 'string' ? raw.data : JSON.stringify(raw.data)
    }
    return null
  }

  /**
   * @param {string} path
   * @param {string} ref
   * @returns {Promise<string[]>}
   */
  async dir(path, ref) {
    const r = await this.request('GET', `${this.base}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, {
      allow404: true,
    })
    if (r.status === 404 || !Array.isArray(r.data)) return []
    return r.data.filter((e) => e.type === 'file').map((e) => e.name)
  }

  /**
   * One commit on top of `parent` with files replaced.
   * @param {{ parent: string, files: Record<string, string>, message: string }} o
   * @returns {Promise<string>} commit sha
   */
  async commitFiles(o) {
    this.mutate(`create a commit "${o.message}" on GitHub`)
    const parentCommit = (await this.request('GET', `${this.base}/git/commits/${o.parent}`)).data
    const tree = (
      await this.request('POST', `${this.base}/git/trees`, {
        body: {
          base_tree: parentCommit.tree.sha,
          tree: Object.entries(o.files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
        },
      })
    ).data
    const commit = (await this.request('POST', `${this.base}/git/commits`, { body: { message: o.message, tree: tree.sha, parents: [o.parent] } })).data
    return commit.sha
  }

  /**
   * @param {string} base
   * @param {string} head
   * @returns {Promise<{ status: string, aheadBy: number, behindBy: number }>}
   */
  async compare(base, head) {
    const r = await this.request('GET', `${this.base}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`)
    return { status: r.data.status, aheadBy: r.data.ahead_by, behindBy: r.data.behind_by }
  }

  // --- pull requests -------------------------------------------------------------

  /**
   * @param {any} p REST pull request
   * @returns {PullInfo}
   */
  static pullFromRest(p) {
    return {
      number: p.number,
      state: p.merged_at ? 'merged' : p.state === 'open' ? 'open' : 'closed',
      headRef: p.head?.ref,
      headSha: p.head?.sha,
      baseRef: p.base?.ref,
      title: p.title,
      url: p.html_url,
      mergedBy: p.merged_by?.login ?? null,
      mergeCommit: p.merge_commit_sha && p.merged_at ? p.merge_commit_sha : null,
    }
  }

  /**
   * @param {{ head?: string, base?: string, state?: 'open' | 'closed' | 'all' }} f
   * @returns {Promise<PullInfo[]>}
   */
  async pulls(f) {
    const params = new URLSearchParams()
    params.set('state', f.state ?? 'open')
    if (f.head) params.set('head', `${this.owner}:${f.head}`)
    if (f.base) params.set('base', f.base)
    const list = await this.paginate(`${this.base}/pulls?${params}`)
    return list.map((p) => GitHub.pullFromRest(p))
  }

  /**
   * @param {number} number
   * @returns {Promise<PullInfo>}
   */
  async pull(number) {
    for (let i = 0; ; i++) {
      const q = await this.graphql(
        `query($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              number state merged url title
              headRefName headRefOid baseRefName
              mergedBy { login }
              mergeCommit { oid }
              mergeStateStatus reviewDecision viewerCanMergeAsAdmin
              reviews(last: 50, states: APPROVED) { nodes { author { login } } }
            }
          }
        }`,
        { owner: this.owner, name: this.name, number },
      )
      const p = q.repository.pullRequest
      if (!p) throw new ReleaseError(`pull request #${number} does not exist`)
      if (p.state === 'OPEN' && p.mergeStateStatus === 'UNKNOWN' && i < 10) {
        await sleep(pollMs(3000))
        continue
      }
      return {
        number: p.number,
        state: p.merged ? 'merged' : p.state === 'OPEN' ? 'open' : 'closed',
        headRef: p.headRefName,
        headSha: p.headRefOid,
        baseRef: p.baseRefName,
        title: p.title,
        url: p.url,
        mergedBy: p.mergedBy?.login ?? null,
        mergeCommit: p.merged ? (p.mergeCommit?.oid ?? null) : null,
        mergeStateStatus: p.mergeStateStatus,
        reviewDecision: p.reviewDecision,
        viewerCanMergeAsAdmin: p.viewerCanMergeAsAdmin,
        approvedBy: (p.reviews?.nodes ?? []).map((n) => n.author?.login).filter(Boolean),
      }
    }
  }

  /**
   * A pull request through REST (state, head, base, merge commit); the action uses it with GITHUB_TOKEN.
   * @param {number} number
   * @returns {Promise<PullInfo>}
   */
  async pullRest(number) {
    return GitHub.pullFromRest((await this.request('GET', `${this.base}/pulls/${number}`)).data)
  }

  /**
   * @param {{ head: string, base: string, title: string, body: string }} o
   * @returns {Promise<PullInfo>}
   */
  async createPull(o) {
    this.mutate(`open the pull request "${o.title}" (${o.head} → ${o.base})`)
    const r = await this.request('POST', `${this.base}/pulls`, { body: { head: o.head, base: o.base, title: o.title, body: o.body } })
    return GitHub.pullFromRest(r.data)
  }

  /**
   * @param {number} number
   * @param {{ base?: string, state?: 'open' | 'closed', title?: string, body?: string }} changes
   */
  async updatePull(number, changes) {
    this.mutate(`update pull request #${number}: ${JSON.stringify(changes).slice(0, 120)}`)
    await this.request('PATCH', `${this.base}/pulls/${number}`, { body: changes })
  }

  /**
   * @param {number} number
   * @param {string} body
   */
  async comment(number, body) {
    this.mutate(`comment on #${number}`)
    await this.request('POST', `${this.base}/issues/${number}/comments`, { body: { body } })
  }

  /**
   * Merges with a merge commit, only when the head is still `sha`.
   * @param {number} number
   * @param {{ sha: string, title: string }} o
   * @returns {Promise<{ merged: true, sha: string } | { merged: false, reason: 'head-changed' | 'not-mergeable', message: string }>}
   */
  async mergePull(number, o) {
    this.mutate(`merge pull request #${number} (merge commit "${o.title}")`)
    try {
      const r = await this.request('PUT', `${this.base}/pulls/${number}/merge`, {
        body: { merge_method: 'merge', sha: o.sha, commit_title: o.title },
        retries: 3,
      })
      return { merged: true, sha: r.data.sha }
    } catch (e) {
      if (e.status === 409) return { merged: false, reason: 'head-changed', message: e.message }
      if (e.status === 405 || e.status === 422) return { merged: false, reason: 'not-mergeable', message: e.message }
      throw e
    }
  }

  /**
   * Open pull requests into main that GitHub retargeted from `branch` after it was deleted.
   * @param {string} branch
   * @returns {Promise<{ number: number, url: string, title: string }[]>}
   */
  async retargetedFrom(branch) {
    const out = []
    let cursor = null
    for (;;) {
      const q = await this.graphql(
        `query($owner: String!, $name: String!, $cursor: String) {
          repository(owner: $owner, name: $name) {
            pullRequests(states: OPEN, baseRefName: "main", first: 50, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                number url title
                timelineItems(itemTypes: [BASE_REF_CHANGED_EVENT], last: 20) {
                  nodes { ... on BaseRefChangedEvent { previousRefName currentRefName } }
                }
              }
            }
          }
        }`,
        { owner: this.owner, name: this.name, cursor },
      )
      const conn = q.repository.pullRequests
      for (const n of conn.nodes) {
        if ((n.timelineItems?.nodes ?? []).some((e) => e.previousRefName === branch && e.currentRefName === 'main')) {
          out.push({ number: n.number, url: n.url, title: n.title })
        }
      }
      if (!conn.pageInfo.hasNextPage) break
      cursor = conn.pageInfo.endCursor
    }
    return out
  }

  // --- releases ------------------------------------------------------------------

  /**
   * @param {any} r
   * @returns {ReleaseInfo}
   */
  static releaseFromRest(r) {
    return {
      id: r.id,
      tagName: r.tag_name,
      name: r.name ?? '',
      draft: !!r.draft,
      prerelease: !!r.prerelease,
      body: r.body ?? '',
      targetCommitish: r.target_commitish,
      url: r.html_url,
      createdAt: r.created_at,
      assets: (r.assets ?? []).map((a) => ({ id: a.id, name: a.name, url: a.browser_download_url })),
    }
  }

  /**
   * All releases, drafts included (drafts are listed only for a token with push access).
   * @returns {Promise<ReleaseInfo[]>}
   */
  async releases() {
    return (await this.paginate(`${this.base}/releases`)).map((r) => GitHub.releaseFromRest(r))
  }

  /**
   * A published release (drafts are not returned by this endpoint).
   * @param {string} tag
   * @returns {Promise<ReleaseInfo | null>}
   */
  async releaseByTag(tag) {
    const r = await this.request('GET', `${this.base}/releases/tags/${encodeURIComponent(tag)}`, { allow404: true })
    return r.status === 404 ? null : GitHub.releaseFromRest(r.data)
  }

  /** @returns {Promise<ReleaseInfo | null>} */
  async latestRelease() {
    const r = await this.request('GET', `${this.base}/releases/latest`, { allow404: true })
    return r.status === 404 ? null : GitHub.releaseFromRest(r.data)
  }

  /**
   * @param {{ tag: string, name: string, body: string, prerelease: boolean, latest: boolean, commit: string }} o
   * @returns {Promise<ReleaseInfo>}
   */
  async createRelease(o) {
    this.mutate(`create the GitHub Release ${o.tag}`)
    const r = await this.request('POST', `${this.base}/releases`, {
      body: {
        tag_name: o.tag,
        target_commitish: o.commit,
        name: o.name,
        body: o.body,
        draft: false,
        prerelease: o.prerelease,
        make_latest: o.prerelease ? 'false' : o.latest ? 'true' : 'false',
      },
      retries: 3,
    })
    return GitHub.releaseFromRest(r.data)
  }

  /**
   * Publishes a draft: tag_name must be sent (GitHub sets untagged-… otherwise) and target_commitish guards
   * against GitHub creating a missing tag on the head of main.
   * @param {number} id
   * @param {{ tag: string, prerelease: boolean, latest: boolean, commit: string }} o
   */
  async publishDraft(id, o) {
    this.mutate(`publish the draft GitHub Release ${o.tag}`)
    const r = await this.request('PATCH', `${this.base}/releases/${id}`, {
      body: {
        draft: false,
        tag_name: o.tag,
        target_commitish: o.commit,
        prerelease: o.prerelease,
        make_latest: o.prerelease ? 'false' : o.latest ? 'true' : 'false',
      },
    })
    return GitHub.releaseFromRest(r.data)
  }

  /** @param {number} id */
  async deleteRelease(id) {
    this.mutate(`delete the GitHub Release ${id}`)
    await this.request('DELETE', `${this.base}/releases/${id}`, { allow404: true })
  }

  /**
   * @param {number} id
   * @param {string} file
   * @returns {Promise<string>} browser download URL
   */
  async uploadAsset(id, file) {
    this.mutate(`upload ${basename(file)} to the GitHub Release ${id}`)
    const data = await readFile(file)
    const upload = this.apiUrl.replace('://api.', '://uploads.')
    const r = await this.request('POST', `${upload}${this.base}/releases/${id}/assets?name=${encodeURIComponent(basename(file))}`, {
      raw: data,
      contentType: 'application/gzip',
      retries: 3,
    })
    return r.data.browser_download_url
  }

  /**
   * @param {string} url
   * @returns {Promise<Buffer>}
   */
  async download(url) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${this.token}`, accept: 'application/octet-stream' }, redirect: 'follow' })
    if (!res.ok) throw new GitHubError(`GET ${url}: ${res.status}`, res.status, null)
    return Buffer.from(await res.arrayBuffer())
  }

  /**
   * @param {number} releaseId
   * @param {number} assetId
   */
  async downloadAsset(releaseId, assetId) {
    const res = await fetch(`${this.apiUrl}${this.base}/releases/assets/${assetId}`, {
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/octet-stream' },
      redirect: 'follow',
    })
    if (!res.ok) throw new GitHubError(`asset ${assetId} of release ${releaseId}: ${res.status}`, res.status, null)
    return Buffer.from(await res.arrayBuffer())
  }

  // --- actions ----------------------------------------------------------------------

  /**
   * @param {any} r
   * @returns {RunInfo}
   */
  static runFromRest(r) {
    return {
      id: r.id,
      status: r.status,
      conclusion: r.conclusion,
      headSha: r.head_sha,
      headBranch: r.head_branch,
      event: r.event,
      createdAt: new Date(r.created_at),
      attempt: r.run_attempt ?? 1,
      url: r.html_url,
    }
  }

  /**
   * Push runs of the release workflow for a tag name.
   * @param {string} workflow file name
   * @param {string} tag
   * @returns {Promise<RunInfo[]>}
   */
  async tagRuns(workflow, tag) {
    const list = await this.paginate(
      `${this.base}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=push&branch=${encodeURIComponent(tag)}`,
      'workflow_runs',
    ).catch((e) => {
      if (e.status === 404) return []
      throw e
    })
    return list.map((r) => GitHub.runFromRest(r)).filter((r) => r.headBranch === tag)
  }

  /**
   * All push runs of the release workflow (cleanup looks for runs of tags that are gone).
   * @param {string} workflow
   * @returns {Promise<RunInfo[]>}
   */
  async workflowRuns(workflow) {
    const list = await this.paginate(`${this.base}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=push`, 'workflow_runs').catch((e) => {
      if (e.status === 404) return []
      throw e
    })
    return list.map((r) => GitHub.runFromRest(r))
  }

  /** @param {number} id */
  async run(id) {
    return GitHub.runFromRest((await this.request('GET', `${this.base}/actions/runs/${id}`)).data)
  }

  /**
   * Jobs of the latest attempt.
   * @param {number} runId
   * @returns {Promise<JobInfo[]>}
   */
  async jobs(runId) {
    const list = await this.paginate(`${this.base}/actions/runs/${runId}/jobs?filter=latest`, 'jobs')
    return list.map((j) => ({ id: j.id, name: j.name, status: j.status, conclusion: j.conclusion }))
  }

  /**
   * Annotations of a job; the action reports its result as an annotation titled `release-tools`.
   * @param {number} jobId
   * @returns {Promise<{ title: string, message: string, level: string }[]>}
   */
  async annotations(jobId) {
    const list = await this.paginate(`${this.base}/check-runs/${jobId}/annotations`).catch(() => [])
    return list.map((a) => ({ title: a.title ?? '', message: a.message ?? '', level: a.annotation_level }))
  }

  /** @param {number} id */
  async cancelRun(id) {
    this.mutate(`cancel run ${id}`)
    await this.request('POST', `${this.base}/actions/runs/${id}/cancel`, { allow404: true }).catch((e) => {
      if (e.status === 409) return null
      throw e
    })
  }

  /** @param {number} id */
  async deleteRun(id) {
    this.mutate(`delete run ${id}`)
    await this.request('DELETE', `${this.base}/actions/runs/${id}`, { allow404: true })
  }

  /** @param {number} id */
  async rerunFailed(id) {
    this.mutate(`re-run the failed jobs of run ${id}`)
    await this.request('POST', `${this.base}/actions/runs/${id}/rerun-failed-jobs`)
  }

  /**
   * @param {number} runId
   * @returns {Promise<{ name: string, expired: boolean }[]>}
   */
  async artifacts(runId) {
    const list = await this.paginate(`${this.base}/actions/runs/${runId}/artifacts`, 'artifacts')
    return list.map((a) => ({ name: a.name, expired: !!a.expired }))
  }

  /**
   * The failed steps of a run, as `gh run view --log-failed` prints them.
   * @param {number} runId
   */
  async failedLog(runId) {
    const r = await run('gh', ['run', 'view', String(runId), '--repo', this.repo, '--log-failed'], {
      allowFail: true,
      extraEnv: { GH_TOKEN: this.token },
    })
    return r.code === 0 ? r.stdout : `(could not read the log: ${r.stderr.trim()})`
  }
}

/** @param {string} name */
function encodeRef(name) {
  return name.split('/').map(encodeURIComponent).join('/')
}

/**
 * The token of the logged-in `gh`.
 * @returns {Promise<string>}
 */
export async function ghToken() {
  if (process.env.RELEASE_TOOLS_GH_TOKEN) return process.env.RELEASE_TOOLS_GH_TOKEN
  const r = await run('gh', ['auth', 'token'], { allowFail: true }).catch(() => null)
  if (!r || r.code !== 0 || !r.stdout.trim()) {
    throw new ReleaseError('gh is not logged in', { hint: 'gh auth login --scopes repo,workflow' })
  }
  return r.stdout.trim()
}
