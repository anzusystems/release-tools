// @ts-check
// The main paths of every command on real GitHub, and the behaviors of GitHub the fake of the integration tests
// assumes (drafts after a deleted tag, re-run of a job with the artifact of the first attempt, runs of a deletion,
// a new run for a tag created again, the queue, rulesets and branch protection).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from '../../lib/exec.mjs'
import { ENABLED, REPO, resetSandbox, cli, git, dispose, api, waitFor, pushToolTag, runResults } from './helpers.mjs'

const skip = !ENABLED && 'set RELEASE_E2E=1 (see test/e2e/README.md)'
const FINAL = { match: 'What do you want to publish?', answer: (/** @type {any} */ c) => /^(final|finish) /.test(c.label) }
const pick = (/** @type {RegExp} */ re) => ({ match: 'What do you want to publish?', answer: (/** @type {any} */ c) => re.test(c.label) })
const ID = ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com']

/**
 * @param {string} folder
 * @param {string} version
 */
async function writeChangelog(folder, version) {
  const path = join(folder, 'doc/changelog', `${version}.md`)
  await writeFile(path, (await readFile(path, 'utf8')).replace('### Added\n', '### Added\n\n- **Something** changed.\n'))
  await git(folder, ['commit', '--quiet', '-am', `docs: changelog ${version}`])
  await git(folder, ['push', '--quiet', '--no-follow-tags', 'origin', 'HEAD'])
}

/**
 * @param {{ work: string }} s
 * @param {any} answer
 * @param {string} version
 */
async function startRelease(s, answer, version) {
  const { result } = await cli('start', s.work, [{ match: 'What do you want to start?', answer }])
  const folder = /** @type {any} */ (result).folder
  await writeChangelog(folder, version)
  return folder
}

/**
 * A clone of a branch of the sandbox, like a colleague's computer.
 * @param {string} root
 * @param {string} branch
 */
async function colleague(root, branch) {
  const dir = join(root, `colleague-${Math.random().toString(16).slice(2, 8)}`)
  await run('git', ['clone', '--quiet', '-b', branch, `git@github.com:${REPO}.git`, dir])
  return dir
}

/**
 * @param {import('../../lib/github.mjs').GitHub} gh
 * @param {string} commit
 * @param {string} ref
 */
async function contains(gh, commit, ref) {
  const c = await gh.compare(commit, ref)
  return c.status === 'ahead' || c.status === 'identical'
}

test('e2e: a hotfix of an older line; its changelog reaches main through its own pull request', { skip }, async () => {
  const s = await resetSandbox({ version: '1.0.0' })
  try {
    await cli('publish', await startRelease(s, '1.0.0', '1.0.0'), [FINAL])
    await cli('publish', await startRelease(s, 'minor', '1.1.0'), [FINAL])
    const { result } = await cli('start', s.work, [{ match: 'What do you want to start?', answer: '1.0.0 → 1.0.1' }])
    const hf = /** @type {any} */ (result).folder
    await writeFile(join(hf, 'src/index.js'), 'export const x = 101\n')
    await git(hf, [...ID, 'commit', '--quiet', '-am', 'fix: x'])
    await writeChangelog(hf, '1.0.1')
    await cli('publish', hf, [FINAL])
    assert.ok(await s.registry.version('', '1.0.1'))
    assert.equal((await s.registry.distTags(''))['latest-1.0'], '1.0.1')
    assert.equal((await s.gh.latestRelease())?.tagName, '1.1.0', 'Latest stays on the newest line')
    assert.match((await s.gh.file('doc/changelog/1.0.1.md', 'main')) ?? '', /1\.0\.1/)
  } finally {
    await dispose(s.root)
  }
})

