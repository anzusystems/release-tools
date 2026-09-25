// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ENABLED, resetSandbox, cli, git, dispose } from './helpers.mjs'

const FINAL = { match: 'What do you want to publish?', answer: (/** @type {any} */ c) => /^(final|finish) /.test(c.label) }
const pick = (/** @type {RegExp} */ re) => ({ match: 'What do you want to publish?', answer: (/** @type {any} */ c) => re.test(c.label) })

/**
 * @param {string} folder
 * @param {string} version
 */
async function writeChangelog(folder, version) {
  const path = join(folder, 'doc/changelog', `${version}.md`)
  await writeFile(path, (await readFile(path, 'utf8')).replace('### Added\n', '### Added\n\n- **Something** changed.\n'))
  await git(folder, ['commit', '--quiet', '-am', `docs: changelog ${version}`])
  await git(folder, ['push', '--quiet', '--no-follow-tags', 'origin', `HEAD`])
}

test('e2e: first final, a prerelease, a dev build and cleanup on GitHub', { skip: !ENABLED && 'set RELEASE_E2E=1 (see test/e2e/README.md)' }, async () => {
  const s = await resetSandbox({ version: '1.0.0' })
  try {
    const { result } = await cli('start', s.work, [{ match: 'What do you want to start?', answer: '1.0.0' }])
    const folder = /** @type {any} */ (result).folder
    await writeChangelog(folder, '1.0.0')
    await cli('publish', folder, [pick(/^rc/)])
    assert.ok(await s.registry.version('', '1.0.0-rc.1'), 'the rc is in the mock registry')
    await cli('publish', folder, [FINAL])
    assert.ok(await s.registry.version('', '1.0.0'))
    const rel = await s.gh.releaseByTag('1.0.0')
    assert.ok(rel && !rel.prerelease)
    assert.equal((await s.gh.latestRelease())?.tagName, '1.0.0')
    await git(s.work, ['pull', '--quiet', 'origin', 'main'])
    await git(s.work, ['switch', '--quiet', '-c', 'feature'])
    await writeFile(join(s.work, 'src/index.js'), 'export const x = 2\n')
    await git(s.work, ['commit', '--quiet', '-am', 'feat: two'])
    await cli('publish', s.work, [pick(/^dev/), { match: 'Dev build', answer: 'e2e' }])
    const dev = await s.gh.releaseByTag('1.0.0-dev.e2e')
    assert.ok(dev?.prerelease && dev.assets.length === 1)
  } finally {
    await dispose(s.root)
  }
})

test('e2e: failed checks move the tag; an interrupted final is finished by running it again', { skip: !ENABLED && 'set RELEASE_E2E=1' }, async () => {
  const s = await resetSandbox({ version: '1.0.0' })
  try {
    const { result } = await cli('start', s.work, [{ match: 'What do you want to start?', answer: '1.0.0' }])
    const folder = /** @type {any} */ (result).folder
    await writeChangelog(folder, '1.0.0')
    await writeFile(join(folder, 'FAIL'), 'x')
    await git(folder, ['add', 'FAIL'])
    await git(folder, ['commit', '--quiet', '-m', 'break'])
    await assert.rejects(cli('publish', folder, [FINAL]), /nothing was published/)
    const first = await s.gh.tag('1.0.0')
    await git(folder, ['rm', '--quiet', 'FAIL'])
    await git(folder, ['commit', '--quiet', '-m', 'fix'])
    await assert.rejects(cli('publish', folder, [FINAL], { failAt: 'push-tag' }), /interrupted/)
    await cli('publish', folder, [FINAL])
    const second = await s.gh.tag('1.0.0')
    assert.notEqual(second?.refSha, first?.refSha)
    assert.ok(await s.registry.version('', '1.0.0'))
  } finally {
    await dispose(s.root)
  }
})
