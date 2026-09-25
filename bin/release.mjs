#!/usr/bin/env node
// @ts-check
// Every module and data file is imported here, at start: npx keeps the package in a folder named after the
// specification (not the version) and another run may replace it with a newer commit while this one waits.
import { readFileSync, realpathSync } from 'node:fs'
import { createContext } from '../lib/context.mjs'
import { TerminalUI } from '../lib/ui.mjs'
import { ReleaseError, DryRunStop, Interrupted } from '../lib/util.mjs'
import { init } from '../lib/commands/init.mjs'
import { start } from '../lib/commands/start.mjs'
import { publish } from '../lib/commands/publish.mjs'
import { cleanup } from '../lib/commands/cleanup.mjs'
import '../lib/commands/final.mjs'
import '../lib/commands/cancel.mjs'
import '../lib/commands/common.mjs'
import '../lib/templates.mjs'
import '../lib/tar.mjs'
import '../lib/package-check.mjs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const HELP = `release-tools ${pkg.version}

Usage: release-tools <command> [--dry-run]

Commands:
  init      once per project: the release workflow, release.config.json, the aliases, the changelog template
  start     start a release or a hotfix, cancel one, or clean up a leftover
  publish   publish a prerelease, a dev build or the final version
  cleanup   delete dev builds and tags that never became a release

Options:
  --dry-run     run all checks and print what would change, change nothing
  --no-install  start: do not install in the new folder
  init: --publish npm|none, --workflow <file>, --check <command> (repeatable), --node <version>, --no-build, --no-index

Guide: https://github.com/anzusystems/release-tools/blob/main/docs/guide.md`

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {Record<string, any>} */
  const options = {}
  let command = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined) throw new ReleaseError(`${a} needs a value`)
      return v
    }
    if (a === '--dry-run') options.dryRun = true
    else if (a === '--help' || a === '-h') options.help = true
    else if (a === '--version' || a === '-v') options.version = true
    else if (a === '--no-install') options.noInstall = true
    else if (a === '--publish') options.publish = value()
    else if (a === '--workflow') options.workflow = value()
    else if (a === '--check') (options.checks ??= []).push(value())
    else if (a === '--node') options.node = value()
    else if (a === '--no-build') options.build = false
    else if (a === '--no-index') options.index = false
    else if (!a.startsWith('-') && !command) command = a
    else throw new ReleaseError(`unknown argument ${a}`, { hint: 'release-tools --help' })
  }
  if (options.publish && !['npm', 'none'].includes(options.publish)) throw new ReleaseError('--publish is npm or none')
  return { command, options }
}

async function main() {
  const ui = new TerminalUI()
  let parsed
  try {
    parsed = parseArgs(process.argv.slice(2))
  } catch (e) {
    ui.info(e.message)
    return 2
  }
  const { command, options } = parsed
  if (options.version) {
    ui.info(pkg.version)
    return 0
  }
  if (options.help || !command) {
    ui.info(HELP)
    return command || options.help ? 0 : 2
  }
  const commands = { init, start, publish, cleanup }
  const run = commands[/** @type {keyof typeof commands} */ (command)]
  if (!run) {
    ui.info(`unknown command ${command}\n\n${HELP}`)
    return 2
  }
  try {
    const ctx = await createContext({ cwd: process.cwd(), ui, dryRun: !!options.dryRun, requireConfig: command !== 'init', options })
    await run(ctx)
    return 0
  } catch (e) {
    if (e instanceof DryRunStop) {
      ui.info('--dry-run: all checks up to this step passed; nothing was changed.')
      return 0
    }
    if (e instanceof Interrupted) {
      ui.info(e.message)
      return 3
    }
    if (e instanceof ReleaseError) {
      ui.info(`\n✗ ${e.message}${e.hint ? `\n  → ${e.hint}` : ''}`)
      return 1
    }
    ui.info(`\n✗ ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    return 1
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname === realpathSync(process.argv[1])) {
  main().then((code) => process.exit(code))
}
