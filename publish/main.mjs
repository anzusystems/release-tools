#!/usr/bin/env node
// @ts-check
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { GitHub } from '../lib/github.mjs'
import { registryFor } from '../lib/registry.mjs'
import { ReleaseError } from '../lib/util.mjs'
import { ActionResult, required, outputWriter, escapeData, escapeProperty, asMessage } from './common.mjs'
import { validate } from './validate.mjs'
import { build } from './build.mjs'
import { publish } from './publish.mjs'

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {import('./common.mjs').ActionEnv}
 */
export function actionEnv(env) {
  const repo = required(env, 'GITHUB_REPOSITORY')
  const gh = new GitHub({ token: required(env, 'GH_TOKEN'), repo })
  const outputFile = required(env, 'GITHUB_OUTPUT')
  const summaryFile = env.GITHUB_STEP_SUMMARY
  const ref = required(env, 'GITHUB_REF')
  if (!ref.startsWith('refs/tags/')) throw new ActionResult('nothing', `${ref} is not a tag`)
  /** @type {NodeJS.ProcessEnv} */
  const childEnv = { ...env }
  delete childEnv.GH_TOKEN
  delete childEnv.GITHUB_TOKEN
  return {
    repo,
    sha: required(env, 'GITHUB_SHA'),
    tagName: ref.slice('refs/tags/'.length),
    runId: required(env, 'GITHUB_RUN_ID'),
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? '1',
    workspace: env.GITHUB_WORKSPACE ?? process.cwd(),
    temp: required(env, 'RUNNER_TEMP'),
    gh,
    registry: (settings) => (settings.publish === 'npm' ? registryFor(gh) : null),
    output: outputWriter(outputFile),
    summary: (md) => {
      if (summaryFile) appendFileSync(summaryFile, `${md}\n`)
    },
    annotate: (level, code, message) => {
      process.stdout.write(`::${level} title=${escapeProperty('release-tools')}::${escapeData(`${code}: ${message}`)}\n`)
    },
    log: (m) => process.stdout.write(`${m}\n`),
    env: childEnv,
  }
}

/**
 * Runs one mode with an action environment; the errors become the result annotation.
 * @param {string} mode validate | build | publish
 * @param {import('./common.mjs').ActionEnv} a
 * @param {{ artifactDir: string, statePath?: string, tagObject?: string, tarballSha512?: string }} io
 * @returns {Promise<{ ok: boolean, code: string | null, error?: unknown }>}
 */
export async function runMode(mode, a, io) {
  try {
    if (mode === 'validate') await validate(a)
    else if (mode === 'build') await build(a, /** @type {string} */ (io.statePath), io.artifactDir)
    else if (mode === 'publish') await publish(a, { artifactDir: io.artifactDir, tagObject: io.tagObject ?? '', tarballSha512: io.tarballSha512 ?? '' })
    else throw new Error(`unknown mode ${mode}`)
    return { ok: true, code: null }
  } catch (e) {
    const result = e instanceof ActionResult ? e : e instanceof ReleaseError ? new ActionResult('invalid-tag', e.message) : null
    if (result) {
      a.annotate(result.fail ? 'error' : 'notice', result.code, result.message)
      if (!result.fail && mode === 'validate') a.output('release', 'false')
      return { ok: !result.fail, code: result.code, error: e }
    }
    const code = mode === 'publish' ? 'publish-failed' : 'build-failed'
    a.annotate('error', code, asMessage(e))
    return { ok: false, code, error: e }
  }
}

/**
 * @param {string} mode validate | build | publish
 * @param {NodeJS.ProcessEnv} env
 */
export async function main(mode, env) {
  let a
  try {
    a = actionEnv(env)
  } catch (e) {
    const result = e instanceof ActionResult ? e : null
    process.stdout.write(`::${result && !result.fail ? 'notice' : 'error'} title=release-tools::${escapeData(`${result?.code ?? 'unverified'}: ${asMessage(e)}`)}\n`)
    if (result && !result.fail && env.GITHUB_OUTPUT) outputWriter(env.GITHUB_OUTPUT)('release', 'false')
    return result && !result.fail ? 0 : 1
  }
  const r = await runMode(mode, a, {
    artifactDir: join(required(env, 'RUNNER_TEMP'), 'release-tools-artifact'),
    statePath: env.RELEASE_TOOLS_STATE,
    tagObject: env.TAG_OBJECT,
    tarballSha512: env.TARBALL_SHA512,
  })
  if (!r.ok && r.error && !(r.error instanceof ActionResult)) process.stderr.write(`${r.error instanceof Error ? r.error.stack : String(r.error)}\n`)
  return r.ok ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv[2] ?? '', process.env).then((code) => process.exit(code))
}
