// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setupProject, git } from '../helpers/project.mjs'
import { withFooter } from '../../lib/release-body.mjs'

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

for (const step of ['save-tag', 'delete-tag']) {
  test(`a tag move interrupted after ${step} is finished by the next command without creating a tag`, async (t) => {
    const p = await setupProject({ version: '1.0.0' })
    t.after(() => p.dispose())
    const folder = await startRelease(p, '1.0.0', '1.0.0')
    await p.commit(folder, { FAIL: 'x' }, 'break')
    await assert.rejects(p.cli('publish', [FINAL], { cwd: folder }), /nothing was published/)
    await p.commit(folder, { FAIL: null }, 'fix')
    await assert.rejects(p.cli('publish', [FINAL], { cwd: folder, failAt: step }), /interrupted/)
    assert.ok(await git(p.work, ['rev-parse', '--verify', 'refs/release-tools/moving/1.0.0']))
    await p.cli('start', [{ match: 'What do you want to start?', answer: 'custom' }, { match: 'Version', answer: '9.0.0' }]).catch(() => {})
    assert.equal((await git(p.work, ['for-each-ref', 'refs/release-tools/moving/'])).length, 0, 'the saved tag is dropped')
    if (step === 'delete-tag') assert.equal(await p.gh.tag('1.0.0'), null, 'recovery never creates the tag of an unreleased version')
    await p.cli('publish', [FINAL], { cwd: folder })
    assert.ok(p.registry.store.has('1.0.0'))
    assert.equal(p.registry.store.get('1.0.0')?.commit, (await p.gh.tag('1.0.0'))?.commit)
  })
}

test('released, but the tag is missing: restored on the released commit', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  await p.cli('publish', [pick(/^rc/)], { cwd: folder })
  const commit = (await p.gh.tag('1.0.0-rc.1'))?.commit
  await git(p.bare, ['update-ref', '-d', 'refs/tags/1.0.0-rc.1'])
  await p.gh.onRefChange('refs/tags/1.0.0-rc.1', 'x', '0'.repeat(40), p.gh.now())
  assert.ok(p.gh.releaseList.find((r) => r.tagName === '1.0.0-rc.1')?.draft, 'GitHub turns the Release into a draft')
  await p.cli('publish', [{ match: 'What do you want to publish?', answer: (/** @type {any} */ c) => /1\.0\.0-rc\.1 is released but its tag is missing/.test(c.label) }])
  assert.equal((await p.gh.tag('1.0.0-rc.1'))?.commit, commit)
  assert.equal(p.gh.releaseList.find((r) => r.tagName === '1.0.0-rc.1')?.draft, false)
})

test('a version without provenance: its commit is taken from the tag after confirming', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  p.registry.provenance = false
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  await p.cli('publish', [FINAL, { match: 'has no provenance on npm', answer: true }], { cwd: folder })
  assert.ok(p.gh.releaseList.find((r) => r.tagName === '1.0.0' && !r.draft), 'the CLI created the GitHub Release')
  assert.ok(await p.isAncestor('1.0.0^{commit}', 'main'))
})

test('released from another commit than its tag (a safety net): nothing is merged until the tag is moved after confirming', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  const other = await git(p.bare, ['rev-parse', 'main'])
  p.gh.afterRun = async (r) => {
    if (r.headBranch !== '1.0.0') return
    p.gh.afterRun = null
    const entry = p.registry.store.get('1.0.0')
    if (entry) entry.commit = other
  }
  await assert.rejects(p.cli('publish', [FINAL, { match: /Move the tag 1\.0\.0 to/, answer: false }], { cwd: folder }), /does not point to the released commit/)
  assert.match(p.lastUi?.text() ?? '', /was released from [0-9a-f]{12}, but its tag points to/)
  const tag = await p.gh.tag('1.0.0')
  assert.equal(await p.isAncestor(/** @type {string} */ (tag?.commit), 'main'), false, 'nothing merged')
  assert.ok(p.gh.openPull('release/1.0.0'), 'the release pull request stays open')
})

