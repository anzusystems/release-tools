// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupProject, git } from '../helpers/project.mjs'

const FINAL = { match: 'What do you want to publish?', answer: (/** @type {any} */ c) => /^(final|finish) /.test(c.label) }

/**
 * Releases a version from start to merge.
 * @param {import('../helpers/project.mjs').TestProject} p
 * @param {string} startAnswer
 * @param {string} version
 * @param {{ match: string | RegExp, answer: any }[]} [more]
 */
async function release(p, startAnswer, version, more = []) {
  /** @type {any} */
  const started = await p.cli('start', [{ match: 'What do you want to start?', answer: startAnswer }])
  assert.equal(started.branch, `release/${version}`)
  await p.writeChangelog(`release/${version}`, version)
  await p.cli('publish', [FINAL, ...more], { cwd: p.folder(`release/${version}`) })
}

test('first final of a new project: start in bootstrap, publish, merge, clean up', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await release(p, '1.0.0', '1.0.0')
  const folder = p.folder('release/1.0.0')
  assert.ok(p.registry.store.has('1.0.0'), 'published to the registry')
  assert.equal(p.registry.tags.latest, '1.0.0')
  const rel = p.gh.releaseList.find((r) => r.tagName === '1.0.0')
  assert.ok(rel && !rel.draft && !rel.prerelease)
  assert.equal(p.gh.latestReleaseId, rel.id)
  assert.match(rel.body, /Something/)
  assert.match(rel.body, /<!-- release-tools\ncommit: [0-9a-f]{40}\nkind: final\nrun-id: \d+\n-->/)
  const tagCommit = await p.sha('1.0.0^{commit}')
  const parents = (await git(p.bare, ['log', '-1', '--format=%P', 'main'])).split(' ')
  assert.equal(parents[1], tagCommit, 'merged with a merge commit whose second parent is the tagged commit')
  assert.equal(await git(p.bare, ['log', '-1', '--format=%s', 'main']), 'release: 1.0.0')
  assert.match(await p.show('main', 'CHANGELOG.md'), /- \[1\.0\.0\]\(doc\/changelog\/1\.0\.0\.md\) — \d{4}-\d{2}-\d{2}/)
  assert.match(await p.show('main', 'doc/changelog/1.0.0.md'), /^1\.0\.0 — \d{4}-\d{2}-\d{2}/)
  assert.equal(JSON.parse(await p.show('main', 'package.json')).version, '1.0.0')
  assert.equal(JSON.parse(await p.show('main', 'package-lock.json')).version, '1.0.0')
  assert.equal(p.exists(folder), false, 'the folder is removed')
  assert.equal(await p.gh.branchSha('release/1.0.0'), null, 'the branch is deleted on GitHub')
  assert.deepEqual(await p.localTags(), [], 'no local tag is created')
})

test('second release: the version in main must be the last released one; minor', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await release(p, '1.0.0', '1.0.0')
  await release(p, 'minor', '1.1.0')
  assert.ok(p.registry.store.has('1.1.0'))
  assert.equal(p.registry.tags.latest, '1.1.0')
  assert.equal(JSON.parse(await p.show('main', 'package.json')).version, '1.1.0')
  const index = await p.show('main', 'CHANGELOG.md')
  assert.ok(index.indexOf('[1.1.0]') < index.indexOf('[1.0.0]'), 'newest first')
  assert.equal(p.gh.releaseList.find((r) => r.id === p.gh.latestReleaseId)?.tagName, '1.1.0')
})

test('approval: waits for it; bypass only after confirming it, recorded in the tag', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  p.gh.settings.requireApproval = true
  p.gh.settings.canBypass = false
  await p.cli('start', [{ match: 'What do you want to start?', answer: '1.0.0' }])
  await p.writeChangelog('release/1.0.0', '1.0.0')
  let ticks = 0
  const timer = setInterval(async () => {
    const pr = p.gh.openPull('release/1.0.0')
    if (pr && !pr.approvals.length && ++ticks > 10) await p.gh.approve(pr.number, 'colleague')
  }, 20)
  try {
    await p.cli('publish', [FINAL], { cwd: p.folder('release/1.0.0') })
  } finally {
    clearInterval(timer)
  }
  assert.ok(p.registry.store.has('1.0.0'))
  assert.match(p.lastUi?.text() ?? '', /waiting for the approval/)
  const tag = await p.gh.tag('1.0.0')
  assert.doesNotMatch(tag?.message ?? '', /confirmed-by/)

  p.gh.settings.canBypass = true
  await p.cli('start', [{ match: 'What do you want to start?', answer: 'patch' }])
  await p.writeChangelog('release/1.0.1', '1.0.1')
  await p.cli('publish', [FINAL, { match: 'without the approval (bypass)', answer: true }], { cwd: p.folder('release/1.0.1') })
  assert.ok(p.registry.store.has('1.0.1'))
  assert.match((await p.gh.tag('1.0.1'))?.message ?? '', /confirmed-by: dev/)
})

