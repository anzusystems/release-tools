// @ts-check
import { basename, dirname, join } from 'node:path'
import { Git } from './git.mjs'
import { GitHub, ghToken } from './github.mjs'
import { registryFor } from './registry.mjs'
import { parseConfig, repoSettings, buildSettings, CONFIG_FILE } from './config.mjs'
import { ReleaseError, DryRunStop, Interrupted, repoFromUrl } from './util.mjs'
import { MOVING_NS } from './git.mjs'

/**
 * @typedef {object} Context
 * @property {string} dir working tree the command was started in
 * @property {string} mainDir main working tree of the repository
 * @property {string} repoDirName folder name used for release folders (`../<name>-release-X.Y.Z`)
 * @property {Git} git git in `dir`
 * @property {Git} mainGit git in `mainDir`
 * @property {import('./github.mjs').GitHub} gh
 * @property {import('./registry.mjs').Registry | null} registry null for publish: "none"
 * @property {import('./ui.mjs').UI} ui
 * @property {boolean} dryRun
 * @property {import('./config.mjs').RepoSettings} settings from origin/main
 * @property {any} mainConfig raw configuration from origin/main
 * @property {(step: string) => void} checkpoint RELEASE_TOOLS_FAIL_AT
 * @property {{ name: string, email: string }} identity
 * @property {string} login
 * @property {() => Date} now local clock, only for waiting
 * @property {Record<string, any>} options command line options
 */

/**
 * @param {boolean} dryRun
 * @param {import('./ui.mjs').UI} ui
 */
export function makeGuard(dryRun, ui) {
  return {
    /** @param {string} action */
    mutate(action) {
      if (dryRun) {
        ui.info(`--dry-run: would ${action}`)
        throw new DryRunStop(action)
      }
    },
  }
}

/**
 * @param {string | undefined} failAt
 */
export function makeCheckpoint(failAt) {
  const steps = new Set((failAt ?? '').split(',').map((s) => s.trim()).filter(Boolean))
  return (/** @type {string} */ step) => {
    if (steps.has(step)) throw new Interrupted(step)
  }
}

/**
 * Builds the context of a command: repository, GitHub, registry and the settings from origin/main.
 * @param {object} o
 * @param {string} o.cwd
 * @param {import('./ui.mjs').UI} o.ui
 * @param {boolean} [o.dryRun]
 * @param {import('./github.mjs').GitHub} [o.gh] injected in tests
 * @param {import('./registry.mjs').Registry | null} [o.registry] injected in tests
 * @param {string} [o.failAt]
 * @param {boolean} [o.requireConfig] false for init
 * @param {Record<string, any>} [o.options]
 * @param {string} [o.repo] tests: the repository when origin is a local path
 * @returns {Promise<Context>}
 */
export async function createContext(o) {
  const ui = o.ui
  const dryRun = !!o.dryRun
  const guard = makeGuard(dryRun, ui)
  const probe = new Git(o.cwd, { guard })
  const [major, minor] = await probe.version()
  if (major < 2 || (major === 2 && minor < 38)) throw new ReleaseError(`git ${major}.${minor} is too old; the tool needs git 2.38 or newer`)
  const top = await probe.toplevel().catch(() => {
    throw new ReleaseError('not in a git repository')
  })
  const git = probe.at(top)
  const mainDir = await git.mainWorktree()
  const mainGit = git.at(mainDir)
  const url = await git.remoteUrl('origin')
  const repo = o.repo ?? (url ? repoFromUrl(url) : null)
  if (!repo) throw new ReleaseError('the repository has no GitHub remote named origin')

  const moving = await git.refs(MOVING_NS)
  await git.fetch({ pruneTags: moving.length === 0 })

  const gh = o.gh ?? new GitHub({ token: await ghToken(), repo, guard })
  if (o.gh) gh.guard = guard
  const viewer = await gh.viewer()
  if (viewer.scopes) {
    const missing = ['repo', 'workflow'].filter((s) => !viewer.scopes?.includes(s))
    if (missing.length) {
      throw new ReleaseError(`gh is logged in without the scope ${missing.join(' and ')}`, { hint: `gh auth refresh --scopes ${['repo', 'workflow'].join(',')}` })
    }
  }

  const hasMain = !!(await git.commitOf('refs/remotes/origin/main'))
  if (!hasMain) {
    throw new ReleaseError('the repository has no main branch on GitHub yet', {
      hint: 'push a first commit to main (for example README and LICENSE) before anything else',
    })
  }

  let mainConfig = null
  let settings = null
  const text = await git.show('refs/remotes/origin/main', CONFIG_FILE)
  if (text !== null) {
    mainConfig = parseConfig(text, 'origin/main')
    const pkgText = await git.show('refs/remotes/origin/main', 'package.json')
    settings = repoSettings(mainConfig, pkgText ? JSON.parse(pkgText) : null)
    if (settings.repo.toLowerCase() !== repo.toLowerCase()) {
      throw new ReleaseError(`origin is ${repo}, but ${CONFIG_FILE} in main says ${settings.repo}`)
    }
  } else if (o.requireConfig !== false) {
    throw new ReleaseError(`${CONFIG_FILE} is not in main yet`, { hint: 'run init and bring its files into main through a pull request' })
  }

  const identity = await git.identity()
  const registry = o.registry !== undefined ? o.registry : settings?.publish === 'npm' ? registryFor(gh) : null

  return {
    dir: top,
    mainDir,
    repoDirName: basename(mainDir),
    git,
    mainGit,
    gh,
    registry,
    ui,
    dryRun,
    settings: /** @type {any} */ (settings),
    mainConfig,
    checkpoint: makeCheckpoint(o.failAt ?? process.env.RELEASE_TOOLS_FAIL_AT),
    identity,
    login: viewer.login,
    now: () => new Date(),
    options: o.options ?? {},
  }
}

/**
 * The folder of a release: next to the main working tree.
 * @param {Context} ctx
 * @param {string} branch release/X.Y.Z or hotfix/X.Y.Z
 */
export function releaseFolder(ctx, branch) {
  return join(dirname(ctx.mainDir), `${ctx.repoDirName}-${branch.replace('/', '-')}`)
}

/**
 * Build settings of a commit (changelog paths, build, checks).
 * @param {Context} ctx
 * @param {string} commit
 */
export async function buildSettingsAt(ctx, commit) {
  const text = await ctx.git.show(commit, CONFIG_FILE)
  if (text === null) throw new ReleaseError(`${CONFIG_FILE} is missing in ${commit.slice(0, 12)}`)
  return buildSettings(parseConfig(text, commit.slice(0, 12)))
}