test('released from another commit than its tag, confirmed: the tag is replaced in one step on the released commit', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  const other = await git(p.bare, ['rev-parse', 'main'])
  p.gh.afterRun = async (r) => {
    if (r.headBranch !== '1.0.0') return
    p.gh.afterRun = null
    const entry = p.registry.store.get('1.0.0')
    if (entry) entry.commit = other
  }
  const deletions = []
  const onRef = p.gh.onRefChange.bind(p.gh)
  p.gh.onRefChange = async (ref, o, n, at) => {
    if (ref === 'refs/tags/1.0.0' && /^0+$/.test(n)) deletions.push(ref)
    return onRef(ref, o, n, at)
  }
  await p.cli('publish', [FINAL, { match: /Move the tag 1\.0\.0 to/, answer: true }], { cwd: folder }).catch(() => {})
  const tag = await p.gh.tag('1.0.0')
  assert.equal(tag?.commit, other, 'the tag points to the released commit')
  assert.match(tag?.message ?? '', /release-tools: final/)
  assert.deepEqual(deletions, [], 'the tag was never deleted on the way')
})

test('a failed run older than 30 days cannot be re-run: the tag is created again on the same commit', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  p.registry.failPublish = 1
  await assert.rejects(
    p.cli('publish', [FINAL, { match: 'Re-run the failed publishing job?', answer: false }, { match: 'Create the tag 1.0.0 again', answer: false }], { cwd: folder }),
    /publishing job failed/,
  )
  p.gh.offsetMs = 31 * 24 * 60 * 60 * 1000
  const first = await p.gh.tag('1.0.0')
  await p.cli('publish', [FINAL], { cwd: folder })
  assert.ok(p.registry.store.has('1.0.0'))
  assert.notEqual((await p.gh.tag('1.0.0'))?.refSha, first?.refSha, 'a new tag object')
  assert.equal((await p.gh.tag('1.0.0'))?.commit, first?.commit, 'on the same commit')
})

test('init interrupted after each file: running it again writes only what is missing', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await git(p.work, ['rm', '--quiet', 'release.config.json', '.github/workflows/release.yml', 'doc/changelog/template.md'])
  await git(p.work, ['commit', '--quiet', '-m', 'remove the tool'])
  await git(p.work, ['push', '--quiet', 'origin', 'main'])
  const answers = () => [
    { match: 'Does the project publish to npm?', answer: 'yes, npm' },
    { match: 'File name of the release workflow', answer: 'release.yml' },
    { match: 'ci.checks', answer: 'npm test' },
    { match: 'Node version', answer: '24' },
  ]
  await assert.rejects(p.cli('init', answers(), { failAt: 'init:release.config.json' }), /interrupted/)
  const plan = /** @type {any[]} */ (await p.cli('init', answers()))
  assert.deepEqual(
    plan.map((x) => `${x.path}:${x.action}`),
    ['.github/workflows/release.yml:done', 'release.config.json:done', 'package.json:write', 'doc/changelog/template.md:write', 'CHANGELOG.md:done'],
  )
})

test('the same refusal of the release run twice stops the command instead of moving the tag again and again', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  p.gh.pullRest = async () => {
    const e = new Error('Not Found')
    Object.assign(e, { status: 404 })
    throw e
  }
  await assert.rejects(p.cli('publish', [FINAL], { cwd: folder }), /release run of 1\.0\.0 ended the same way again/)
  assert.ok(p.gh.runList.filter((r) => r.headBranch === '1.0.0' && !r.deleted).length <= 2)
  assert.equal(p.registry.store.size, 0)
})

test('a commit with [skip ci] is never tagged', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  await p.commit(folder, { 'src/b.js': 'b\n' }, 'chore: b [skip ci]')
  await assert.rejects(p.cli('publish', [pick(/^beta/)], { cwd: folder }), /skips the release run/)
  assert.equal(await p.gh.tag('1.0.0-beta.1'), null)
})

test('a changelog of another unreleased version in the branch stops the final', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  await p.commit(folder, { 'doc/changelog/0.9.0.md': '0.9.0 — unreleased\n===\n\n- x\n' }, 'docs: old draft')
  await assert.rejects(p.cli('publish', [FINAL], { cwd: folder }), /changelog of another unreleased version/)
  assert.equal(p.gh.pullList.length, 0, 'nothing changed: no pull request')
})

