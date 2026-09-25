// @ts-check
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Git } from '../lib/git.mjs'
import { parseConfig, repoSettings, buildSettings, CONFIG_FILE } from '../lib/config.mjs'
import { classifyVersion, toolTag } from '../lib/tags.mjs'
import { lastStable, lastOfLine, isOlderLine, newerLines } from '../lib/versions.mjs'
import { parseHeader, hasContent } from '../lib/changelog.mjs'
import * as semver from '../lib/semver.mjs'
import { ActionResult, classifyRunTag, releaseState, asMessage, lowerFinalPending } from './common.mjs'
import { bootstrapOf } from '../lib/project.mjs'

const HOUR = 60 * 60 * 1000
const FIVE_MINUTES = 5 * 60 * 1000

/**
 * The age rule: the run must be created less than an hour after the tag date and not more than five minutes
 * before it.
 * @param {Date} runCreated
 * @param {Date | null} tagDate
 * @returns {'ok' | 'too-old' | 'too-new'}
 */
export function tagAge(runCreated, tagDate) {
  if (!tagDate) return 'too-old'
  const age = runCreated.getTime() - tagDate.getTime()
  if (age >= HOUR) return 'too-old'
  if (age < -FIVE_MINUTES) return 'too-new'
  return 'ok'
}

/**
 * @param {Git} git
 * @param {string} ancestor
 * @param {string} commit
 */
async function contains(git, ancestor, commit) {
  if (!(await git.hasObject(ancestor))) return false
  return git.isAncestor(ancestor, commit)
}

/**
 * Whether a commit of `head` on GitHub contains `sha` (the checkout may not have the head).
 * @param {import('../lib/github.mjs').GitHub} gh
 * @param {string} sha
 * @param {string} head branch or sha
 */
async function githubContains(gh, sha, head) {
  try {
    const c = await gh.compare(sha, head)
    return c.status === 'ahead' || c.status === 'identical'
  } catch (e) {
    if (e.status === 404) return false
    throw e
  }
}

/**
 * Build job, first step: state, tag age and validation by the kind of the tag. Writes the state file for the
 * build step and the outputs `release`, `tag-object`, `build` and `node-version`.
 * @param {import('./common.mjs').ActionEnv} a
 */
