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

test('a dangling symbolic link changed during the question is noticed; a branch in use or moved is not deleted', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  const { symlinkSync, unlinkSync } = await import('node:fs')
  symlinkSync('missing-a', join(folder, 'link'))
  await assert.rejects(
    p.cli('start', [
      { match: 'What do you want to start?', answer: (/** @type {any} */ c) => c.label.startsWith('release/1.0.0') },
      {
        match: 'Throw all of that away?',
        answer: async () => {
          unlinkSync(join(folder, 'link'))
          symlinkSync('missing-b', join(folder, 'link'))
          return true
        },
      },
    ]),
    /changed after it was checked/,
  )
  assert.ok(p.exists(folder))
  const g = new Git(p.work)
  const head = await git(p.work, ['rev-parse', 'refs/heads/release/1.0.0'])
  await assert.rejects(g.deleteBranch('release/1.0.0', head), /used by the folder/)
  await git(p.work, ['branch', 'spare', 'main'])
  await assert.rejects(g.deleteBranch('spare', head), /changed meanwhile/)
  assert.ok(await git(p.work, ['rev-parse', '--verify', 'refs/heads/spare']))
  // a symbolic branch never makes the tool delete the branch it points to
  await git(p.work, ['symbolic-ref', 'refs/heads/release/9.9.9', 'refs/heads/spare'])
  const spare = await git(p.work, ['rev-parse', 'refs/heads/spare'])
  await assert.rejects(g.deleteBranch('release/9.9.9', spare), /symbolic ref/)
  assert.equal(await git(p.work, ['rev-parse', 'refs/heads/spare']), spare)
  // a branch a folder is bisecting stays
  await git(p.work, ['branch', 'bisected', 'main'])
  const other = join(p.root, 'bisect-folder')
  await git(p.work, ['worktree', 'add', '--quiet', other, 'bisected'])
  await git(other, ['bisect', 'start'])
  await git(other, ['checkout', '--quiet', '--detach', 'HEAD'])
  const bisected = await git(p.work, ['rev-parse', 'refs/heads/bisected'])
  await assert.rejects(g.deleteBranch('bisected', bisected), /used by the folder/)
  // a folder whose path has a newline, rebasing the branch
  await git(p.work, ['branch', 'rebased', 'main'])
  const odd = join(p.root, 'odd\nfolder')
  await git(p.work, ['worktree', 'add', '--quiet', odd, 'rebased'])
  await writeFile(join(odd, 'r.txt'), 'r\n')
  await git(odd, ['add', 'r.txt'])
  await git(odd, ['commit', '--quiet', '-m', 'r'])
  await run('git', ['rebase', '--quiet', '-x', 'false', 'HEAD~1'], { cwd: odd, allowFail: true, extraEnv: { GIT_EDITOR: 'true' } })
  const rebased = await git(p.work, ['rev-parse', 'refs/heads/rebased'])
  await assert.rejects(g.deleteBranch('rebased', rebased), /used by the folder/)
  // config of a deleted branch goes with it
  await git(p.work, ['branch', 'gone', 'main'])
  await git(p.work, ['config', 'branch.gone.description', 'x'])
  await g.deleteBranch('gone', await git(p.work, ['rev-parse', 'refs/heads/gone']))
  assert.equal((await run('git', ['config', '--get', 'branch.gone.description'], { cwd: p.work, allowFail: true })).code, 1)
})