test('failed checks: nothing is published or merged; after the fix the tag moves', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await p.cli('start', [{ match: 'What do you want to start?', answer: '1.0.0' }])
  const folder = p.folder('release/1.0.0')
  await p.writeChangelog('release/1.0.0', '1.0.0')
  await p.commit(folder, { FAIL: 'x' }, 'break the checks')
  await assert.rejects(p.cli('publish', [FINAL], { cwd: folder }), /nothing was published/)
  assert.equal(p.registry.store.size, 0)
  const first = await p.gh.tag('1.0.0')
  assert.ok(first)
  assert.equal(await p.isAncestor(first.commit, 'main'), false)
  await p.commit(folder, { FAIL: null }, 'fix the checks')
  await p.cli('publish', [FINAL], { cwd: folder })
  const second = await p.gh.tag('1.0.0')
  assert.notEqual(second?.refSha, first.refSha, 'a new tag object')
  assert.notEqual(second?.commit, first.commit, 'on the fixed commit')
  assert.ok(p.registry.store.has('1.0.0'))
  assert.equal(p.registry.store.get('1.0.0')?.commit, second?.commit)
  assert.ok(await p.isAncestor(/** @type {string} */ (second?.commit), 'main'))
  assert.equal(p.gh.runList.filter((r) => r.headBranch === '1.0.0' && !r.deleted).length, 1, 'the finished run of the old tag is deleted')
})

test('main moves during the run: the released commit is merged with a plain merge of main', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  p.gh.settings.strict = true
  await p.cli('start', [{ match: 'What do you want to start?', answer: '1.0.0' }])
  await p.writeChangelog('release/1.0.0', '1.0.0')
  let moved = false
  p.gh.beforeRun = () => {
    if (!moved) {
      moved = true
      return p.changeMain({ 'doc/other.md': 'x\n' }, 'docs: other')
    }
  }
  const origBefore = p.gh.beforeRun
  p.gh.beforeRun = null
  const exec = p.gh.execute.bind(p.gh)
  p.gh.execute = async (r) => {
    if (!moved) {
      moved = true
      await p.changeMain({ 'doc/other.md': 'x\n' }, 'docs: other')
    }
    return exec(r)
  }
  void origBefore
  await p.cli('publish', [FINAL], { cwd: p.folder('release/1.0.0') })
  const tagCommit = await p.sha('1.0.0^{commit}')
  assert.ok(await p.isAncestor(tagCommit, 'main'))
  assert.equal(await p.show('main', 'doc/other.md'), 'x')
  assert.equal(await git(p.bare, ['log', '-1', '--format=%s', 'main']), 'release: 1.0.0')
})

test('a foreign commit pushed after the tag: a new pull request from the released commit; the branch stays', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await p.cli('start', [{ match: 'What do you want to start?', answer: '1.0.0' }])
  const folder = p.folder('release/1.0.0')
  await p.writeChangelog('release/1.0.0', '1.0.0')
  const exec = p.gh.execute.bind(p.gh)
  let pushed = false
  p.gh.execute = async (r) => {
    await exec(r)
    if (!pushed) {
      pushed = true
      const side = `${p.root}/side-foreign`
      await git(p.root, ['clone', '--quiet', '-b', 'release/1.0.0', p.bare, side])
      await git(side, ['-c', 'user.email=x@example.com', '-c', 'user.name=X', 'commit', '--quiet', '--allow-empty', '-m', 'feat: late'])
      await git(side, ['push', '--quiet', 'origin', 'HEAD:refs/heads/release/1.0.0'])
      await p.gh.sync()
    }
  }
  await p.cli('publish', [FINAL], { cwd: folder })
  const tagCommit = await p.sha('1.0.0^{commit}')
  assert.ok(await p.isAncestor(tagCommit, 'main'))
  assert.equal(await git(p.bare, ['log', '--format=%s', 'main']).then((l) => l.includes('feat: late')), false, 'the late commit is not in main')
  assert.ok(p.gh.pullList.some((x) => x.head === 'release-merge/1.0.0' && x.state === 'merged'))
  assert.ok(p.gh.pullList.some((x) => x.head === 'release/1.0.0' && x.state === 'closed'))
  assert.ok(await p.gh.branchSha('release/1.0.0'), 'the release branch with the late commit stays')
  assert.equal(await p.gh.branchSha('release-merge/1.0.0'), null, 'the helper branch is deleted')
  assert.match(p.lastUi?.text() ?? '', /stay/)
})