export async function validate(a) {
  const git = new Git(a.workspace)
  // Whose tag started the run is known only while it is still on the run's commit; otherwise it may have been
  // anybody's: nothing to release, and no trace of the tool.
  const tag = await a.gh.tag(a.tagName).catch((e) => {
    throw new ActionResult('unverified', `the tag ${a.tagName} could not be read: ${asMessage(e)}`)
  })
  if (!tag) throw new ActionResult('nothing', `the tag ${a.tagName} no longer exists`)
  if (tag.commit !== a.sha) throw new ActionResult('nothing', `the tag ${a.tagName} now points to ${tag.commit.slice(0, 12)}, not to the commit of this run`)
  const { info, message } = classifyRunTag(tag)
  a.output('tag-object', tag.refSha)

  const mainConfigText = await git.show('refs/remotes/origin/main', CONFIG_FILE)
  if (mainConfigText === null) throw new ActionResult('invalid-tag', `${CONFIG_FILE} is not in main`)
  const mainRaw = parseConfig(mainConfigText, 'origin/main')
  const mainPkg = await git.show('refs/remotes/origin/main', 'package.json')
  const settings = repoSettings(mainRaw, mainPkg ? JSON.parse(mainPkg) : null)
  if (settings.repo.toLowerCase() !== a.repo.toLowerCase()) throw new ActionResult('invalid-tag', `${CONFIG_FILE} in main names ${settings.repo}, not ${a.repo}`)
  const commitConfig = await git.show(a.sha, CONFIG_FILE)
  if (commitConfig === null) throw new ActionResult('invalid-tag', `${CONFIG_FILE} is missing in the tagged commit`)
  const build = buildSettings(parseConfig(commitConfig, 'the tagged commit'))
  const registry = a.registry(settings)
  const state = await releaseState(settings, a.gh, registry)
  const version = info.version
  const alreadyReleased = info.kind !== 'dev' && (await state.isReleased(version))

  const run = await a.gh.run(Number(a.runId))
  const age = tagAge(run.createdAt, tag.taggerDate)
  if (!alreadyReleased) {
    if (age === 'too-old') {
      throw new ActionResult('invalid-tag', `the tag ${tag.name} is an hour or more older than this run; an old tag pushed again is never released`)
    }
    if (age === 'too-new') {
      throw new ActionResult('invalid-run', `the tag ${tag.name} is newer than this run; this is a re-run of an old run after the tag was created again`)
    }
  }

  const pkgText = await git.show(a.sha, 'package.json')
  const pkg = pkgText ? JSON.parse(pkgText) : null
  const changelogPath = `${build.changelogDir}/${info.core}.md`
  const changelog = await git.show(a.sha, changelogPath)
  const released = state.released
  const kind = message.kind
  const bootstrap = await isBootstrap(a, released)

  if (!alreadyReleased) {
    const lower = kind === 'final' ? await lowerFinalPending(a.gh, version, released) : null
    if (lower) throw new ActionResult('invalid-run', `${lower} is tagged and not released yet; the lower final goes first`)
    if (kind === 'final' || kind === 'hotfix') {
      if (pkg?.version !== version) throw new ActionResult('invalid-tag', `package.json has ${pkg?.version}, not ${version}`)
      if (changelog === null) throw new ActionResult('invalid-tag', `${changelogPath} is missing`)
      const header = parseHeader(changelog)
      if (!header || header.version !== version) throw new ActionResult('invalid-tag', `${changelogPath} has no header for ${version}`)
      if (!hasContent(changelog)) throw new ActionResult('invalid-tag', `${changelogPath} has nothing but headings`)
      if (settings.requireTestedPrerelease) {
        if (!message.candidate) throw new ActionResult('invalid-tag', `requireTestedPrerelease is on, but the tag has no candidate`)
        const c = classifyVersion(message.candidate)
        if (!c || c.kind !== 'prerelease' || c.core !== version) throw new ActionResult('invalid-tag', `the candidate ${message.candidate} is not a prerelease of ${version}`)
        if (!(await state.isReleased(message.candidate))) throw new ActionResult('invalid-tag', `the candidate ${message.candidate} is not released`)
      }
    }
    const last = lastStable(released)
    if (kind === 'final') {
      if (last && !semver.gt(version, last)) throw new ActionResult('invalid-tag', `${version} is not higher than the last released stable version ${last}`)
      if (!bootstrap && last) {
        const lastTag = await a.gh.tag(last)
        if (!lastTag || !(await contains(git, lastTag.commit, a.sha))) {
          throw new ActionResult('invalid-tag', `the tagged commit does not contain the previous release ${last}`)
        }
      }
      // REST, not GraphQL: the fields the build job needs, readable with GITHUB_TOKEN. Only a missing pull request
      // makes the tag invalid; another API error fails the job and can be re-run.
      const pr = message.pr
        ? await a.gh.pullRest(message.pr).catch((e) => {
            if (e.status === 404) return null
            throw e
          })
        : null
      if (!pr) throw new ActionResult('invalid-tag', `the tag names no release pull request, or it does not exist`)
      const valid =
        (pr.state === 'open' && pr.baseRef === 'main' && (await githubContains(a.gh, a.sha, pr.headSha))) ||
        (pr.state === 'merged' && (await githubContains(a.gh, a.sha, 'main')))
      if (!valid) {
        throw new ActionResult('invalid-tag', `the release pull request #${pr.number} is ${pr.state} and does not contain the tagged commit; an old tag pushed again is never released`)
      }
    } else if (kind === 'hotfix') {
      if (!last || !semver.lt(version, last)) throw new ActionResult('invalid-tag', `a hotfix must be lower than the last released stable version${last ? ` ${last}` : ''}`)
      const base = lastOfLine(released, semver.line(version))
      if (!base || semver.bump(base, 'patch') !== version) {
        throw new ActionResult('invalid-tag', `${version} is not the next patch of the last released version of its line${base ? ` (${base})` : ''}`)
      }
      const baseTag = await a.gh.tag(base)
      if (!baseTag || !(await contains(git, baseTag.commit, a.sha))) throw new ActionResult('invalid-tag', `the tagged commit does not contain ${base}`)
      await checkNoNewerLine(a, git, version, released)
      const branchHead = await a.gh.branchSha(`hotfix/${version}`)
      const inBranch = branchHead ? await githubContains(a.gh, a.sha, branchHead) : false
      const mainChangelog = await a.gh.file(changelogPath, 'main')
      if (!inBranch && !(mainChangelog && parseHeader(mainChangelog)?.date)) {
        throw new ActionResult('invalid-tag', `the branch hotfix/${version} does not exist or does not contain the tagged commit`)
      }
    } else if (kind === 'prerelease') {
      if (info.kind !== 'prerelease') throw new ActionResult('invalid-tag', `${version} is not a prerelease`)
      if (await state.isReleased(info.core)) throw new ActionResult('invalid-tag', `${info.core} is already released`)
      if (isOlderLine(info.core, released)) {
        // A prerelease of an older line is a prerelease of its hotfix: it contains the last release of its line.
        const base = lastOfLine(released, semver.line(info.core))
        if (!base) throw new ActionResult('invalid-tag', `no version of the line ${semver.line(info.core)} is released; a prerelease of an older line is a prerelease of its hotfix`)
        const baseTag = await a.gh.tag(base)
        if (!baseTag || !(await contains(git, baseTag.commit, a.sha))) {
          throw new ActionResult('invalid-tag', `the tagged commit does not contain ${base}, the last release of its line`)
        }
        await checkNoNewerLine(a, git, info.core, released)
      }
    } else if (kind === 'dev') {
      if (info.kind !== 'dev') throw new ActionResult('invalid-tag', `${version} is not a dev build version`)
    }
  }

  const nodeVersion = build.node ?? (await nodeFromCommit(git, a.sha, pkg)) ?? '24'
  const statePath = join(a.temp, 'release-tools-state.json')
  await writeFile(
    statePath,
    JSON.stringify({
      version,
      tag: tag.name,
      tagObject: tag.refSha,
      kind,
      info,
      candidate: message.candidate ?? null,
      alreadyReleased,
      settings,
      build,
      changelogPath: changelog === null ? null : changelogPath,
      packageManager: pkg?.packageManager ?? null,
    }),
  )
  a.output('state-file', statePath)
  a.output('node-version', nodeVersion)
  a.output('build', alreadyReleased ? 'false' : 'true')
  a.output('release', 'true')
  a.log(alreadyReleased ? `${version} is already released; the run only adds what is missing` : `${kind} ${version} is valid`)
}