test('e2e: publish "none": a prerelease and a final as GitHub Releases; a Release whose tag was deleted is finished', { skip }, async () => {
  const s = await resetSandbox({ version: '1.0.0', publish: 'none' })
  try {
    const folder = await startRelease(s, '1.0.0', '1.0.0')
    await cli('publish', folder, [pick(/^rc/)])
    assert.ok(await s.gh.releaseByTag('1.0.0-rc.1'))
    await cli('publish', folder, [FINAL])
    assert.equal((await s.gh.latestRelease())?.tagName, '1.0.0')
    const released = (await s.gh.tag('1.0.0'))?.commit
    await s.gh.deleteTag('1.0.0')
    // GitHub turns the Release of a deleted tag into a draft (the plan relies on it; not documented)
    await waitFor(async () => (await s.gh.releases()).find((r) => r.tagName === '1.0.0' && r.draft), { what: 'the Release to become a draft', timeoutMs: 120000 })
    await cli('publish', s.work, [{ match: 'What do you want to publish?', answer: (/** @type {any} */ c) => /1\.0\.0 is released but its tag is missing/.test(c.label) }])
    assert.equal((await s.gh.tag('1.0.0'))?.commit, released)
    const rel = (await s.gh.releases()).find((r) => r.tagName === '1.0.0')
    assert.equal(rel?.draft, false)
    assert.equal((await s.gh.latestRelease())?.tagName, '1.0.0')
  } finally {
    await dispose(s.root)
  }
})

test('e2e: a ruleset requires an approval; the release goes out with a confirmed bypass, merged without asking again', { skip }, async () => {
  const s = await resetSandbox({ version: '1.0.0', protection: 'approval' })
  try {
    const folder = await startRelease(s, '1.0.0', '1.0.0')
    await cli('publish', folder, [FINAL, { match: 'without the approval (bypass)?', answer: true }])
    assert.ok(await s.registry.version('', '1.0.0'))
    assert.match((await s.gh.tag('1.0.0'))?.message ?? '', /confirmed-by: /)
    assert.ok(await contains(s.gh, /** @type {string} */ ((await s.gh.tag('1.0.0'))?.commit), 'main'))
  } finally {
    await dispose(s.root)
  }
})

test('e2e: the release pull request squashed by hand before the tag: the code in main is tagged and released', { skip }, async () => {
  const s = await resetSandbox({ version: '1.0.0', protection: 'approval' })
  try {
    const folder = await startRelease(s, '1.0.0', '1.0.0')
    const publishing = cli('publish', folder, [
      FINAL,
      { match: 'without the approval (bypass)?', answer: false },
      { match: 'Tag the code in main and release it?', answer: true },
    ])
    publishing.catch(() => {})
    const pr = await waitFor(async () => (await s.gh.pulls({ head: 'release/1.0.0', base: 'main', state: 'open' }))[0], { what: 'the release pull request' })
    await api(s.gh, 'PUT', `pulls/${pr.number}/merge`, { merge_method: 'squash' })
    await publishing
    assert.ok(await s.registry.version('', '1.0.0'))
    const tag = await s.gh.tag('1.0.0')
    assert.match(tag?.message ?? '', /confirmed-by: /)
    assert.ok(await contains(s.gh, /** @type {string} */ (tag?.commit), 'main'))
  } finally {
    await dispose(s.root)
  }
})

test('e2e: a commit pushed to the release branch after the tag: main gets only the released commit, the branch stays', { skip }, async () => {
  const s = await resetSandbox({ version: '1.0.0' })
  try {
    const folder = await startRelease(s, '1.0.0', '1.0.0')
    const publishing = cli('publish', folder, [FINAL])
    publishing.catch(() => {})
    await waitFor(() => s.gh.tag('1.0.0'), { what: 'the tag' })
    const other = await colleague(s.root, 'release/1.0.0')
    await writeFile(join(other, 'src/later.js'), 'later\n')
    await git(other, ['add', '-A'])
    await git(other, [...ID, 'commit', '--quiet', '-m', 'feat: later'])
    await git(other, ['push', '--quiet', 'origin', 'HEAD:refs/heads/release/1.0.0'])
    await publishing
    assert.ok(await s.registry.version('', '1.0.0'))
    assert.ok(await contains(s.gh, /** @type {string} */ ((await s.gh.tag('1.0.0'))?.commit), 'main'))
    assert.equal(await s.gh.file('src/later.js', 'main'), null, 'the later commit is not in main')
    assert.ok(await s.gh.branchSha('release/1.0.0'), 'the branch with the later commit stays')
    assert.equal(await s.gh.branchSha('release-merge/1.0.0'), null, 'the helper branch is deleted')
  } finally {
    await dispose(s.root)
  }
})

