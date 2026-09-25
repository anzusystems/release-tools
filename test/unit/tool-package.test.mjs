// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { SCHEMA } from '../../lib/config.mjs'
import { stubWorkflow } from '../../lib/templates.mjs'

const root = new URL('../../', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

test('package.json of the tool has no install or build scripts and no workspaces (npx would run npm install from git)', () => {
  for (const s of ['build', 'prepare', 'prepack', 'preinstall', 'install', 'postinstall']) {
    assert.equal(pkg.scripts?.[s], undefined, `scripts.${s}`)
  }
  assert.equal(pkg.workspaces, undefined)
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], 'no runtime dependencies')
  assert.equal(pkg.license, 'Apache-2.0')
})

test('the tool releases itself as publish: "none" without a build, with its own stub', () => {
  const config = JSON.parse(readFileSync(new URL('release.config.json', root), 'utf8'))
  assert.equal(config.publish, 'none')
  assert.equal(config.build, false)
  assert.equal(readFileSync(new URL('.github/workflows/release.yml', root), 'utf8'), stubWorkflow({ publish: 'none', environment: 'npmjs-publish' }))
})

test('the schema lists every key the validator knows', () => {
  const keys = Object.keys(SCHEMA.properties).sort()
  assert.deepEqual(keys, [
    '$schema',
    'build',
    'changelogDir',
    'changelogIndex',
    'changelogTemplate',
    'ci',
    'installScripts',
    'node',
    'npmEnvironment',
    'pack',
    'package',
    'publish',
    'releaseWorkflow',
    'repo',
    'requireTestedPrerelease',
    'version',
    'worktree',
  ])
})

test('the CLI loads every module at start: no dynamic imports in the code of the tool', () => {
  const files = []
  for (const dir of ['bin', 'lib', 'lib/commands', 'publish']) {
    for (const f of readdirSync(new URL(dir, root))) if (f.endsWith('.mjs')) files.push(`${dir}/${f}`)
  }
  for (const f of files) {
    const text = readFileSync(new URL(f, root), 'utf8')
    const code = text.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    assert.doesNotMatch(code, /\bimport\s*\(/, `${f} has a dynamic import`)
  }
  const bin = readFileSync(new URL('bin/release.mjs', root), 'utf8')
  for (const f of files.filter((x) => x.startsWith('lib/'))) {
    const rel = `../${f}`
    const reachable = bin.includes(rel) || files.some((g) => readFileSync(new URL(g, root), 'utf8').includes(`/${f.split('/').pop()}'`))
    assert.ok(reachable, `${f} is not imported`)
  }
})