test('start: versions with a prerelease part or build metadata are refused; a taken version too', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await assert.rejects(p.cli('start', [{ match: 'What do you want to start?', answer: 'custom' }, { match: 'Version', answer: '1.1.0-beta.1' }]), /exactly X.Y.Z/)
  await assert.rejects(p.cli('start', [{ match: 'What do you want to start?', answer: 'custom' }, { match: 'Version', answer: '1.1.0+build' }]), /exactly X.Y.Z/)
  await startRelease(p, '1.0.0', '1.0.0')
  const again = /** @type {any} */ (await p.cli('start', [{ match: 'What do you want to start?', answer: 'custom' }, { match: 'Version', answer: '1.0.0' }]))
  assert.equal(again.folder, p.folder('release/1.0.0'), 'its own half-created release is continued')
  await git(p.work, ['push', '--quiet', 'origin', 'HEAD:refs/tags/1.2.0'])
  await assert.rejects(p.cli('start', [{ match: 'What do you want to start?', answer: 'custom' }, { match: 'Version', answer: '1.2.0' }]), /the tag 1\.2\.0 already exists/)
})

test('a release pull request merged by hand before the release blocks new releases from main', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await p.cli('publish', [FINAL], { cwd: await startRelease(p, '1.0.0', '1.0.0') })
  const folder = await startRelease(p, 'minor', '1.1.0')
  await assert.rejects(p.cli('publish', [FINAL], { cwd: folder, failAt: 'pull-request' }), /interrupted/)
  await p.gh.mergeInto(p.gh.openPull('release/1.1.0'), 'merge', 'Merge pull request', 'someone')
  await assert.rejects(p.cli('start', [{ match: 'What do you want to start?', answer: 'patch' }]), /not a choice|not released/)
  assert.match(p.lastUi?.text() ?? '', /main holds 1\.1\.0, which is not released/)
  await p.cli('publish', [{ match: 'What do you want to publish?', answer: (/** @type {any} */ c) => /main holds 1\.1\.0/.test(c.label) }, { match: 'Tag the code in main', answer: true }])
  assert.ok(p.registry.store.has('1.1.0'))
  assert.equal((await p.gh.tag('1.1.0'))?.commit, (await p.gh.pull(p.gh.pullList.find((x) => x.head === 'release/1.1.0').number)).headSha)
})

test('merged by hand before the release and the checks fail: the fix goes through the release branch and a new pull request', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await p.cli('publish', [FINAL], { cwd: await startRelease(p, '1.0.0', '1.0.0') })
  const folder = await startRelease(p, 'minor', '1.1.0')
  await p.commit(folder, { FAIL: 'x' }, 'break')
  await assert.rejects(p.cli('publish', [FINAL], { cwd: folder, failAt: 'pull-request' }), /interrupted/)
  await p.gh.mergeInto(p.gh.openPull('release/1.1.0'), 'merge', 'Merge pull request', 'someone')
  const mainBefore = await git(p.work, ['rev-parse', 'refs/heads/main'])
  const inMain = { match: 'What do you want to publish?', answer: (/** @type {any} */ c) => /main holds 1\.1\.0/.test(c.label) }
  await p.cli('publish', [inMain, { match: 'Tag the code in main', answer: true }])
  assert.equal(p.registry.store.has('1.1.0'), false, 'the checks failed')
  assert.match(p.lastUi?.text() ?? '', /Put the fix into release\/1\.1\.0/)
  assert.equal(await git(p.work, ['rev-parse', 'refs/heads/main']), mainBefore, 'the local main never moves')
  await p.commit(folder, { FAIL: null }, 'fix the checks')
  await p.cli('publish', [FINAL], { cwd: folder })
  assert.ok(p.gh.openPull('release/1.1.0'), 'a new pull request with the fix')
  await p.cli('publish', [FINAL], { cwd: folder })
  assert.ok(p.registry.store.has('1.1.0'))
  const tag = await p.gh.tag('1.1.0')
  assert.equal(p.registry.store.get('1.1.0')?.commit, tag?.commit)
  assert.ok(await p.isAncestor(/** @type {string} */ (tag?.commit), 'main'))
  assert.equal(await git(p.work, ['rev-parse', 'refs/heads/main']), mainBefore, 'the local main never moves')
})

