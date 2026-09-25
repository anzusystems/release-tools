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
import { init } from '../../lib/commands/init.mjs'
import { start } from '../../lib/commands/start.mjs'
import { publish } from '../../lib/commands/publish.mjs'
import { cleanup } from '../../lib/commands/cleanup.mjs'

export const ENABLED = process.env.RELEASE_E2E === '1'
export const REPO = process.env.RELEASE_E2E_REPO || 'anzusystems/release-tools-sandbox'
/** The branch of release-tools whose action the sandbox uses; it must be pushed. */
export const ACTION_REF = process.env.RELEASE_E2E_ACTION_REF || 'main'

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
  const view = await run('gh', ['repo', 'view', REPO, '--json', 'name'], { allowFail: true })
  if (view.code === 0) return
  const created = await run('gh', ['repo', 'create', REPO, '--public', '--description', 'Sandbox of the end-to-end tests of anzusystems/release-tools'], { allowFail: true })
  if (created.code !== 0) throw new Error(`${REPO} does not exist and could not be created; create it by hand and set RELEASE_E2E_REPO`)
}

/**
 * Resets the sandbox: main with the sample project, no other branches, tags, Releases or open pull requests.
 * @param {{ publish?: 'npm' | 'none', version?: string, config?: Record<string, any> }} [o]
 */
export async function resetSandbox(o = {}) {
  await ensureSandbox()
  const gh = new GitHub({ token: await ghToken(), repo: REPO })
  for (const p of await gh.pulls({ state: 'open' })) await gh.updatePull(p.number, { state: 'closed' })
  for (const r of await gh.releases()) await gh.deleteRelease(r.id)
  for (const t of await gh.tagRefs()) await gh.deleteTag(t.name)
  for (const prefix of ['release/', 'hotfix/', 'release-merge/', 'docs/']) for (const b of await gh.branches(prefix)) await gh.deleteBranch(b.name)
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
      extraEnv: { RELEASE_TOOLS_REGISTRY: 'mock' },
    }),
    'doc/changelog/template.md': DEFAULT_TEMPLATE,
    'CHANGELOG.md': '# Changelog\n\nSandbox.\n',
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
  return { root, work, gh, registry: new MockRegistry(gh) }
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
