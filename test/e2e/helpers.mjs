// @ts-check
// End-to-end tests on real GitHub: a public sandbox repository, real branches, pull requests, tags, Releases and
// workflow runs with the action from the tested branch of release-tools. Nothing is published: the registry is
// mocked with tags of the sandbox (RELEASE_TOOLS_REGISTRY=mock). Run locally with your logged-in gh.
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { run } from '../../lib/exec.mjs'
import { GitHub, ghToken } from '../../lib/github.mjs'
import { MockRegistry } from '../../lib/registry.mjs'
import { createContext } from '../../lib/context.mjs'
import { ScriptedUI } from '../../lib/ui.mjs'
import { stubWorkflow } from '../../lib/templates.mjs'
import { DEFAULT_TEMPLATE } from '../../lib/changelog.mjs'
import { formatTagMessage, mktagContent } from '../../lib/tags.mjs'
import { init } from '../../lib/commands/init.mjs'
import { start } from '../../lib/commands/start.mjs'
import { publish } from '../../lib/commands/publish.mjs'
import { cleanup } from '../../lib/commands/cleanup.mjs'

export const ENABLED = process.env.RELEASE_E2E === '1'
export const REPO = process.env.RELEASE_E2E_REPO || 'anzusystems/release-tools-sandbox'
/** The branch of release-tools whose action the sandbox uses; it must be pushed. */
export const ACTION_REF = process.env.RELEASE_E2E_ACTION_REF || 'main'
/** The file that marks the main of a sandbox the tests may reset. */
const SANDBOX_MARK = '.release-tools-sandbox'

process.env.RELEASE_TOOLS_REGISTRY = 'mock'

/**
 * @param {string} cwd
 * @param {string[]} args
 */
export async function git(cwd, args) {
  return (await run('git', args, { cwd, extraEnv: { GIT_TERMINAL_PROMPT: '0' } })).stdout.trim()
}

/** Creates the sandbox when it does not exist (public: environments with rules need a paid plan otherwise). */
export async function ensureSandbox() {
  // The reset deletes everything in the repository and force-pushes its main: never anything but a sandbox.
  if (!/\/[\w.-]+-sandbox$/.test(REPO)) throw new Error(`${REPO} is not a sandbox (its name must end with -sandbox)`)
  const view = await run('gh', ['repo', 'view', REPO, '--json', 'name'], { allowFail: true })
  if (view.code === 0) {
    const gh = new GitHub({ token: await ghToken(), repo: REPO })
    if ((await gh.branchSha('main')) && (await gh.file(SANDBOX_MARK, 'main')) === null) {
      throw new Error(`${REPO} has a main without ${SANDBOX_MARK}; it is not reset`)
    }
    return
  }
  const created = await run('gh', ['repo', 'create', REPO, '--public', '--description', 'Sandbox of the end-to-end tests of anzusystems/release-tools'], { allowFail: true })
  if (created.code !== 0) throw new Error(`${REPO} does not exist and could not be created; create it by hand and set RELEASE_E2E_REPO`)
}

/**
 * A call of the REST API of the sandbox.
 * @param {GitHub} gh
 * @param {string} method
 * @param {string} path below /repos/<sandbox>/, or absolute from /
 * @param {any} [body]
 */
export async function api(gh, method, path, body) {
  const url = path.startsWith('/') ? path : `${gh.base}/${path}`
  return (await gh.request(method, url, body === undefined ? { allow404: true } : { body, allow404: true })).data
}

/**
 * Resets the sandbox: main with the sample project, no other branches, tags, Releases, open pull requests, rulesets
 * or branch protection; then the protection of the scenario.
 * @param {{ publish?: 'npm' | 'none', version?: string, config?: Record<string, any>, failAt?: string, ci?: boolean,
 *   protection?: 'approval' | 'strict' }} [o] failAt: checkpoints of the action (first attempt only); ci: a check `check`
 *   on pull requests; approval: a ruleset that requires one approval (admins may bypass); strict: classic protection
 *   that requires `check` and an up-to-date branch
 */
