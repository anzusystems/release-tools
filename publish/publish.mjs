// @ts-check
import { readFile, mkdtemp, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from '../lib/exec.mjs'
import { readTgz, integrity, sha512Hex } from '../lib/tar.mjs'
import { checkManifest } from '../lib/package-check.mjs'
import { withFooter, parseFooter } from '../lib/release-body.mjs'
import { lastStable, lastOfLine, npmTagFor, isLatest } from '../lib/versions.mjs'
import { MockRegistry } from '../lib/registry.mjs'
import * as semver from '../lib/semver.mjs'
import { ActionResult, SUPPORTED_ARTIFACT_SCHEMAS, currentTag, classifyRunTag, settingsFromMain, releaseState } from './common.mjs'

/**
 * Publish job: no checkout of the project, a fixed environment. Checks the artifact against the outputs of the
 * build job and the tag against the tag object the build job saw, publishes to npm, checks the commit npm
 * recorded and creates the GitHub Release. All decisions (npm tag, prerelease, Latest) are computed here.
 * @param {import('./common.mjs').ActionEnv} a
 * @param {{ artifactDir: string, tagObject: string, tarballSha512: string }} input
 */
export async function publish(a, input) {
  const meta = JSON.parse(await readFile(join(input.artifactDir, 'meta.json'), 'utf8').catch(() => 'null'))
  if (!meta || !SUPPORTED_ARTIFACT_SCHEMAS.includes(meta.schema)) {
    throw new ActionResult('invalid-run', `the artifact of the build job has an unsupported format (${meta?.schema ?? 'none'}); the tag must be created again`)
  }
  if (!/^[0-9a-f]{40}$/.test(input.tagObject)) throw new ActionResult('invalid-run', 'the build job reported no tag object')
  const tag = await currentTag(a)
  if (tag.refSha !== input.tagObject) {
    throw new ActionResult('invalid-run', `the tag ${tag.name} is not the tag object this run was built from (it was created again)`)
  }
  const { info, message } = classifyRunTag(tag)
  if (meta.version !== info.version || meta.tag !== tag.name || meta.commit !== a.sha) {
    throw new ActionResult('invalid-run', 'the artifact belongs to another version or commit')
  }
  const { settings } = await settingsFromMain(a.gh)
  const npm = settings.publish === 'npm'
  const registry = a.registry(settings)
  const kind = message.kind
  const version = info.version

  let tgzPath = null
  let tgz = null
  if (npm && meta.tarball) {
    if (!/^[\w.@-]+\.tgz$/.test(meta.tarball)) throw new ActionResult('invalid-run', 'invalid package file name in the artifact')
    tgzPath = join(input.artifactDir, meta.tarball)
    tgz = await readFile(tgzPath)
    if (sha512Hex(tgz) !== input.tarballSha512) throw new ActionResult('invalid-run', 'the package is not the one the build job produced (sha512 differs)')
    const entries = readTgz(tgz)
    const m = entries.find((e) => e.path === 'package.json')
    const problems = checkManifest(m ? JSON.parse(m.data.toString('utf8')) : null, { packageName: settings.package, version, repo: a.repo, npm: true })
    if (problems.length) throw new ActionResult('package-mismatch', `the packed package.json is not right:\n- ${problems.join('\n- ')}`)
  }

  const state = await releaseState(settings, a.gh, registry)
  const wasReleased = kind !== 'dev' && (await state.isReleased(version))
  const others = new Set([...state.released].filter((v) => v !== version))
  let npmTag = null

  if (!wasReleased) {
    // A re-run of this job does not run the build job again: the order is checked against the registry now.
    const last = lastStable(others)
    if (kind === 'final' && last && !semver.gt(version, last)) {
      throw new ActionResult('invalid-run', `${version} is no longer higher than the last released stable version ${last}`)
    }
    if (kind === 'hotfix') {
      const base = lastOfLine(others, semver.line(version))
      if (!base || semver.bump(base, 'patch') !== version || !last || !semver.lt(version, last)) {
        throw new ActionResult('invalid-run', `${version} is no longer the next patch of its line`)
      }
    }
    if (kind === 'prerelease' && (await state.isReleased(info.core))) {
      throw new ActionResult('invalid-run', `${info.core} is already released`)
    }
  }

  if (npm && kind !== 'dev') {
    let result = 'exists'
    if (!wasReleased) {
      if (!tgz || !tgzPath) throw new ActionResult('invalid-run', 'the artifact has no package; the version was released when the build job ran')
      const distTags = await /** @type {any} */ (registry).distTags(settings.package)
      npmTag = npmTagFor({ version, kind: /** @type {any} */ (kind), distTags, released: others })
      await currentTagIs(a, input.tagObject)
      result = await publishToNpm(a, registry, { version, tgzPath, tgz, tag: npmTag })
      a.checkpoint?.('action-npm')
    }
    // Released before (another run, or an earlier attempt of this job): only the package of this run counts.
    if (result === 'exists' && tgz) {
      const v = await /** @type {any} */ (registry).version(settings.package, version)
      if (!v || v.integrity !== integrity(tgz)) {
        throw new ActionResult('integrity-mismatch', `${version} is already on npm with another content (integrity ${v?.integrity ?? 'unknown'})`)
      }
      a.log(`${version} was already on npm with the same content`)
    }
    const commit = await /** @type {any} */ (registry).provenanceCommit(settings.package, version, { waitMs: 180000 })
    if (commit === null) {
      throw new ActionResult('release-deferred', `${version} on npm has no provenance; release:publish checks its commit and adds the GitHub Release`)
    }
    if (commit === undefined) {
      throw new ActionResult('release-deferred', `the provenance of ${version} could not be read yet; run release:publish to add the GitHub Release`)
    }
    if (commit !== a.sha) {
      throw new ActionResult('commit-mismatch', `${version} on npm was built from ${commit.slice(0, 12)}, not from the tagged commit ${a.sha.slice(0, 12)}`)
    }
  }

  // GitHub Release
  await currentTagIs(a, input.tagObject)
  const releases = await a.gh.releases()
  const existing = releases.find((r) => r.tagName === tag.name)
  const prerelease = info.kind !== 'stable'
  const latest = !prerelease && isLatest(version, others)
  let release = existing ?? null
  if (existing?.draft) {
    a.annotate('notice', 'release-deferred', `the GitHub Release of ${tag.name} is a draft; release:publish publishes it`)
  } else if (!existing && npm && kind !== 'dev' && !tgz) {
    // The build job ran after the version was released and packed nothing: its content cannot be compared here.
    a.annotate('notice', 'release-deferred', `${version} was released before this run; release:publish adds its GitHub Release`)
  } else if (!existing) {
    const body = await readFile(join(input.artifactDir, 'body.md'), 'utf8')
    release = await a.gh.createRelease({
      tag: tag.name,
      name: tag.name,
      body: withFooter(body, { commit: a.sha, runId: a.runId, kind }),
      prerelease,
      latest,
      commit: a.sha,
    })
    a.checkpoint?.('action-release')
    if (info.kind === 'dev' && tgzPath) await a.gh.uploadAsset(release.id, tgzPath)
    a.log(`created the GitHub Release ${tag.name}`)
  } else if (info.kind === 'dev' && tgzPath && !existing.assets.some((x) => x.name === meta.tarball)) {
    await a.gh.uploadAsset(existing.id, tgzPath)
  }

  const warnings = []
  if (npm && kind !== 'dev' && tgz && !wasReleased) {
    const v = await /** @type {any} */ (registry).version(settings.package, version)
    if (!v || v.integrity !== integrity(tgz)) warnings.push(`the integrity of ${version} in the registry differs from the package`)
    const tags = await /** @type {any} */ (registry).distTags(settings.package)
    if (npmTag && tags[npmTag] !== version) warnings.push(`the npm tag ${npmTag} points to ${tags[npmTag] ?? 'nothing'}, not to ${version}`)
  }
  for (const w of warnings) a.annotate('warning', 'registry-check', w)

  const footer = parseFooter(release?.body)
  const releasedNow = !!release && !release.draft && footer?.runId === a.runId
  const published = kind === 'dev' ? !!release && !release.draft : await state.isReleased(version)
  const latestNow = !prerelease && (await a.gh.latestRelease())?.tagName === tag.name
  a.output('version', version)
  a.output('tag', tag.name)
  a.output('prerelease', String(prerelease))
  a.output('latest', String(latestNow))
  a.output('published', String(published))
  a.output('released-now', String(releasedNow))
  a.summary(
    [
      `### ${tag.name}`,
      '',
      npm && kind !== 'dev' ? `- npm: https://www.npmjs.com/package/${settings.package}/v/${version} (npm tag \`${npmTag}\`)` : null,
      `- tag: https://github.com/${a.repo}/tree/${tag.name}`,
      release ? `- GitHub Release: ${release.url}${release.draft ? ' (draft)' : ''}` : null,
      ...warnings.map((w) => `- warning: ${w}`),
    ]
      .filter((l) => l !== null)
      .join('\n'),
  )
  if (release && !release.draft) a.annotate('notice', 'released', `${tag.name} is released`)
}

/**
 * @param {import('./common.mjs').ActionEnv} a
 * @param {string} tagObject
 */
async function currentTagIs(a, tagObject) {
  const tag = await currentTag(a)
  if (tag.refSha !== tagObject) throw new ActionResult('invalid-run', `the tag ${tag.name} was created again while this run was running`)
}

/**
 * `npm publish` of the tarball from an empty directory, with an empty user configuration, without npm_config_*
 * variables and with explicit flags (the command line wins over publishConfig).
 * @param {import('./common.mjs').ActionEnv} a
 * @param {any} registry
 * @param {{ version: string, tgzPath: string, tgz: Buffer, tag: string }} o
 * @returns {Promise<'published' | 'exists'>}
 */
async function publishToNpm(a, registry, o) {
  if (registry instanceof MockRegistry) {
    a.log(`mock registry: would run npm publish ${o.tgzPath} --tag ${o.tag}`)
    return registry.publish({ version: o.version, commit: a.sha, integrity: integrity(o.tgz), tarballFile: o.tgzPath, tag: o.tag })
  }
  const dir = await mkdtemp(join(a.temp, 'release-tools-npm-'))
  const userconfig = join(dir, '.npmrc-empty')
  await writeFile(userconfig, '')
  const file = join(dir, 'package.tgz')
  await copyFile(o.tgzPath, file)
  if (a.npmPublish) {
    const r = await a.npmPublish({ file, tag: o.tag, cwd: dir })
    if (r.exists) return 'exists'
    if (!r.ok) throw new ActionResult('publish-failed', `npm publish failed:\n${r.output}`)
    return 'published'
  }
  const env = cleanEnv(a.env)
  const npmVersion = (await run('npm', ['--version'], { cwd: dir, env })).stdout.trim()
  if (!semver.valid(npmVersion) || semver.lt(npmVersion, '11.5.1')) {
    throw new ActionResult('publish-failed', `npm ${npmVersion} is too old for trusted publishing (11.5.1 or newer)`)
  }
  const args = [
    'publish',
    file,
    '--registry=https://registry.npmjs.org',
    '--provenance',
    '--access',
    'public',
    '--tag',
    o.tag,
    '--dry-run=false',
    `--userconfig=${userconfig}`,
  ]
  a.log(`npm ${args.join(' ')}`)
  const r = await run('npm', args, { cwd: dir, env, allowFail: true })
  const output = `${r.stdout}\n${r.stderr}`
  if (r.code === 0) return 'published'
  if (/cannot publish over (the )?previously published version|EPUBLISHCONFLICT/i.test(output)) return 'exists'
  throw new ActionResult('publish-failed', `npm publish failed:\n${output.trim().split('\n').slice(-30).join('\n')}`)
}

/**
 * The environment without variables npm reads as configuration (npm matches the prefix case-insensitively).
 * @param {NodeJS.ProcessEnv} env
 */
export function cleanEnv(env) {
  /** @type {NodeJS.ProcessEnv} */
  const out = {}
  for (const [k, v] of Object.entries(env)) {
    if (/^npm_config_/i.test(k)) continue
    out[k] = v
  }
  return out
}

