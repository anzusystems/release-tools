// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setupProject, git } from '../helpers/project.mjs'
import { readTgz } from '../../lib/tar.mjs'

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

test('yarn 4: install without scripts, pack into the explicit name, CHANGELOG.md in the package, compared with the rc', async (t) => {
  const p = await setupProject({ version: '1.0.0', pm: 'yarn', requireTestedPrerelease: true })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  await p.cli('publish', [pick(/^rc/)], { cwd: folder })
  await p.cli('publish', [FINAL], { cwd: folder })
  const pkg = p.registry.store.get('1.0.0')
  assert.ok(pkg)
  const files = readTgz(pkg.tarball).map((e) => e.path)
  assert.ok(files.includes('CHANGELOG.md'), 'yarn packs CHANGELOG.md')
  assert.ok(files.includes('dist/index.js'))
  assert.equal(JSON.parse(readTgz(pkg.tarball).find((e) => e.path === 'package.json')?.data.toString() ?? '{}').version, '1.0.0')
})

test('pnpm: final release', async (t) => {
  const p = await setupProject({ version: '1.0.0', pm: 'pnpm' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  await p.cli('publish', [pick(/^beta/)], { cwd: folder })
  await p.cli('publish', [FINAL], { cwd: folder })
  assert.ok(p.registry.store.has('1.0.0-beta.1'))
  assert.ok(p.registry.store.has('1.0.0'))
  assert.equal(JSON.parse(readTgz(/** @type {any} */ (p.registry.store.get('1.0.0-beta.1')).tarball).find((e) => e.path === 'package.json')?.data.toString() ?? '{}').version, '1.0.0-beta.1')
})

test('merging main: conflicts on the version, in the lockfile and in the index are resolved; dependencies of both sides stay', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await p.cli('publish', [FINAL], { cwd: await startRelease(p, '1.0.0', '1.0.0') })
  const minor = await startRelease(p, 'minor', '1.1.0')
  // the final commit of 1.1.0 exists, then 1.0.1 is released and merged into main
  await assert.rejects(p.cli('publish', [FINAL], { cwd: minor, failAt: 'final-commit' }), /interrupted/)
  await git(minor, ['push', '--quiet', '--no-follow-tags', 'origin', 'HEAD:refs/heads/release/1.1.0'])
  const pkgPath = join(minor, 'package.json')
  const withDep = JSON.parse(await readFile(pkgPath, 'utf8'))
  withDep.description = 'minor side'
  await writeFile(pkgPath, `${JSON.stringify(withDep, null, 2)}\n`)
  await p.commit(minor, {}, 'chore: description on the minor side')
  const patch = await startRelease(p, 'patch', '1.0.1')
  await p.commit(patch, { 'src/extra.js': 'export const y = 1\n' }, 'fix: y')
  await p.cli('publish', [FINAL], { cwd: patch })
  assert.ok(p.registry.store.has('1.0.1'))
  await p.cli('publish', [FINAL], { cwd: minor })
  assert.ok(p.registry.store.has('1.1.0'))
  const main = JSON.parse(await p.show('main', 'package.json'))
  assert.equal(main.version, '1.1.0')
  assert.equal(main.description, 'minor side')
  assert.equal(JSON.parse(await p.show('main', 'package-lock.json')).packages[''].version, '1.1.0')
  const index = await p.show('main', 'CHANGELOG.md')
  assert.ok(index.includes('[1.1.0]') && index.includes('[1.0.1]') && index.includes('[1.0.0]'))
  assert.ok(index.indexOf('[1.1.0]') < index.indexOf('[1.0.1]'))
  assert.equal(await p.show('main', 'src/extra.js'), 'export const y = 1')
})

test('another conflict with main: the merge stays unfinished; after the resolution the command goes on', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await p.cli('publish', [FINAL], { cwd: await startRelease(p, '1.0.0', '1.0.0') })
  const minor = await startRelease(p, 'minor', '1.1.0')
  await p.commit(minor, { 'doc/readme.md': 'minor\n' }, 'docs: minor')
  await p.changeMain({ 'doc/readme.md': 'main\n' }, 'docs: main')
  await assert.rejects(p.cli('publish', [FINAL], { cwd: minor }), /left conflicts in:\n\s+doc\/readme.md/)
  assert.ok(await git(minor, ['rev-parse', '--verify', 'MERGE_HEAD']))
  await assert.rejects(p.cli('publish', [FINAL], { cwd: minor }), /merge is not finished/)
  await writeFile(join(minor, 'doc/readme.md'), 'both\n')
  await git(minor, ['add', 'doc/readme.md'])
  await git(minor, ['commit', '--quiet', '--no-edit'])
  await p.cli('publish', [FINAL], { cwd: minor })
  assert.ok(p.registry.store.has('1.1.0'))
  assert.equal(await p.show('main', 'doc/readme.md'), 'both')
})

