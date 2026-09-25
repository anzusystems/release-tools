// @ts-check
// Regression tests of the findings of the implementation reviews.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setupProject, git } from '../helpers/project.mjs'
import { Git } from '../../lib/git.mjs'
import { run } from '../../lib/exec.mjs'

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

test('a push URL of origin that is another repository stops every command', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await git(p.work, ['remote', 'set-url', '--push', 'origin', 'git@github.com:someone/fork.git'])
  await assert.rejects(p.cli('start', [{ match: 'What do you want to start?', answer: '1.0.0' }]), /origin pushes to git@github.com:someone\/fork.git/)
})

test('a prerelease of an older line from any branch must contain the last release of its line', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await p.cli('publish', [FINAL], { cwd: await startRelease(p, '1.0.0', '1.0.0') })
  await p.cli('publish', [FINAL], { cwd: await startRelease(p, 'patch', '1.0.1') })
  await p.cli('publish', [FINAL], { cwd: await startRelease(p, 'minor', '1.1.0') })
  await git(p.work, ['fetch', '--quiet', p.bare, '+refs/tags/1.0.0:refs/old/1.0.0'])
  await git(p.work, ['switch', '--quiet', '-c', 'fix-old', 'refs/old/1.0.0'])
  await p.commit(p.work, { 'src/fix.js': 'fix\n' }, 'fix: old')
  await assert.rejects(p.cli('publish', [pick(/^alpha/), { match: 'Version of the prerelease', answer: '1.0.2' }]), /does not contain 1\.0\.1/)
  assert.equal(await p.gh.tag('1.0.2-alpha.1'), null)
})

test('a hotfix is not started when main does not allow merge commits', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await p.cli('publish', [FINAL], { cwd: await startRelease(p, '1.0.0', '1.0.0') })
  await p.cli('publish', [FINAL], { cwd: await startRelease(p, 'minor', '1.1.0') })
  p.gh.settings.mergeCommitAllowed = false
  await assert.rejects(p.cli('start', [{ match: 'What do you want to start?', answer: '1.0.0 → 1.0.1' }]), /changelog pull request of the hotfix/)
  assert.equal(await p.gh.branchSha('hotfix/1.0.1'), null)
})

test('a cherry-pick with conflicts in the folder: publish refuses, cancel shows it and asks', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  await p.commit(folder, { 'src/index.js': 'export const x = 2\n' }, 'two')
  const other = join(p.root, 'other')
  await git(p.root, ['clone', '--quiet', p.bare, other])
  await writeFile(join(other, 'src/index.js'), 'export const x = 3\n')
  await git(other, ['-c', 'user.email=x@example.com', '-c', 'user.name=X', 'commit', '--quiet', '-am', 'three'])
  await git(other, ['push', '--quiet', 'origin', 'HEAD:refs/heads/side'])
  await git(folder, ['fetch', '--quiet', 'origin', 'side'])
  await run('git', ['cherry-pick', 'FETCH_HEAD'], { cwd: folder, allowFail: true })
  await assert.rejects(p.cli('publish', [pick(/^beta/)], { cwd: folder }), /a cherry-pick is not finished/)
  await p.cli('start', [
    { match: 'What do you want to start?', answer: (/** @type {any} */ c) => c.label.startsWith('release/1.0.0') },
    { match: 'Throw all of that away?', answer: false },
  ]).catch(() => {})
  assert.match(p.lastUi?.text() ?? '', /conflicts that are not resolved[\s\S]*a cherry-pick that is not finished/)
  assert.ok(p.exists(folder))
})

test('deleting a remote branch is refused when it moved (compare and delete)', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const main = await git(p.bare, ['rev-parse', 'main'])
  await git(p.bare, ['branch', 'x', main])
  const g = new Git(p.work)
  assert.equal(await g.deleteRemoteBranch('x', '0'.repeat(39) + '1'), false)
  assert.equal(await git(p.bare, ['rev-parse', 'refs/heads/x']), main)
  assert.equal(await g.deleteRemoteBranch('x', main), true)
  await assert.rejects(git(p.bare, ['rev-parse', '--verify', 'refs/heads/x']))
})

test('cancel a hotfix after confirming its commits that were not pushed', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await p.cli('publish', [FINAL], { cwd: await startRelease(p, '1.0.0', '1.0.0') })
  await p.cli('publish', [FINAL], { cwd: await startRelease(p, 'minor', '1.1.0') })
  await p.cli('start', [{ match: 'What do you want to start?', answer: '1.0.0 → 1.0.1' }])
  const hf = p.folder('hotfix/1.0.1')
  await p.commit(hf, { 'src/x.js': 'x\n' }, 'not pushed', { push: false })
  await p.cli('start', [
    { match: 'What do you want to start?', answer: (/** @type {any} */ c) => c.label.startsWith('hotfix/1.0.1') },
    { match: 'Throw all of that away?', answer: true },
  ])
  assert.equal(p.exists(hf), false)
  assert.equal(await p.gh.branchSha('hotfix/1.0.1'), null)
})

test('cleanup races a release: the tag is restored and the Release is published as Latest', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await p.cli('publish', [FINAL], { cwd: await startRelease(p, '1.0.0', '1.0.0') })
  const folder = await startRelease(p, 'minor', '1.1.0')
  await p.commit(folder, { FAIL: 'x' }, 'break')
  await assert.rejects(p.cli('publish', [FINAL], { cwd: folder }), /nothing was published/)
  const tag = await p.gh.tag('1.1.0')
  assert.ok(tag)
  // the branch is gone (for example deleted by hand): the unreleased stable tag is a cleanup item
  await git(p.work, ['worktree', 'remove', '--force', folder])
  await git(p.work, ['branch', '-D', 'release/1.1.0'])
  await git(p.bare, ['update-ref', '-d', 'refs/heads/release/1.1.0'])
  p.gh.offsetMs = 3 * 60 * 60 * 1000
  // while cleanup deletes the runs, a re-run of the old run publishes 1.1.0 (its Release becomes a draft
  // when the tag disappears)
  const deleteRun = p.gh.deleteRun.bind(p.gh)
  let released = false
  p.gh.deleteRun = async (id) => {
    if (!released) {
      released = true
      p.registry.publish('1.1.0', Buffer.from('pkg'), 'latest', tag.commit)
      p.gh.releaseList.push({
        id: 7777,
        tagName: '1.1.0',
        name: '1.1.0',
        body: `x\n\n<!-- release-tools\ncommit: ${tag.commit}\n-->\n`,
        draft: true,
        prerelease: false,
        targetCommitish: tag.commit,
        createdAt: new Date(),
        assets: [],
      })
    }
    return deleteRun(id)
  }
  await p.cli('cleanup', [
    { match: 'What to delete?', answer: 'delete all' },
    { match: 'Delete these', answer: true },
  ]).catch(() => {})
  assert.ok(released)
  assert.equal((await p.gh.tag('1.1.0'))?.commit, tag.commit, 'the tag is restored on the released commit')
  const rel = p.gh.releaseList.find((r) => r.tagName === '1.1.0')
  assert.equal(rel?.draft, false)
  assert.equal(p.gh.latestReleaseId, rel?.id, 'and it is the Latest release')
})
