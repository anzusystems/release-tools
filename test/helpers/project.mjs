// @ts-check
import { mkdtemp, writeFile, mkdir, rm, readFile, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { run } from '../../lib/exec.mjs'
import { createContext } from '../../lib/context.mjs'
import { ScriptedUI } from '../../lib/ui.mjs'
import { stubWorkflow } from '../../lib/templates.mjs'
import { DEFAULT_TEMPLATE } from '../../lib/changelog.mjs'
import { FakeGitHub, FakeRegistry } from './fake-github.mjs'
import { init } from '../../lib/commands/init.mjs'
import { start } from '../../lib/commands/start.mjs'
import { publish } from '../../lib/commands/publish.mjs'
import { cleanup } from '../../lib/commands/cleanup.mjs'

process.env.RELEASE_TOOLS_POLL_MS = process.env.RELEASE_TOOLS_POLL_MS ?? '2'

export const REPO = 'test/pkg'
const IDENTITY = { GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' }

/**
 * @param {string} cwd
 * @param {string[]} args
 */
export async function git(cwd, args) {
  return (await run('git', args, { cwd, extraEnv: { ...IDENTITY, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim()
}

/**
 * @typedef {object} ProjectOptions
 * @property {'npm' | 'none'} [publish]
 * @property {string} [version] version in package.json
 * @property {boolean} [requireTestedPrerelease]
 * @property {Record<string, any>} [config] extra configuration
 * @property {'npm' | 'pnpm' | 'yarn'} [pm]
 */

/**
 * A sample project: a bare origin with a hook, a clone as the developer's folder, the fake GitHub and registry.
 * @param {ProjectOptions} [o]
 */
export async function setupProject(o = {}) {
  const root = await mkdtemp(join(tmpdir(), 'release-tools-it-'))
  const bare = join(root, 'origin.git')
  const work = join(root, 'work', 'pkg')
  await run('git', ['init', '--quiet', '--bare', '-b', 'main', bare])
  const registry = new FakeRegistry()
  await mkdir(join(root, 'runs'))
  const gh = new FakeGitHub({ bare, repo: REPO, registry, tmp: join(root, 'runs') })
  await gh.install()
  await mkdir(work, { recursive: true })
  await run('git', ['init', '--quiet', '-b', 'main', work])
  await git(work, ['config', 'user.email', 'dev@example.com'])
  await git(work, ['config', 'user.name', 'Dev'])
  await git(work, ['config', 'commit.gpgSign', 'false'])
  await git(work, ['remote', 'add', 'origin', bare])
  const publishMode = o.publish ?? 'npm'
  const files = {
    'package.json': `${JSON.stringify(
      {
        name: '@test/pkg',
        version: o.version ?? '1.0.0',
        type: 'module',
        repository: { type: 'git', url: `git+https://github.com/${REPO}.git` },
        files: ['dist'],
        scripts: { build: 'node build.mjs', test: 'node check.mjs' },
        ...(o.pm === 'yarn' ? { packageManager: 'yarn@4.14.1' } : {}),
      },
      null,
      2,
    )}\n`,
    ...(o.pm === 'yarn' ? { '.yarnrc.yml': 'nodeLinker: node-modules\nenableTelemetry: false\n' } : {}),
    'build.mjs': "import { mkdirSync, copyFileSync } from 'node:fs'\nmkdirSync('dist', { recursive: true })\ncopyFileSync('src/index.js', 'dist/index.js')\n",
    'check.mjs': "import { existsSync } from 'node:fs'\nif (existsSync('FAIL')) { console.error('check failed: FAIL exists'); process.exit(1) }\n",
    'src/index.js': 'export const x = 1\n',
    '.gitignore': 'node_modules/\ndist/\n.yarn/\n.pnp.*\n',
    'release.config.json': `${JSON.stringify(
      {
        version: 1,
        repo: REPO,
        publish: publishMode,
        changelogIndex: 'CHANGELOG.md',
        ci: { checks: ['npm test'] },
        ...(o.requireTestedPrerelease ? { requireTestedPrerelease: true } : {}),
        ...(o.config ?? {}),
      },
      null,
      2,
    )}\n`,
    '.github/workflows/release.yml': stubWorkflow({ publish: publishMode, environment: 'npmjs-publish' }),
    'doc/changelog/template.md': DEFAULT_TEMPLATE,
    'CHANGELOG.md': '# Changelog\n\nOne file per release.\n',
  }
  for (const [p, content] of Object.entries(files)) {
    await mkdir(dirname(join(work, p)), { recursive: true })
    await writeFile(join(work, p), content)
  }
  if (o.pm === 'yarn') await run('corepack', ['yarn', 'install', '--mode=update-lockfile'], { cwd: work, extraEnv: { YARN_ENABLE_TELEMETRY: '0' } })
  else if (o.pm === 'pnpm') await run('pnpm', ['install', '--lockfile-only'], { cwd: work })
  else await run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: work })
  await git(work, ['add', '-A'])
  await git(work, ['commit', '--quiet', '-m', 'initial'])
  await git(work, ['push', '--quiet', 'origin', 'main'])
  await gh.sync()
  return new TestProject(root, bare, work, gh, registry)
}

export class TestProject {
  /**
   * @param {string} root
   * @param {string} bare
   * @param {string} work
   * @param {FakeGitHub} gh
   * @param {FakeRegistry} registry
   */
  constructor(root, bare, work, gh, registry) {
    this.root = root
    this.bare = bare
    this.work = work
    this.gh = gh
    this.registry = registry
    /** @type {ScriptedUI | null} */
    this.lastUi = null
  }

  /** @param {string} branch */
  folder(branch) {
    return join(this.root, 'work', `pkg-${branch.replace('/', '-')}`)
  }

  /**
   * Runs a command of the CLI in a folder with scripted answers.
   * @param {'init' | 'start' | 'publish' | 'cleanup'} command
   * @param {{ match: string | RegExp, answer: any }[]} answers
   * @param {{ cwd?: string, dryRun?: boolean, failAt?: string, options?: Record<string, any> }} [o]
   */
  async cli(command, answers = [], o = {}) {
    const ui = new ScriptedUI(answers)
    this.lastUi = ui
    const ctx = await createContext({
      cwd: o.cwd ?? this.work,
      ui,
      dryRun: o.dryRun,
      gh: /** @type {any} */ (this.gh),
      registry: this.gh.registry,
      repo: REPO,
      failAt: o.failAt ?? '',
      requireConfig: command !== 'init',
      options: { noInstall: true, ...(o.options ?? {}) },
    })
    const fn = { init, start, publish, cleanup }[command]
    try {
      return await fn(ctx)
    } catch (e) {
      e.uiLog = ui.text()
      throw e
    }
  }

  /**
   * Commits a change in a folder and pushes the branch.
   * @param {string} dir
   * @param {Record<string, string | null>} files
   * @param {string} message
   * @param {{ push?: boolean }} [o]
   */
  async commit(dir, files, message, o = {}) {
    for (const [p, content] of Object.entries(files)) {
      if (content === null) await rm(join(dir, p), { force: true })
      else {
        await mkdir(dirname(join(dir, p)), { recursive: true })
        await writeFile(join(dir, p), content)
      }
    }
    await git(dir, ['add', '-A'])
    await git(dir, ['commit', '--quiet', '-m', message])
    if (o.push !== false) {
      const branch = await git(dir, ['symbolic-ref', '--short', 'HEAD'])
      await git(dir, ['push', '--quiet', '--no-follow-tags', 'origin', `HEAD:refs/heads/${branch}`])
    }
    await this.gh.sync()
    return git(dir, ['rev-parse', 'HEAD'])
  }

  /**
   * Writes the changelog of a version in its release folder.
   * @param {string} branch
   * @param {string} version
   * @param {string} [text]
   */
  async writeChangelog(branch, version, text = '- **Something** changed.') {
    const dir = this.folder(branch)
    const path = join(dir, 'doc/changelog', `${version}.md`)
    const current = await readFile(path, 'utf8')
    await writeFile(path, current.replace('### Added\n', `### Added\n\n${text}\n`))
    await git(dir, ['commit', '--quiet', '-am', `docs: changelog ${version}`])
    await git(dir, ['push', '--quiet', '--no-follow-tags', 'origin', `HEAD:refs/heads/${branch}`])
    await this.gh.sync()
  }

  /**
   * A change merged into main by a normal pull request (outside the package).
   * @param {Record<string, string>} [files]
   * @param {string} [message]
   */
  async changeMain(files = { 'doc/notes.md': `notes ${Date.now()}\n` }, message = 'docs: notes') {
    const tmp = join(this.root, `side-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await run('git', ['clone', '--quiet', this.bare, tmp])
    await git(tmp, ['config', 'user.email', 'dev@example.com'])
    await git(tmp, ['config', 'user.name', 'Dev'])
    for (const [p, content] of Object.entries(files)) {
      await mkdir(dirname(join(tmp, p)), { recursive: true })
      await writeFile(join(tmp, p), content)
    }
    await git(tmp, ['add', '-A'])
    await git(tmp, ['commit', '--quiet', '-m', message])
    await git(tmp, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])
    await this.gh.sync()
    await rm(tmp, { recursive: true, force: true })
  }

  /** @param {string} ref */
  async sha(ref) {
    return git(this.bare, ['rev-parse', ref])
  }

  /**
   * @param {string} a
   * @param {string} b
   */
  async isAncestor(a, b) {
    return (await run('git', ['merge-base', '--is-ancestor', a, b], { cwd: this.bare, allowFail: true })).code === 0
  }

  /** @param {string} ref @param {string} path */
  async show(ref, path) {
    return git(this.bare, ['show', `${ref}:${path}`])
  }

  async tags() {
    return (await git(this.bare, ['tag', '--list'])).split('\n').filter(Boolean)
  }

  async localTags() {
    return (await git(this.work, ['tag', '--list'])).split('\n').filter(Boolean)
  }

  /** @param {string} p */
  exists(p) {
    return existsSync(p)
  }

  async dispose() {
    if (!process.env.KEEP_TEST_REPOS) await rm(this.root, { recursive: true, force: true })
  }
}

export { appendFile }