export async function resetSandbox(o = {}) {
  await ensureSandbox()
  const gh = new GitHub({ token: await ghToken(), repo: REPO })
  for (const r of (await api(gh, 'GET', 'rulesets')) ?? []) await api(gh, 'DELETE', `rulesets/${r.id}`)
  await api(gh, 'DELETE', 'branches/main/protection')
  for (const p of await gh.pulls({ state: 'open' })) await gh.updatePull(p.number, { state: 'closed' })
  for (const r of await gh.releases()) await gh.deleteRelease(r.id)
  for (const t of await gh.tagRefs()) await gh.deleteTag(t.name)
  for (const b of await gh.branches('')) if (b.name !== 'main') await gh.deleteBranch(b.name)
  for (const r of await gh.workflowRuns('release.yml').catch(() => [])) await gh.deleteRun(r.id).catch(() => {})

  const root = await mkdtemp(join(tmpdir(), 'release-tools-e2e-'))
  const work = join(root, 'sandbox')
  await mkdir(work, { recursive: true })
  await git(work, ['init', '--quiet', '-b', 'main'])
  await git(work, ['remote', 'add', 'origin', `git@github.com:${REPO}.git`])
  const publishMode = o.publish ?? 'npm'
  const files = {
    'package.json': `${JSON.stringify(
      {
        name: `@anzusystems-sandbox/${REPO.split('/')[1]}`,
        version: o.version ?? '1.0.0',
        type: 'module',
        repository: { type: 'git', url: `git+https://github.com/${REPO}.git` },
        files: ['dist'],
        scripts: { build: 'node build.mjs', test: 'node check.mjs' },
      },
      null,
      2,
    )}\n`,
    'build.mjs': "import { mkdirSync, copyFileSync } from 'node:fs'\nmkdirSync('dist', { recursive: true })\ncopyFileSync('src/index.js', 'dist/index.js')\n",
    'check.mjs': "import { existsSync } from 'node:fs'\nif (existsSync('FAIL')) { console.error('check failed'); process.exit(1) }\n",
    'src/index.js': 'export const x = 1\n',
    '.gitignore': 'node_modules/\ndist/\n',
    'release.config.json': `${JSON.stringify({ version: 1, repo: REPO, publish: publishMode, changelogIndex: 'CHANGELOG.md', node: '24', ci: { checks: ['npm test'] }, ...(o.config ?? {}) }, null, 2)}\n`,
    '.github/workflows/release.yml': stubWorkflow({
      publish: publishMode,
      environment: 'npmjs-publish',
      actionRef: `anzusystems/release-tools/publish@${ACTION_REF}`,
      extraEnv: { RELEASE_TOOLS_REGISTRY: 'mock', ...(o.failAt ? { RELEASE_TOOLS_FAIL_AT: o.failAt } : {}) },
    }),
    ...(o.ci
      ? { '.github/workflows/ci.yml': 'name: CI\non: pull_request\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n' }
      : {}),
    'doc/changelog/template.md': DEFAULT_TEMPLATE,
    'CHANGELOG.md': '# Changelog\n\nSandbox.\n',
    [SANDBOX_MARK]: 'The end-to-end tests of anzusystems/release-tools reset this repository.\n',
  }
  for (const [p, content] of Object.entries(files)) {
    await mkdir(dirname(join(work, p)), { recursive: true })
    await writeFile(join(work, p), content)
  }
  await run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: work })
  await git(work, ['add', '-A'])
  await git(work, ['commit', '--quiet', '-m', 'sandbox'])
  // The sandbox is the only repository the tests force-push to: they own it.
  await git(work, ['push', '--quiet', '--force', 'origin', 'main'])
  if (o.protection === 'approval') {
    await api(gh, 'POST', 'rulesets', {
      name: 'e2e approval',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
      rules: [
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 1,
            dismiss_stale_reviews_on_push: true,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_review_thread_resolution: false,
          },
        },
      ],
    })
  } else if (o.protection === 'strict') {
    await api(gh, 'PUT', 'branches/main/protection', {
      required_status_checks: { strict: true, contexts: ['check'] },
      enforce_admins: false,
      required_pull_request_reviews: null,
      restrictions: null,
    })
  }
  return { root, work, gh, registry: new MockRegistry(gh) }
}

/**
 * Waits until `check` returns something truthy.
 * @template T
 * @param {() => Promise<T>} check
 * @param {{ timeoutMs?: number, what?: string }} [o]
 * @returns {Promise<NonNullable<T>>}
 */
export async function waitFor(check, o = {}) {
  const until = Date.now() + (o.timeoutMs ?? 10 * 60 * 1000)
  for (;;) {
    const v = await check()
    if (v) return /** @type {NonNullable<T>} */ (v)
    if (Date.now() > until) throw new Error(`timed out waiting for ${o.what ?? 'a condition'}`)
    await new Promise((r) => setTimeout(r, 5000))
  }
}

/**
 * Pushes a tag of the tool's format made by hand (for example with an old date), like a clone that kept it.
 * @param {string} work
 * @param {{ name: string, commit: string, kind: 'final' | 'hotfix' | 'prerelease' | 'dev', ageSeconds?: number, pr?: number }} t
 */
export async function pushToolTag(work, t) {
  const content = mktagContent({
    commit: t.commit,
    name: t.name,
    tagger: { name: 'e2e', email: 'e2e@example.com' },
    epochSeconds: Math.floor(Date.now() / 1000) - (t.ageSeconds ?? 0),
    message: formatTagMessage({ kind: t.kind, pr: t.pr, id: Math.random().toString(16).slice(2, 10) }),
  })
  const sha = (await run('git', ['mktag'], { cwd: work, input: content })).stdout.trim()
  await git(work, ['push', '--quiet', `git@github.com:${REPO}.git`, `${sha}:refs/tags/${t.name}`])
  return sha
}

/**
 * The release-tools result of every job of the finished runs of a tag, newest run first.
 * @param {GitHub} gh
 * @param {string} tag
 */
export async function runResults(gh, tag) {
  const out = []
  for (const r of await gh.tagRuns('release.yml', tag)) {
    const jobs = await gh.jobs(r.id, { all: true })
    const codes = []
    for (const j of jobs) for (const a of await gh.annotations(j.id)) if (a.title === 'release-tools') codes.push(a.message)
    out.push({ run: r, jobs, codes })
  }
  return out
}

/**
 * Runs a command in-process with scripted answers against the real GitHub.
 * @param {'init' | 'start' | 'publish' | 'cleanup'} command
 * @param {string} cwd
 * @param {{ match: string | RegExp, answer: any }[]} answers
 * @param {{ failAt?: string, dryRun?: boolean }} [o]
 */
export async function cli(command, cwd, answers, o = {}) {
  const ui = new ScriptedUI(answers)
  const ctx = await createContext({ cwd, ui, failAt: o.failAt ?? '', dryRun: o.dryRun, requireConfig: command !== 'init', options: { noInstall: true } })
  const fn = { init, start, publish, cleanup }[command]
  return { result: await fn(ctx), ui }
}

/**
 * @param {string} root
 */
export async function dispose(root) {
  if (!process.env.KEEP_TEST_REPOS) await rm(root, { recursive: true, force: true })
}

export { readFile }