test('bootstrap with lightweight tags and releases of the old flow (publish: "none", like admin-dam)', async (t) => {
  const p = await setupProject({ version: '0.0.1', publish: 'none' })
  t.after(() => p.dispose())
  // 2.2.0 of the old flow: a lightweight tag on a commit without the release workflow of the tool
  const old = await git(p.work, ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'old flow'])
  await git(p.work, ['push', '--quiet', 'origin', `${old}:refs/tags/2.2.0`])
  await p.gh.sync()
  p.gh.releaseList.push({ id: 9999, tagName: '2.2.0', name: '2.2.0', body: 'old', draft: false, prerelease: false, targetCommitish: 'main', createdAt: new Date(), assets: [] })
  p.gh.runList = []
  const s = /** @type {any} */ (await p.cli('start', [{ match: 'What do you want to start?', answer: 'major' }]))
  assert.equal(s.branch, 'release/3.0.0')
  await p.writeChangelog('release/3.0.0', '3.0.0')
  await p.cli('publish', [FINAL], { cwd: p.folder('release/3.0.0') })
  assert.ok(p.gh.releaseList.find((r) => r.tagName === '3.0.0' && !r.draft))
  const menu = await p.cli('start', [{ match: 'What do you want to start?', answer: 'patch' }]).then(() => p.lastUi?.text() ?? '')
  assert.doesNotMatch(menu, /2\.2\.0 → 2\.2\.1/, 'no hotfix of a version released without the tool')
})

test('a cancelled run (a full queue) makes the command create the tag again', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  const exec = p.gh.execute.bind(p.gh)
  let cancelled = false
  p.gh.execute = async (r) => {
    if (!cancelled && r.headBranch === '1.0.0') {
      cancelled = true
      r.status = 'completed'
      r.conclusion = 'cancelled'
      return
    }
    return exec(r)
  }
  await p.cli('publish', [FINAL], { cwd: folder })
  assert.ok(cancelled)
  assert.ok(p.registry.store.has('1.0.0'))
})

test('no run starts for a tag: after ten minutes the tag is created again', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  const onRef = p.gh.onRefChange.bind(p.gh)
  let dropped = false
  p.gh.onRefChange = async (ref, o, n, at) => {
    if (!dropped && ref === 'refs/tags/1.0.0' && !/^0+$/.test(n)) {
      dropped = true
      // GitHub never starts the run; the clock goes on
      const timer = setInterval(() => {
        p.gh.offsetMs += 60 * 1000
      }, 5)
      setTimeout(() => clearInterval(timer), 2000)
      return
    }
    return onRef(ref, o, n, at)
  }
  await p.cli('publish', [FINAL], { cwd: folder })
  assert.ok(dropped)
  assert.ok(p.registry.store.has('1.0.0'))
  assert.match(p.lastUi?.text() ?? '', /no release run started/)
})

test('cleanup keeps tags with a waiting run', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  p.gh.autoRun = false
  await assert.rejects(p.cli('publish', [pick(/^dev/), { match: 'Dev build', answer: 'waiting' }], { cwd: folder, failAt: 'push-tag' }), /interrupted/)
  await p.gh.sync()
  p.gh.offsetMs = 3 * 60 * 60 * 1000
  assert.deepEqual(await p.cli('cleanup', []), [])
  p.gh.autoRun = true
})

test('release body of a release by the CLI and by the action use the same footer', () => {
  const body = withFooter('x', { commit: 'a'.repeat(40), createdBy: 'release-tools CLI' })
  assert.match(body, /created-by: release-tools CLI/)
})

test('an open pull request into the release branch is retargeted to another open release before the final', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await p.cli('publish', [FINAL], { cwd: await startRelease(p, '1.0.0', '1.0.0') })
  const patch = await startRelease(p, 'patch', '1.0.1')
  await startRelease(p, 'minor', '1.1.0')
  await git(p.bare, ['branch', 'feature', 'main'])
  const feature = await p.gh.createPull({ head: 'feature', base: 'release/1.0.1', title: 'feature', body: '' })
  await p.cli('publish', [FINAL, { match: 'targets release/1.0.1', answer: 'retarget to release/1.1.0' }], { cwd: patch })
  assert.equal(p.gh.pullList.find((x) => x.number === feature.number)?.base, 'release/1.1.0')
  assert.equal(p.gh.pullList.find((x) => x.number === feature.number)?.state, 'open')
  void writeFile
  void join
})