test('e2e: the publishing job fails before npm; "Re-run failed jobs" publishes the package of the first attempt', { skip }, async () => {
  const s = await resetSandbox({ version: '1.0.0', failAt: 'action-publish' })
  try {
    const folder = await startRelease(s, '1.0.0', '1.0.0')
    await cli('publish', folder, [FINAL, { match: 'Re-run the failed publishing job?', answer: true }])
    assert.ok(await s.registry.version('', '1.0.0'))
    const [latest] = await runResults(s.gh, '1.0.0')
    assert.equal(latest.run.attempt, 2)
    assert.match((await s.gh.releaseByTag('1.0.0'))?.body ?? '', new RegExp(`run-id: ${latest.run.id}`), 'the Release comes from the re-run')
  } finally {
    await dispose(s.root)
  }
})

test('e2e: tags made by hand: an old one is refused, a queue of four runs, a deletion runs no build, the same name again gets a run; cleanup', { skip }, async () => {
  const s = await resetSandbox({ version: '1.0.0' })
  try {
    const head = await git(s.work, ['rev-parse', 'HEAD'])
    const completed = (/** @type {string} */ name, /** @type {number} */ n = 1) =>
      waitFor(async () => {
        const rs = (await runResults(s.gh, name)).filter((x) => x.run.status === 'completed' && x.jobs.some((j) => j.name === 'build' && j.conclusion !== 'skipped'))
        return rs.length >= n ? rs : null
      }, { what: `a run of ${name}` })
    // pushed again from a clone, hours after it was created
    await pushToolTag(s.work, { name: '1.0.0-dev.old', commit: head, kind: 'dev', ageSeconds: 3 * 3600 })
    const [old] = await completed('1.0.0-dev.old')
    assert.ok(old.codes.some((c) => /^invalid-tag: .*an hour or more older/.test(c)), old.codes.join('\n'))
    // four at once: all run one after the other, none is cancelled (queue: max)
    const names = ['a', 'b', 'c', 'd'].map((x) => `1.0.0-dev.q${x}`)
    for (const n of names) await pushToolTag(s.work, { name: n, commit: head, kind: 'dev' })
    for (const n of names) {
      const [r] = await completed(n)
      assert.equal(r.run.conclusion, 'success', `${n}: ${r.codes.join(' | ')}`)
    }
    // deleted: its run skips the build job; created again on the same commit: a new run
    await s.gh.deleteTag('1.0.0-dev.old')
    await waitFor(
      async () => (await runResults(s.gh, '1.0.0-dev.old')).find((x) => x.jobs.some((j) => j.name === 'build' && j.conclusion === 'skipped')),
      { what: 'the run of the deletion' },
    )
    await pushToolTag(s.work, { name: '1.0.0-dev.old', commit: head, kind: 'dev' })
    const again = await completed('1.0.0-dev.old', 2)
    assert.equal(again[0].run.conclusion, 'success', again[0].codes.join(' | '))
    // cleanup: only tags older than two hours
    await pushToolTag(s.work, { name: '1.0.0-dev.stale', commit: head, kind: 'dev', ageSeconds: 3 * 3600 })
    await completed('1.0.0-dev.stale')
    const { result } = await cli('cleanup', s.work, [
      { match: 'What to delete?', answer: 'delete all' },
      { match: 'Delete these', answer: true },
    ])
    assert.deepEqual(result, ['1.0.0-dev.stale'])
    assert.equal(await s.gh.tag('1.0.0-dev.stale'), null)
    assert.equal((await s.gh.tagRuns('release.yml', '1.0.0-dev.stale')).filter((r) => r.status === 'completed' && r.event === 'push').length, 0, 'its runs are deleted')
    for (const n of names) assert.ok(await s.gh.tag(n), `${n} is younger than two hours and stays`)
  } finally {
    await dispose(s.root)
  }
})