test('release pull request squashed by hand after the release: a new pull request from the released commit', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  p.gh.afterRun = async (r) => {
    if (r.headBranch !== '1.0.0') return
    p.gh.afterRun = null
    const pr = p.gh.openPull('release/1.0.0')
    await p.gh.mergeInto(pr, 'squash', 'release: 1.0.0', 'someone')
  }
  await p.cli('publish', [FINAL], { cwd: folder })
  assert.ok(await p.isAncestor('1.0.0^{commit}', 'main'), 'the released commit reached main')
  assert.ok(p.gh.pullList.some((x) => x.head === 'release-merge/1.0.0' && x.state === 'merged'))
})

test('merged by hand with a merge commit after the tag, with a commit after the tag: done, the commit is listed', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  p.gh.afterRun = async (r) => {
    if (r.headBranch !== '1.0.0') return
    p.gh.afterRun = null
    const side = `${p.root}/side-late`
    await git(p.root, ['clone', '--quiet', '-b', 'release/1.0.0', p.bare, side])
    await git(side, ['-c', 'user.email=x@example.com', '-c', 'user.name=X', 'commit', '--quiet', '--allow-empty', '-m', 'feat: late'])
    await git(side, ['push', '--quiet', 'origin', 'HEAD:refs/heads/release/1.0.0'])
    await p.gh.sync()
    await p.gh.mergeInto(p.gh.openPull('release/1.0.0'), 'merge', 'Merge pull request', 'someone')
  }
  await p.cli('publish', [FINAL], { cwd: folder })
  assert.ok(await p.isAncestor('1.0.0^{commit}', 'main'))
  assert.match(p.lastUi?.text() ?? '', /reached main without being in 1\.0\.0[\s\S]*feat: late/)
})

test('pull requests GitHub retargeted to main after a manual merge are listed', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  p.gh.settings.deleteBranchOnMerge = true
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  /** @type {any} */
  let feature = null
  p.gh.afterRun = async (r) => {
    if (r.headBranch !== '1.0.0') return
    p.gh.afterRun = null
    // a pull request into the release branch opened after the tag, then the release pull request merged by hand
    await git(p.bare, ['branch', 'feature', 'refs/heads/release/1.0.0'])
    feature = await p.gh.createPull({ head: 'feature', base: 'release/1.0.0', title: 'late feature', body: '' })
    await p.gh.mergeInto(p.gh.openPull('release/1.0.0'), 'squash', 'release: 1.0.0', 'someone')
  }
  await p.cli('publish', [FINAL], { cwd: folder })
  const text = p.lastUi?.text() ?? ''
  assert.equal(p.gh.pullList.find((x) => x.number === feature.number)?.base, 'main', 'GitHub retargeted it')
  assert.match(text, new RegExp(`retargeted[\\s\\S]*#${feature.number} late feature`))
})

test('the changelog pull request of a hotfix is brought up to date when main moves', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await p.cli('publish', [FINAL], { cwd: await startRelease(p, '1.0.0', '1.0.0') })
  await p.cli('publish', [FINAL], { cwd: await startRelease(p, 'minor', '1.1.0') })
  await p.cli('start', [{ match: 'What do you want to start?', answer: '1.0.0 → 1.0.1' }])
  await p.writeChangelog('hotfix/1.0.1', '1.0.1')
  p.gh.settings.strict = true
  let moved = false
  const pullFn = p.gh.pull.bind(p.gh)
  p.gh.pull = async (n) => {
    const pr = p.gh.pullList.find((x) => x.number === n)
    if (!moved && pr?.head === 'docs/changelog-1.0.1') {
      moved = true
      await p.changeMain({ 'doc/moved.md': 'moved\n' }, 'docs: moved')
    }
    return pullFn(n)
  }
  await p.cli('publish', [FINAL], { cwd: p.folder('hotfix/1.0.1') })
  assert.ok(moved)
  assert.match(await p.show('main', 'doc/changelog/1.0.1.md'), /^1\.0\.1 — /)
  assert.equal(await p.show('main', 'doc/moved.md'), 'moved')
  assert.equal(await p.gh.branchSha('docs/changelog-1.0.1'), null)
})

test('npm version runs no scripts of the project', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const pkgPath = join(p.work, 'package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  pkg.scripts.version = 'node -e "require(\'fs\').writeFileSync(\'SCRIPT-RAN\', \'x\')"'
  pkg.scripts.preversion = 'node -e "process.exit(1)"'
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  await p.commit(p.work, {}, 'chore: version scripts')
  await p.cli('publish', [FINAL], { cwd: await startRelease(p, '1.0.0', '1.0.0') })
  assert.ok(p.registry.store.has('1.0.0'))
  await assert.rejects(p.show('main', 'SCRIPT-RAN'))
})
