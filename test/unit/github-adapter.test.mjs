// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GitHub } from '../../lib/github.mjs'

/**
 * Serves fake API responses by path; `next` pages are linked with a Link header.
 * @param {Record<string, any>} routes path (without host) → body, or { pages: [...] }
 */
function withFetch(routes, fn) {
  const original = globalThis.fetch
  globalThis.fetch = /** @type {any} */ (
    async (/** @type {string} */ url) => {
      const u = new URL(url)
      const key = u.pathname.replace(/^\/graphql$/, 'graphql')
      const page = Number(u.searchParams.get('page') ?? '1')
      const route = routes[key]
      if (route === undefined) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
      const headers = new Headers({ date: new Date().toUTCString() })
      if (route?.pages) {
        if (page < route.pages.length) {
          u.searchParams.set('page', String(page + 1))
          headers.set('link', `<${u.toString()}>; rel="next"`)
        }
        return new Response(JSON.stringify(route.pages[page - 1]), { status: 200, headers })
      }
      return new Response(JSON.stringify(route), { status: 200, headers })
    }
  )
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

const graphqlRepo = { data: { repository: { mergeCommitAllowed: true, mergeQueue: null, ref: { branchProtectionRule: null, refUpdateRule: null }, pullRequest: { viewerCanMergeAsAdmin: false } } } }

test('merge requirements read every page of the branch rules', async () => {
  const gh = new GitHub({ token: 't', repo: 'o/r', apiUrl: 'https://api.example.com' })
  await withFetch(
    {
      graphql: graphqlRepo,
      '/repos/o/r/rules/branches/main': { pages: [[{ type: 'pull_request', ruleset_id: 1, parameters: { allowed_merge_methods: ['merge'] } }], [{ type: 'required_linear_history', ruleset_id: 2 }]] },
    },
    async () => {
      const r = await gh.mergeRequirements()
      assert.deepEqual(r.problems, ['the ruleset 2 requires a linear history on main'])
    },
  )
})

test('bypass needs every ruleset of main, also on later pages', async () => {
  const gh = new GitHub({ token: 't', repo: 'o/r', apiUrl: 'https://api.example.com' })
  await withFetch(
    {
      graphql: graphqlRepo,
      '/repos/o/r/rules/branches/main': { pages: [[{ type: 'pull_request', ruleset_id: 1 }], [{ type: 'deletion', ruleset_id: 2 }]] },
      '/repos/o/r/rulesets/1': { current_user_can_bypass: 'always' },
      '/repos/o/r/rulesets/2': { current_user_can_bypass: 'never' },
    },
    async () => {
      assert.equal(await gh.canBypass(1), false)
    },
  )
})

test('a POST refused as existing after a failed attempt returns what the failed attempt created', async () => {
  const poll = process.env.RELEASE_TOOLS_POLL_MS
  process.env.RELEASE_TOOLS_POLL_MS = '1'
  const gh = new GitHub({ token: 't', repo: 'o/r', apiUrl: 'https://api.example.com' })
  const original = globalThis.fetch
  let posts = 0
  const release = { id: 5, tag_name: '1.0.0', name: '1.0.0', body: 'x', draft: false, prerelease: false, target_commitish: 'c', html_url: 'u', created_at: '2026-01-01T00:00:00Z', assets: [] }
  globalThis.fetch = /** @type {any} */ (
    async (/** @type {string} */ url, /** @type {any} */ init) => {
      const u = new URL(url)
      const headers = new Headers({ date: new Date().toUTCString() })
      if (u.pathname !== '/repos/o/r/releases') return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers })
      if (init?.method !== 'POST') return new Response(JSON.stringify([release]), { status: 200, headers })
      posts++
      if (posts === 1) return new Response(JSON.stringify({ message: 'Bad Gateway' }), { status: 502, headers })
      return new Response(JSON.stringify({ message: 'Validation Failed', errors: [{ code: 'already_exists' }] }), { status: 422, headers })
    }
  )
  try {
    const o = { tag: '1.0.0', name: '1.0.0', body: 'x', prerelease: false, latest: true, commit: 'c' }
    assert.equal((await gh.createRelease(o)).id, 5)
    assert.equal(posts, 2)
    // Refused at the first attempt: it existed before, which stays an error.
    await assert.rejects(gh.createRelease(o), /422/)
  } finally {
    globalThis.fetch = original
    if (poll === undefined) delete process.env.RELEASE_TOOLS_POLL_MS
    else process.env.RELEASE_TOOLS_POLL_MS = poll
  }
})

test('annotations that cannot be read are an error, never an empty list', async () => {
  const gh = new GitHub({ token: 't', repo: 'o/r', apiUrl: 'https://api.example.com' })
  await withFetch({}, async () => {
    await assert.rejects(gh.annotations(7), /404/)
  })
})