test('release pull request squashed by hand before the tag: confirmed, tagged in main, released', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await p.cli('start', [{ match: 'What do you want to start?', answer: '1.0.0' }])
  const folder = p.folder('release/1.0.0')
  await p.writeChangelog('release/1.0.0', '1.0.0')
  p.gh.settings.requireApproval = true
  p.gh.settings.canBypass = false
  // publish stops while waiting: simulate the human merge right when the pull request exists
  const timer = setInterval(async () => {
    const pr = p.gh.openPull('release/1.0.0')
    if (pr) {
      clearInterval(timer)
      await p.gh.mergeInto(pr, 'squash', 'release: 1.0.0', 'someone')
    }
  }, 10)
  await p.cli('publish', [FINAL, { match: 'Tag the code in main and release it?', answer: true }], { cwd: folder })
  clearInterval(timer)
  const tag = await p.gh.tag('1.0.0')
  assert.ok(tag)
  assert.equal(tag.commit, await p.sha('main'), 'the squash commit in main is tagged')
  assert.match(tag.message ?? '', /confirmed-by: dev/)
  assert.ok(p.registry.store.has('1.0.0'))
  assert.doesNotMatch(p.lastUi?.text() ?? '', /reached main without being in/, 'the squashed commits are in the release')
})

test('releases in the order of their versions; a lower final after a higher one stops before any change', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await release(p, '1.0.0', '1.0.0')
  await p.cli('start', [{ match: 'What do you want to start?', answer: 'patch' }])
  await p.cli('start', [{ match: 'What do you want to start?', answer: 'minor' }])
  await p.writeChangelog('release/1.0.1', '1.0.1')
  await p.writeChangelog('release/1.1.0', '1.1.0')
  await p.cli('publish', [FINAL], { cwd: p.folder('release/1.1.0') })
  assert.ok(p.registry.store.has('1.1.0'))
  const before = await p.sha('refs/heads/release/1.0.1')
  await assert.rejects(p.cli('publish', [FINAL], { cwd: p.folder('release/1.0.1') }), /not higher than/)
  assert.equal(await p.sha('refs/heads/release/1.0.1'), before, 'nothing changed')
  assert.equal(await p.gh.tag('1.0.1'), null)
})

test('an unreleased stable tag of another release blocks a final; withdrawing it lets the urgent patch through', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await release(p, '1.0.0', '1.0.0')
  await p.cli('start', [{ match: 'What do you want to start?', answer: 'minor' }])
  await p.writeChangelog('release/1.1.0', '1.1.0')
  await p.commit(p.folder('release/1.1.0'), { FAIL: 'x' }, 'break')
  await assert.rejects(p.cli('publish', [FINAL], { cwd: p.folder('release/1.1.0') }), /nothing was published/)
  assert.ok(await p.gh.tag('1.1.0'))
  await p.cli('start', [{ match: 'What do you want to start?', answer: 'patch' }])
  await p.writeChangelog('release/1.0.1', '1.0.1')
  await p.cli('publish', [FINAL, { match: 'is not released yet', answer: (/** @type {any} */ c) => c.value === 'withdraw' }], { cwd: p.folder('release/1.0.1') })
  assert.ok(p.registry.store.has('1.0.1'))
  assert.equal(await p.gh.tag('1.1.0'), null, 'the tag of 1.1.0 is withdrawn')
  assert.ok(await p.gh.branchSha('release/1.1.0'), 'its branch stays')
  assert.ok(p.gh.openPull('release/1.1.0'), 'its pull request stays')
  await p.commit(p.folder('release/1.1.0'), { FAIL: null }, 'fix')
  await p.cli('publish', [FINAL], { cwd: p.folder('release/1.1.0') })
  assert.ok(p.registry.store.has('1.1.0'))
  assert.ok(await p.isAncestor('1.0.1^{commit}', '1.1.0^{commit}'), '1.1.0 contains 1.0.1')
})

for (const step of ['final-commit', 'push', 'pull-request', 'push-tag', 'merge']) {
  test(`interrupted after ${step}: running again finishes without doing anything twice`, async (t) => {
    const p = await setupProject({ version: '1.0.0' })
    t.after(() => p.dispose())
    await p.cli('start', [{ match: 'What do you want to start?', answer: '1.0.0' }])
    const folder = p.folder('release/1.0.0')
    await p.writeChangelog('release/1.0.0', '1.0.0')
    await assert.rejects(p.cli('publish', [FINAL], { cwd: folder, failAt: step }), /interrupted after/)
    if (p.exists(folder)) await p.cli('publish', [FINAL], { cwd: folder })
    else await p.cli('publish', [{ match: 'What do you want to publish?', answer: (/** @type {any} */ c) => /released but not merged|release\/1.0.0/.test(c.label) }])
    assert.ok(p.registry.store.has('1.0.0'))
    assert.ok(await p.isAncestor('1.0.0^{commit}', 'main'))
    assert.equal(p.gh.pullList.filter((x) => x.state === 'merged').length, 1, 'one merged pull request')
    assert.equal(p.gh.releaseList.filter((r) => r.tagName === '1.0.0').length, 1, 'one GitHub Release')
    const finals = (await git(p.bare, ['log', '--format=%s', 'main'])).split('\n').filter((s) => s === 'release: 1.0.0')
    assert.equal(finals.length, 2, 'one final commit and one merge commit')
  })
}
