// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setupProject } from '../helpers/project.mjs'

const pick = (/** @type {RegExp} */ re) => ({ match: 'What do you want to publish?', answer: (/** @type {any} */ c) => re.test(c.label) })

/**
 * @param {import('../helpers/project.mjs').TestProject} p
 */
async function startRelease(p) {
  await p.cli('start', [{ match: 'What do you want to start?', answer: '1.0.0' }])
  await p.writeChangelog('release/1.0.0', '1.0.0')
  return p.folder('release/1.0.0')
}

test('pack.verify: the package must equal the local build and may hold only allowed files', async (t) => {
  const p = await setupProject({ version: '1.0.0', config: { pack: { verify: { compare: ['dist'], allow: ['package.json'] } } } })
  t.after(() => p.dispose())
  const folder = await startRelease(p)
  await p.cli('publish', [pick(/^beta/)], { cwd: folder })
  assert.ok(p.registry.store.has('1.0.0-beta.1'))
  const pkgPath = join(folder, 'package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  pkg.files = ['dist', 'src']
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  await p.commit(folder, {}, 'chore: ship src too')
  await assert.rejects(p.cli('publish', [pick(/^beta/)], { cwd: folder }), /failed/)
  assert.equal(p.registry.store.has('1.0.0-beta.2'), false)
  const run = p.gh.runList.find((r) => r.headBranch === '1.0.0-beta.2')
  assert.match(run.jobs.find((/** @type {any} */ j) => j.name === 'build').annotations[0].message, /^package-mismatch: pack.verify:[\s\S]*not allowed in the package: src\/index.js/)
})

test('publishConfig with a registry or a tag is refused in the packed manifest', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p)
  const pkgPath = join(folder, 'package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  pkg.publishConfig = { registry: 'https://evil.example.com', '@x:registry': 'https://evil.example.com', tag: 'latest' }
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  await p.commit(folder, {}, 'chore: publishConfig')
  await assert.rejects(p.cli('publish', [pick(/^beta/)], { cwd: folder }), /failed/)
  const run = p.gh.runList.find((r) => r.headBranch === '1.0.0-beta.1')
  const message = run.jobs.find((/** @type {any} */ j) => j.name === 'build').annotations[0].message
  assert.match(message, /publishConfig\.registry is not allowed/)
  assert.match(message, /publishConfig\.@x:registry is not allowed/)
  assert.match(message, /publishConfig\.tag is not allowed/)
  assert.equal(p.registry.store.size, 0)
})

test('the version inside the package is set for prereleases and dev builds', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p)
  await p.cli('publish', [pick(/^alpha/)], { cwd: folder })
  const { readTgz } = await import('../../lib/tar.mjs')
  const entries = readTgz(/** @type {any} */ (p.registry.store.get('1.0.0-alpha.1')).tarball)
  assert.equal(JSON.parse(entries.find((e) => e.path === 'package.json')?.data.toString() ?? '{}').version, '1.0.0-alpha.1')
})