test('fingerprints tell apart names and link targets that are not UTF-8', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const { symlinkSync, unlinkSync } = await import('node:fs')
  const g = new Git(p.work)
  const link = Buffer.concat([Buffer.from(`${p.work}/`), Buffer.from([0x6c, 0xff])])
  symlinkSync(Buffer.from([0x61, 0xfe]), link)
  const first = await g.fingerprint()
  unlinkSync(link)
  symlinkSync(Buffer.from([0x61, 0xfd]), link)
  const second = await g.fingerprint()
  assert.notEqual(first.text, second.text)
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

test('the tag of a released hotfix is restored on another computer that lacks its commit, still as a hotfix', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await p.cli('publish', [FINAL], { cwd: await startRelease(p, '1.0.0', '1.0.0') })
  await p.cli('publish', [FINAL], { cwd: await startRelease(p, 'minor', '1.1.0') })
  await p.cli('start', [{ match: 'What do you want to start?', answer: '1.0.0 → 1.0.1' }])
  const hf = p.folder('hotfix/1.0.1')
  await p.commit(hf, { 'src/index.js': 'export const x = 101\n' }, 'fix: x')
  await p.writeChangelog('hotfix/1.0.1', '1.0.1')
  await p.cli('publish', [FINAL], { cwd: hf })
  const released = /** @type {any} */ (p.registry.store.get('1.0.1')).commit
  // the tag is lost; the hotfix commit is reachable from no ref any more
  await git(p.bare, ['update-ref', '-d', 'refs/tags/1.0.1'])
  await p.gh.onRefChange('refs/tags/1.0.1', released, '0'.repeat(40), p.gh.now())
  const fresh = join(p.root, 'work', 'fresh')
  // --no-local: only the objects reachable from refs, like a clone from GitHub
  await git(p.root, ['clone', '--quiet', '--no-local', p.bare, fresh])
  await git(fresh, ['config', 'user.email', 'dev@example.com'])
  await git(fresh, ['config', 'user.name', 'Dev'])
  // protocol v0 refuses objects no ref advertises: the case GitHub does not serve the commit
  await git(fresh, ['config', 'protocol.version', '0'])
  assert.equal((await run('git', ['cat-file', '-e', released], { cwd: fresh, allowFail: true })).code === 0, false, 'the clone lacks the commit')
  const apiTag = p.gh.createApiTag.bind(p.gh)
  let throughApi = 0
  p.gh.createApiTag = async (...args) => {
    throughApi++
    return apiTag(...args)
  }
  await p.cli('publish', [{ match: 'What do you want to publish?', answer: (/** @type {any} */ c) => /1\.0\.1 is released but its tag is missing/.test(c.label) }], { cwd: fresh })
  assert.equal(throughApi, 1, 'created through the API, since GitHub does not serve the commit')
  const tag = await p.gh.tag('1.0.1')
  assert.equal(tag?.commit, released, 'on the released commit')
  assert.match(tag?.message ?? '', /release-tools: hotfix/)
  assert.equal(p.gh.pullList.some((x) => x.head === 'release-merge/1.0.1'), false, 'no merge of the old line into main')
})

test('a prerelease on npm without a tag and a Release (an interrupted cleanup) is restored by cleanup', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  await p.cli('publish', [pick(/^rc/)], { cwd: folder })
  const commit = /** @type {any} */ (p.registry.store.get('1.0.0-rc.1')).commit
  await git(p.bare, ['update-ref', '-d', 'refs/tags/1.0.0-rc.1'])
  await p.gh.onRefChange('refs/tags/1.0.0-rc.1', commit, '0'.repeat(40), p.gh.now())
  p.gh.releaseList = p.gh.releaseList.filter((r) => r.tagName !== '1.0.0-rc.1')
  await p.cli('cleanup', [])
  assert.equal((await p.gh.tag('1.0.0-rc.1'))?.commit, commit)
  assert.ok(p.gh.releaseList.find((r) => r.tagName === '1.0.0-rc.1' && !r.draft && r.prerelease))
})

test('merged by hand before the release: the checks of a final run on the merged code (another unreleased changelog)', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await p.cli('publish', [FINAL], { cwd: await startRelease(p, '1.0.0', '1.0.0') })
  const folder = await startRelease(p, 'minor', '1.1.0')
  await assert.rejects(p.cli('publish', [FINAL], { cwd: folder, failAt: 'pull-request' }), /interrupted/)
  await p.commit(folder, { 'doc/changelog/1.2.0.md': '1.2.0 — unreleased\n===\n\n- later\n' }, 'docs: 1.2.0')
  await p.gh.mergeInto(p.gh.openPull('release/1.1.0'), 'merge', 'Merge pull request', 'someone')
  await assert.rejects(
    p.cli('publish', [{ match: 'What do you want to publish?', answer: (/** @type {any} */ c) => /main holds 1\.1\.0/.test(c.label) }, { match: 'Tag the code in main', answer: true }]),
    /changelog of another unreleased version/,
  )
  assert.equal(await p.gh.tag('1.1.0'), null)
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
