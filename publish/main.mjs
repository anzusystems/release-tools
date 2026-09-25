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
 * @param {string} mode validate | build | publish
 * @param {NodeJS.ProcessEnv} env
 */
export async function main(mode, env) {
  let a = null
  try {
    a = actionEnv(env)
    const artifactDir = join(required(env, 'RUNNER_TEMP'), 'release-tools-artifact')
    if (mode === 'validate') await validate(a)
    else if (mode === 'build') await build(a, required(env, 'RELEASE_TOOLS_STATE'), artifactDir)
    else if (mode === 'publish') {
      await publish(a, { artifactDir, tagObject: env.TAG_OBJECT ?? '', tarballSha512: env.TARBALL_SHA512 ?? '' })
    } else throw new Error(`unknown mode ${mode}`)
    return 0
  } catch (e) {
    const result = e instanceof ActionResult ? e : e instanceof ReleaseError ? new ActionResult('invalid-tag', e.message) : null
    const annotate = a?.annotate ?? ((/** @type {string} */ level, /** @type {string} */ code, /** @type {string} */ message) => {
      process.stdout.write(`::${level} title=release-tools::${escapeData(`${code}: ${message}`)}\n`)
    })
    if (result) {
      annotate(result.fail ? 'error' : 'notice', result.code, result.message)
      if (!result.fail && mode === 'validate' && env.GITHUB_OUTPUT) outputWriter(env.GITHUB_OUTPUT)('release', 'false')
      return result.fail ? 1 : 0
    }
    const code = mode === 'publish' ? 'publish-failed' : 'build-failed'
    annotate('error', code, asMessage(e))
    process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`)
    return 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv[2] ?? '', process.env).then((code) => process.exit(code))
}
