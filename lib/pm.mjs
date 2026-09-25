// @ts-check
import { ReleaseError } from './util.mjs'

/**
 * @typedef {{ name: 'npm' | 'pnpm' | 'yarn', version: string | null }} PackageManager
 */

/**
 * Detects the package manager from `packageManager` in package.json, otherwise from the lockfile.
 * @param {any} packageJson
 * @param {(path: string) => boolean} exists relative to the project root
 * @returns {PackageManager}
 */
export function detectPackageManager(packageJson, exists) {
  const field = packageJson?.packageManager
  if (typeof field === 'string') {
    const m = /^(npm|pnpm|yarn)@(\d+[^+]*)/.exec(field)
    if (m) {
      const name = /** @type {'npm' | 'pnpm' | 'yarn'} */ (m[1])
      if (name === 'yarn' && Number(m[2].split('.')[0]) < 4) {
        throw new ReleaseError(`yarn ${m[2]} is not supported; the tool needs yarn 4 or newer`)
      }
      return { name, version: m[2] }
    }
  }
  if (exists('pnpm-lock.yaml')) return { name: 'pnpm', version: null }
  if (exists('yarn.lock')) {
    if (!exists('.yarnrc.yml')) throw new ReleaseError('yarn.lock without .yarnrc.yml looks like yarn 1, which is not supported; the tool needs yarn 4 or newer')
    return { name: 'yarn', version: null }
  }
  return { name: 'npm', version: null }
}

/**
 * Install in a release folder (lockfile respected, scripts as the project has them).
 * @param {PackageManager} pm
 */
export function worktreeInstall(pm) {
  if (pm.name === 'npm') return 'npm ci'
  if (pm.name === 'pnpm') return 'pnpm install --frozen-lockfile'
  return 'yarn install --immutable'
}

/**
 * Install in CI: locked lockfile, and without scripts unless `installScripts` is true.
 * @param {PackageManager} pm
 * @param {boolean} scripts
 */
export function ciInstall(pm, scripts) {
  if (pm.name === 'npm') return scripts ? 'npm ci' : 'npm ci --ignore-scripts'
  if (pm.name === 'pnpm') return scripts ? 'pnpm install --frozen-lockfile' : 'pnpm install --frozen-lockfile --ignore-scripts'
  // yarn 4 has no --ignore-scripts; enableScripts: false still runs the scripts of workspaces.
  return scripts ? 'yarn install --immutable' : 'yarn install --immutable --mode=skip-build'
}

/** @param {PackageManager} pm */
export function defaultBuild(pm) {
  return `${pm.name} run build`
}

/**
 * Packs into an explicit file name.
 * @param {PackageManager} pm
 * @param {string} outFile absolute path of the .tgz
 * @param {string} outDir directory of outFile (npm packs into a directory)
 * @returns {{ command: string, args: string[], rename: boolean }}
 */
export function packCommand(pm, outFile, outDir) {
  if (pm.name === 'npm') return { command: 'npm', args: ['pack', '--pack-destination', outDir, '--json'], rename: true }
  if (pm.name === 'pnpm') return { command: 'pnpm', args: ['pack', '--out', outFile], rename: false }
  return { command: 'yarn', args: ['pack', '--out', outFile], rename: false }
}

/**
 * Sets the version in package.json (and npm's lockfiles) without running scripts or creating a git tag.
 * @param {string} version
 */
export function npmVersionArgs(version) {
  return ['version', version, '--no-git-tag-version', '--ignore-scripts', '--allow-same-version']
}