test('e2e: cancel closes the pull requests into the branch, withdraws the unreleased tag and deletes the branch', { skip }, async () => {
  const s = await resetSandbox({ version: '1.0.0' })
  try {
    const folder = await startRelease(s, '1.0.0', '1.0.0')
    await cli('publish', folder, [pick(/^beta/)])
    await writeFile(join(folder, 'FAIL'), 'x')
    await git(folder, ['add', 'FAIL'])
    await git(folder, [...ID, 'commit', '--quiet', '-m', 'break'])
    await assert.rejects(cli('publish', folder, [FINAL]), /nothing was published/)
    assert.ok(await s.gh.tag('1.0.0'))
    const other = await colleague(s.root, 'main')
    await git(other, ['switch', '--quiet', '-c', 'feature'])
    await mkdir(join(other, 'src'), { recursive: true })
    await writeFile(join(other, 'src/feature.js'), 'feature\n')
    await git(other, ['add', '-A'])
    await git(other, [...ID, 'commit', '--quiet', '-m', 'feat: feature'])
    await git(other, ['push', '--quiet', 'origin', 'feature'])
    const into = await s.gh.createPull({ head: 'feature', base: 'release/1.0.0', title: 'feature', body: '' })
    await cli('start', s.work, [
      { match: 'What do you want to start?', answer: (/** @type {any} */ c) => c.label.startsWith('release/1.0.0') },
      { match: 'targets release/1.0.0', answer: 'close it' },
    ])
    assert.equal(await s.gh.tag('1.0.0'), null, 'the unreleased tag is withdrawn')
    assert.equal(await s.gh.branchSha('release/1.0.0'), null)
    assert.equal((await s.gh.pullRest(into.number)).state, 'closed')
    assert.equal((await s.gh.pulls({ head: 'release/1.0.0', base: 'main', state: 'open' })).length, 0)
    assert.ok(await s.registry.version('', '1.0.0-beta.1'), 'the prerelease stays')
  } finally {
    await dispose(s.root)
  }
})

test('e2e: classic protection with an up-to-date branch: main moves while the release waits, main is merged in', { skip }, async () => {
  const s = await resetSandbox({ version: '1.0.0', ci: true, protection: 'strict' })
  try {
    const folder = await startRelease(s, '1.0.0', '1.0.0')
    const publishing = cli('publish', folder, [FINAL])
    publishing.catch(() => {})
    await waitFor(async () => (await s.gh.pulls({ head: 'release/1.0.0', base: 'main', state: 'open' }))[0], { what: 'the release pull request' })
    await mkdir(join(s.work, 'doc'), { recursive: true })
    await writeFile(join(s.work, 'doc/notes.md'), 'notes\n')
    await git(s.work, ['add', '-A'])
    await git(s.work, [...ID, 'commit', '--quiet', '-m', 'docs: notes'])
    await git(s.work, ['push', '--quiet', 'origin', 'main'])
    await publishing
    assert.ok(await s.registry.version('', '1.0.0'))
    const tag = await s.gh.tag('1.0.0')
    assert.ok(await s.gh.file('doc/notes.md', /** @type {string} */ (tag?.commit)), 'the tagged commit contains the change of main')
  } finally {
    await dispose(s.root)
  }
})

test('e2e: a final interrupted after each of its steps is finished by running it again, nothing twice', { skip }, async () => {
  const s = await resetSandbox({ version: '1.0.0' })
  try {
    const folder = await startRelease(s, '1.0.0', '1.0.0')
    for (const step of ['final-commit', 'push', 'pull-request', 'push-tag', 'merge']) {
      await assert.rejects(cli('publish', folder, [FINAL], { failAt: step }), /interrupted/, step)
    }
    await cli('publish', folder, [FINAL])
    assert.ok(await s.registry.version('', '1.0.0'))
    assert.equal((await s.gh.pulls({ head: 'release/1.0.0', base: 'main', state: 'all' })).length, 1, 'one release pull request')
    const tagRuns = (await s.gh.tagRuns('release.yml', '1.0.0')).filter((r) => r.event === 'push')
    assert.equal(tagRuns.length, 1, 'one tag, one run')
    assert.ok(await contains(s.gh, /** @type {string} */ ((await s.gh.tag('1.0.0'))?.commit), 'main'))
  } finally {
    await dispose(s.root)
  }
})
