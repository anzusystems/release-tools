// @ts-check
import { readFile, writeFile, mkdir, rename, readdir, stat, copyFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, posix } from 'node:path'
import { run, sh } from '../lib/exec.mjs'
import { detectPackageManager, ciInstall, defaultBuild, packCommand } from '../lib/pm.mjs'
import { readTgz, sha512Hex } from '../lib/tar.mjs'
import { checkManifest, verifyPack, compareWithCandidate, tarballName } from '../lib/package-check.mjs'
import { absolutizeLinks } from '../lib/changelog.mjs'
import { composeBody } from '../lib/release-body.mjs'
import { ActionResult, ARTIFACT_SCHEMA, asMessage } from './common.mjs'

/**
 * Build job, second step: install, setup, checks, build, pack and the checks of the package. Writes the
 * artifact (package, Release text, meta.json) and the output `tarball-sha512`.
 * @param {import('./common.mjs').ActionEnv} a
 * @param {string} statePath
 * @param {string} artifactDir
 */
export async function build(a, statePath, artifactDir) {
  const s = JSON.parse(await readFile(statePath, 'utf8'))
  await rm(artifactDir, { recursive: true, force: true })
  await mkdir(artifactDir, { recursive: true })
  const npm = s.settings.publish === 'npm'
  const cwd = a.workspace
  const env = { ...a.env, ...s.build.ciEnv }

  const body = await releaseText(a, s)
  let tarball = null
  let sha512 = null

  if (!s.alreadyReleased) {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))
    const pm = detectPackageManager(pkg, (p) => existsSync(join(cwd, p)))
    const step = async (/** @type {string} */ what, /** @type {string} */ command, /** @type {string} */ code) => {
      a.log(`::group::${what}: ${command}`)
      try {
        await sh(command, { cwd, env, inherit: true })
      } catch (e) {
        throw new ActionResult(code, `${what} failed: ${command}\n${asMessage(e)}`)
      } finally {
        a.log('::endgroup::')
      }
    }
    if (pm.name !== 'npm') {
      const has = await run('corepack', ['--version'], { allowFail: true, env }).catch(() => ({ code: 1 }))
      if (has.code !== 0) await step('install corepack', 'npm install --global corepack', 'build-failed')
      await step('corepack', 'corepack enable', 'build-failed')
    }
    await step('install', ciInstall(pm, s.build.installScripts), 'build-failed')
    for (const c of s.build.ciSetup) await step('setup', c, 'build-failed')
    if (s.kind !== 'dev') for (const c of s.build.ciChecks) await step('check', c, 'checks-failed')
    if (s.kind === 'prerelease' || s.kind === 'dev') {
      await step('version', `npm pkg set version=${s.version}`, 'build-failed')
    }
    if (s.build.build !== false) await step('build', s.build.build ?? defaultBuild(pm), 'build-failed')

    if (npm) {
      const name = tarballName(s.settings.package, s.version)
      const packDir = join(a.temp, 'release-tools-pack')
      await rm(packDir, { recursive: true, force: true })
      await mkdir(packDir, { recursive: true })
      const out = join(packDir, name)
      const p = packCommand(pm, out, packDir)
      a.log(`::group::pack: ${p.command} ${p.args.join(' ')}`)
      try {
        await run(p.command, p.args, { cwd, env })
      } catch (e) {
        throw new ActionResult('build-failed', `pack failed: ${asMessage(e)}`)
      } finally {
        a.log('::endgroup::')
      }
      if (p.rename) {
        const produced = (await readdir(packDir)).filter((f) => f.endsWith('.tgz'))
        if (produced.length !== 1) throw new ActionResult('build-failed', `npm pack produced ${produced.length} package files`)
        if (produced[0] !== name) await rename(join(packDir, produced[0]), out)
      }
      const data = await readFile(out)
      const entries = readTgz(data)
      const manifestEntry = entries.find((e) => e.path === 'package.json')
      const manifest = manifestEntry ? JSON.parse(manifestEntry.data.toString('utf8')) : null
      const problems = checkManifest(manifest, { packageName: s.settings.package, version: s.version, repo: a.repo, npm: true })
      if (problems.length) throw new ActionResult('package-mismatch', `the packed package.json is not right:\n- ${problems.join('\n- ')}`)
      if (s.build.packVerify) {
        const local = await localFiles(cwd, s.build.packVerify.compare)
        const verify = verifyPack(entries, local, s.build.packVerify)
        if (verify.length) throw new ActionResult('package-mismatch', `pack.verify:\n- ${verify.join('\n- ')}`)
      }
      if ((s.kind === 'final' || s.kind === 'hotfix') && s.settings.requireTestedPrerelease) {
        const registry = /** @type {import('../lib/registry.mjs').Registry} */ (a.registry(s.settings))
        const candidate = readTgz(await registry.tarball(s.settings.package, s.candidate))
        const diffs = compareWithCandidate(entries, candidate, { packageName: s.settings.package, changelogDir: s.build.changelogDir })
        if (diffs.length) {
          throw new ActionResult(
            'package-mismatch',
            `the package differs from the tested prerelease ${s.candidate}; publish a new prerelease:\n- ${diffs.slice(0, 50).join('\n- ')}`,
          )
        }
      }
      await copyFile(out, join(artifactDir, name))
      tarball = name
      sha512 = sha512Hex(data)
    }
  }

  const devBody =
    s.kind === 'dev' && tarball
      ? composeBody({
          repo: a.repo,
          tag: s.tag,
          commit: a.sha,
          changelog: null,
          branch: await branchOf(a),
          installLine: `"${s.settings.package}": "https://github.com/${a.repo}/releases/download/${s.tag}/${tarball}"`,
        })
      : null
  await writeFile(join(artifactDir, 'body.md'), devBody ?? body)
  await writeFile(
    join(artifactDir, 'meta.json'),
    JSON.stringify({ schema: ARTIFACT_SCHEMA, version: s.version, tag: s.tag, kind: s.kind, commit: a.sha, tarball, sha512 }, null, 2),
  )
  a.output('tarball-sha512', sha512 ?? '')
}

