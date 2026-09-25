// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
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

test('the folder: uncommitted changes, conflict markers and diverged branches stop the command before any change', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  await writeFile(join(folder, 'src/index.js'), 'export const x = 42\n')
  await assert.rejects(p.cli('publish', [pick(/^beta/)], { cwd: folder }), /uncommitted changes/)
  await git(folder, ['checkout', '--', 'src/index.js'])
  await p.commit(folder, { 'src/c.js': '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n' }, 'oops', { push: false })
  await assert.rejects(p.cli('publish', [pick(/^beta/)], { cwd: folder }), /conflict markers/)
  await git(folder, ['reset', '--quiet', '--hard', 'HEAD~1'])
  // someone else pushed to the branch, and there is a local commit as well
  const side = join(p.root, 'side-diverge')
  await git(p.root, ['clone', '--quiet', '-b', 'release/1.0.0', p.bare, side])
  await git(side, ['-c', 'user.email=x@example.com', '-c', 'user.name=X', 'commit', '--quiet', '--allow-empty', '-m', 'theirs'])
  await git(side, ['push', '--quiet', 'origin', 'HEAD:refs/heads/release/1.0.0'])
  await p.commit(folder, { 'src/d.js': 'd\n' }, 'ours', { push: false })
  await assert.rejects(p.cli('publish', [pick(/^beta/)], { cwd: folder }), /diverged/)
  assert.equal(await p.gh.tag('1.0.0-beta.1'), null)
  await git(folder, ['reset', '--quiet', '--hard', 'HEAD~1'])
  // behind only: fast-forwarded
  await p.cli('publish', [pick(/^beta/)], { cwd: folder })
  assert.equal(await git(folder, ['log', '-1', '--format=%s']), 'theirs')
  assert.ok(p.registry.store.has('1.0.0-beta.1'))
})

test('a folder removed by hand is created again from its branch; outside the folder the open releases are offered', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  await rm(folder, { recursive: true, force: true })
  await git(p.work, ['worktree', 'prune'])
  await p.cli('publish', [
    { match: 'What do you want to publish?', answer: (/** @type {any} */ c) => c.label === 'release/1.0.0' },
    { match: 'release/1.0.0', answer: (/** @type {any} */ c) => c.label.startsWith('final') },
  ])
  assert.ok(p.registry.store.has('1.0.0'))
  assert.ok(await p.isAncestor('1.0.0^{commit}', 'main'))
})

test('a leftover of a released release is merged into the next release, then removed', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  p.gh.afterRun = async (r) => {
    if (r.headBranch !== '1.0.0') return
    p.gh.afterRun = null
    await p.commit(folder, { 'src/late.js': 'late\n' }, 'feat: late')
  }
  await p.cli('publish', [FINAL], { cwd: folder })
  assert.ok(await p.gh.branchSha('release/1.0.0'), 'the branch with the late commit stays')
  assert.ok(p.exists(folder))
  await p.cli('start', [
    { match: 'What do you want to start?', answer: 'minor' },
    { match: 'Merge them into release/1.1.0?', answer: true },
  ])
  assert.equal(await git(p.folder('release/1.1.0'), ['show', 'HEAD:src/late.js']), 'late')
  assert.equal(await p.gh.branchSha('release/1.0.0'), null, 'the leftover is removed')
  assert.equal(p.exists(folder), false)
})

test('cancel a hotfix: its branch on GitHub, its unreleased tag and its folder', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await p.cli('publish', [FINAL], { cwd: await startRelease(p, '1.0.0', '1.0.0') })
  await p.cli('publish', [FINAL], { cwd: await startRelease(p, 'minor', '1.1.0') })
  await p.cli('start', [{ match: 'What do you want to start?', answer: '1.0.0 → 1.0.1' }])
  const hf = p.folder('hotfix/1.0.1')
  await p.writeChangelog('hotfix/1.0.1', '1.0.1')
  await p.commit(hf, { FAIL: 'x' }, 'break')
  await assert.rejects(p.cli('publish', [FINAL], { cwd: hf }), /nothing was published/)
  assert.ok(await p.gh.tag('1.0.1'))
  await p.cli('start', [{ match: 'What do you want to start?', answer: (/** @type {any} */ c) => c.label.startsWith('hotfix/1.0.1') }])
  assert.equal(await p.gh.tag('1.0.1'), null)
  assert.equal(await p.gh.branchSha('hotfix/1.0.1'), null)
  assert.equal(p.exists(hf), false)
  await p.cli('start', [{ match: 'What do you want to start?', answer: '1.0.0 → 1.0.1' }])
  assert.ok(p.exists(hf), '1.0.1 can be started again')
})

