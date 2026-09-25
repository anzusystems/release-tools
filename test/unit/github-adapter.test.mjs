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