/**
 * The visible text of the GitHub Release.
 * @param {import('./common.mjs').ActionEnv} a
 * @param {any} s
 */
async function releaseText(a, s) {
  let changelog = null
  if (s.changelogPath && s.kind !== 'dev') {
    const text = await readFile(join(a.workspace, s.changelogPath), 'utf8').catch(() => null)
    if (text !== null) changelog = absolutizeLinks(text, { repo: a.repo, ref: s.tag, fileDir: posix.dirname(s.changelogPath) })
  }
  return composeBody({
    repo: a.repo,
    tag: s.tag,
    commit: a.sha,
    changelog,
    changelogPath: s.changelogPath,
    branch: await branchOf(a),
    dev: s.kind === 'dev',
  })
}

/**
 * A branch on GitHub whose head is the tagged commit, for the text of prereleases and dev builds.
 * @param {import('./common.mjs').ActionEnv} a
 */
async function branchOf(a) {
  const r = await run('git', ['for-each-ref', `--points-at=${a.sha}`, '--format=%(refname:strip=3)', 'refs/remotes/origin/'], {
    cwd: a.workspace,
    allowFail: true,
  })
  const names = r.stdout.split('\n').filter((n) => n && n !== 'HEAD')
  return names.find((n) => n.startsWith('release/') || n.startsWith('hotfix/')) ?? names[0] ?? null
}

/**
 * Files of the local build under the compare directories, keyed by their path in the package.
 * @param {string} cwd
 * @param {string[]} dirs
 */
async function localFiles(cwd, dirs) {
  /** @type {Map<string, Buffer>} */
  const out = new Map()
  const walk = async (/** @type {string} */ dir) => {
    let items
    try {
      items = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const it of items) {
      const p = join(dir, it.name)
      if (it.isDirectory()) await walk(p)
      else if (it.isFile()) out.set(relative(cwd, p).split('\\').join('/'), await readFile(p))
    }
  }
  for (const d of dirs) {
    const full = join(cwd, d)
    const st = await stat(full).catch(() => null)
    if (st?.isDirectory()) await walk(full)
    else if (st?.isFile()) out.set(d, await readFile(full))
  }
  return out
}