test('cancel deletes only what it checked: a branch pushed or a file changed during the question stays', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  await writeFile(join(folder, 'src/index.js'), 'export const x = 7\n')
  const choose = { match: 'What do you want to start?', answer: (/** @type {any} */ c) => c.label.startsWith('release/1.0.0') }
  // the same file changes again while the question is open
  await assert.rejects(
    p.cli('start', [
      choose,
      {
        match: 'Throw all of that away?',
        answer: async () => {
          await writeFile(join(folder, 'src/index.js'), 'export const x = 8\n')
          return true
        },
      },
    ]),
    /changed after it was checked/,
  )
  assert.ok(p.exists(folder), 'the folder stays')
  assert.ok(await p.gh.branchSha('release/1.0.0'), 'the branch stays')
  await git(folder, ['checkout', '--', 'src/index.js'])
  // a local-only release: the branch appears on GitHub while the question is open
  await git(p.bare, ['update-ref', '-d', 'refs/heads/release/1.0.0'])
  await p.gh.sync()
  await p.commit(folder, { 'src/local.js': 'local\n' }, 'local only', { push: false })
  await assert.rejects(
    p.cli('start', [
      choose,
      {
        match: 'Throw all of that away?',
        answer: async () => {
          await git(folder, ['push', '--quiet', '--no-follow-tags', p.bare, 'HEAD:refs/heads/release/1.0.0'])
          return true
        },
      },
    ]),
    /changed after it was checked/,
  )
  assert.ok(await p.gh.branchSha('release/1.0.0'), 'a branch that appeared meanwhile is never deleted')
})

test('deleting a leftover shows the commits of both the local and the remote branch', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  p.gh.afterRun = async (r) => {
    if (r.headBranch !== '1.0.0') return
    p.gh.afterRun = null
    await p.commit(folder, { 'src/late.js': 'late\n' }, 'feat: late local', { push: false })
    const side = join(p.root, 'side-leftover')
    await git(p.root, ['clone', '--quiet', '-b', 'release/1.0.0', p.bare, side])
    await git(side, ['-c', 'user.email=x@example.com', '-c', 'user.name=X', 'commit', '--quiet', '--allow-empty', '-m', 'feat: late remote'])
    await git(side, ['push', '--quiet', 'origin', 'HEAD:refs/heads/release/1.0.0'])
    await p.gh.sync()
  }
  await p.cli('publish', [{ match: 'What do you want to publish?', answer: (/** @type {any} */ c) => /^(final|finish) /.test(c.label) }], { cwd: folder }).catch(() => {})
  await p.cli('start', [
    { match: 'What do you want to start?', answer: (/** @type {any} */ c) => c.label.startsWith('release/1.0.0') },
    { match: 'for good?', answer: false },
  ])
  const text = p.lastUi?.text() ?? ''
  assert.match(text, /feat: late local/)
  assert.match(text, /feat: late remote/)
})

test('the second final waits while the run of the first one is waiting', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await p.cli('publish', [FINAL], { cwd: await startRelease(p, '1.0.0', '1.0.0') })
  const patch = await startRelease(p, 'patch', '1.0.1')
  const minor = await startRelease(p, 'minor', '1.1.0')
  p.gh.autoRun = false
  await assert.rejects(p.cli('publish', [FINAL], { cwd: patch, failAt: 'push-tag' }), /interrupted/)
  await p.gh.sync()
  const queued = p.gh.runList.find((r) => r.headBranch === '1.0.1')
  assert.equal(queued.status, 'queued')
  // release the queue a little later; the final of 1.1.0 must not tag before that
  setTimeout(() => {
    p.gh.autoRun = true
  }, 300)
  // the final of 1.1.0 waits for the run of 1.0.1; then 1.0.1 is released but not merged, which stops it
  await assert.rejects(p.cli('publish', [FINAL], { cwd: minor }), /1\.0\.1 is released but not merged/)
  assert.ok(p.registry.store.has('1.0.1'))
  assert.equal(await p.gh.tag('1.1.0'), null, 'no tag while the other release was not finished')
  await p.cli('publish', [FINAL], { cwd: patch })
  await p.cli('publish', [FINAL], { cwd: minor })
  assert.ok(p.registry.store.has('1.1.0'))
  assert.equal(p.registry.tags.latest, '1.1.0')
  assert.ok(await p.isAncestor('1.0.1^{commit}', '1.1.0^{commit}'))
})
