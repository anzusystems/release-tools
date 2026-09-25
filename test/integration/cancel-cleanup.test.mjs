// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupProject, git } from '../helpers/project.mjs'

const pick = (/** @type {RegExp} */ re) => ({ match: 'What do you want to publish?', answer: (/** @type {any} */ c) => re.test(c.label) })
const FINAL = pick(/^(final|finish) /)

/**
 * @param {import('../helpers/project.mjs').TestProject} p
 * @param {string} startAnswer
 * @param {string} version
 */
async function startRelease(p, startAnswer, version) {
  await p.cli('start', [{ match: 'What do you want to start?', answer: startAnswer }])
  await p.writeChangelog(`release/${version}`, version)
  return p.folder(`release/${version}`)
}

test('cancel: pull requests into the branch, the release pull request, the unreleased tag and its runs, the folder', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  await p.cli('publish', [pick(/^beta/)], { cwd: folder })
  await p.commit(folder, { FAIL: 'x' }, 'break')
  await assert.rejects(p.cli('publish', [FINAL], { cwd: folder }), /nothing was published/)
  assert.ok(await p.gh.tag('1.0.0'))
  await git(p.bare, ['branch', 'feature', 'main'])
  await p.gh.createPull({ head: 'feature', base: 'release/1.0.0', title: 'feature', body: '' })
  await p.cli('start', [
    { match: 'What do you want to start?', answer: (/** @type {any} */ c) => c.label.startsWith('release/1.0.0') },
    { match: 'targets release/1.0.0', answer: 'close it' },
  ])
  assert.equal(await p.gh.tag('1.0.0'), null, 'the unreleased tag is deleted')
  assert.equal(p.gh.runList.filter((r) => r.headBranch === '1.0.0' && r.status === 'completed' && !r.deleted).length, 0, 'its finished runs are deleted')
  assert.equal(await p.gh.branchSha('release/1.0.0'), null)
  assert.equal(p.exists(folder), false)
  assert.ok(p.gh.pullList.every((x) => x.state !== 'open'), 'no open pull request is left')
  assert.ok(p.registry.store.has('1.0.0-beta.1'), 'prereleases stay')
  assert.ok(await p.gh.tag('1.0.0-beta.1'))
  // 1.0.0 can be started again.
  await startRelease(p, '1.0.0', '1.0.0')
})

test('cancel is refused for a released version', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  await assert.rejects(p.cli('publish', [FINAL], { cwd: folder, failAt: 'push-tag' }), /interrupted/)
  await p.gh.pump()
  assert.ok(p.registry.store.has('1.0.0'))
  await assert.rejects(
    p.cli('start', [{ match: 'What do you want to start?', answer: (/** @type {any} */ c) => c.label.startsWith('release/1.0.0') }]),
    /released but not merged into main yet/,
  )
  assert.ok(await p.gh.tag('1.0.0'), 'the tag of a released version stays')
  await p.cli('publish', [FINAL], { cwd: folder })
  assert.ok(await p.isAncestor('1.0.0^{commit}', 'main'))
})

test('cleanup: dev builds and tags that never became a release, older than two hours; released versions stay', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  await p.commit(folder, { FAIL: 'x' }, 'break')
  await assert.rejects(p.cli('publish', [pick(/^beta/)], { cwd: folder }), /failed/)
  await p.commit(folder, { FAIL: null }, 'fix')
  await p.cli('publish', [pick(/^beta/)], { cwd: folder })
  await p.cli('publish', [pick(/^dev/), { match: 'Dev build', answer: 'one' }], { cwd: folder })
  assert.deepEqual(await p.cli('cleanup', []), [], 'nothing older than two hours yet')
  p.gh.offsetMs = 3 * 60 * 60 * 1000
  const done = await p.cli('cleanup', [
    { match: 'What to delete?', answer: 'delete all' },
    { match: 'Delete these', answer: true },
  ])
  assert.deepEqual([.../** @type {string[]} */ (done)].sort(), ['1.0.0-beta.1', '1.0.0-beta.2.dev.one'].sort())
  assert.equal(await p.gh.tag('1.0.0-beta.1'), null)
  assert.equal(await p.gh.tag('1.0.0-beta.2.dev.one'), null)
  assert.equal(p.gh.releaseList.some((r) => r.tagName === '1.0.0-beta.2.dev.one'), false)
  assert.ok(await p.gh.tag('1.0.0-beta.2'), 'the released prerelease stays')
  assert.equal(p.gh.runList.filter((r) => r.headBranch === '1.0.0-beta.1' && !r.deleted).length, 0, 'its runs are deleted')
  assert.deepEqual(await p.cli('cleanup', []), [], 'nothing left')
})

test('cleanup interrupted after deleting a tag: runs first, then the tag; running it again deletes the Release', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  await p.cli('publish', [pick(/^dev/), { match: 'Dev build', answer: 'one' }], { cwd: folder })
  p.gh.offsetMs = 3 * 60 * 60 * 1000
  const answers = [
    { match: 'What to delete?', answer: 'delete all' },
    { match: 'Delete these', answer: true },
  ]
  await assert.rejects(p.cli('cleanup', answers, { failAt: 'cleanup-tag' }), /interrupted/)
  assert.equal(await p.gh.tag('1.0.0-dev.one'), null, 'the tag is gone')
  assert.equal(p.gh.runList.filter((r) => r.headBranch === '1.0.0-dev.one' && !r.deleted).length, 0, 'its runs were deleted before the tag')
  assert.ok(p.gh.releaseList.some((r) => r.tagName === '1.0.0-dev.one'), 'the Release still holds the item')
  await p.cli('cleanup', answers)
  assert.equal(p.gh.releaseList.some((r) => r.tagName === '1.0.0-dev.one'), false)
})

test('a deleted tag pushed again from an old clone is never released (tag age)', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  await p.commit(folder, { FAIL: 'x' }, 'break')
  await assert.rejects(p.cli('publish', [pick(/^beta/)], { cwd: folder }), /failed/)
  const tag = await p.gh.tag('1.0.0-beta.1')
  assert.ok(tag)
  // a colleague's clone keeps the tag object
  const clone = `${p.root}/colleague`
  await git(p.root, ['clone', '--quiet', p.bare, clone])
  await git(clone, ['fetch', '--quiet', 'origin', '+refs/tags/*:refs/tags/*'])
  await p.commit(folder, { FAIL: null }, 'fix')
  p.gh.offsetMs = 3 * 60 * 60 * 1000
  await p.cli('cleanup', [{ match: 'What to delete?', answer: 'delete all' }, { match: 'Delete these', answer: true }])
  assert.equal(await p.gh.tag('1.0.0-beta.1'), null)
  await git(clone, ['push', '--quiet', 'origin', 'refs/tags/1.0.0-beta.1'])
  await p.gh.sync()
  await p.gh.pump()
  const runs = p.gh.runList.filter((r) => r.headBranch === '1.0.0-beta.1' && !r.deleted)
  assert.equal(runs.length, 1)
  const build = runs[0].jobs.find((/** @type {any} */ j) => j.name === 'build')
  assert.equal(build.conclusion, 'failure')
  assert.match(build.annotations[0]?.message ?? '', /^invalid-tag: .*older than this run/)
  assert.equal(p.registry.store.has('1.0.0-beta.1'), false)
})