/**
 * No tag of a released stable version of a newer line is an ancestor of the commit.
 * @param {import('./common.mjs').ActionEnv} a
 * @param {Git} git
 * @param {string} version
 * @param {Set<string>} released
 */
async function checkNoNewerLine(a, git, version, released) {
  for (const versions of newerLines(version, released).values()) {
    for (const v of versions) {
      const t = await a.gh.tag(v)
      if (!t) throw new ActionResult('invalid-tag', `${v} is released but has no tag, so the tagged commit cannot be checked against it; restore the tag ${v} (release:publish offers it)`)
      if (await contains(git, t.commit, a.sha)) throw new ActionResult('invalid-tag', `the tagged commit contains ${v} of a newer line`)
    }
  }
}

/**
 * @param {import('./common.mjs').ActionEnv} a
 * @param {Set<string>} released
 */
async function isBootstrap(a, released) {
  return bootstrapOf(a.gh, released)
}

/**
 * Node version of the build: .nvmrc, then engines.node.
 * @param {Git} git
 * @param {string} sha
 * @param {any} pkg
 */
async function nodeFromCommit(git, sha, pkg) {
  const nvmrc = await git.show(sha, '.nvmrc')
  if (nvmrc && nvmrc.trim()) return nvmrc.trim().replace(/^v/, '')
  const engines = pkg?.engines?.node
  return typeof engines === 'string' && engines.trim() ? engines.trim() : null
}
