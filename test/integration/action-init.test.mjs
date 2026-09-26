// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setupProject, git } from '../helpers/project.mjs'
import { run } from '../../lib/exec.mjs'
import { mktagContent, formatTagMessage } from '../../lib/tags.mjs'

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

test('the publishing job fails on a temporary error: re-run it with the same package', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  p.registry.failPublish = 1
  await p.cli('publish', [FINAL, { match: 'Re-run the failed publishing job?', answer: true }], { cwd: folder })
  assert.ok(p.registry.store.has('1.0.0'))
  const runs = p.gh.runList.filter((r) => r.headBranch === '1.0.0' && !r.deleted)
  assert.equal(runs.length, 1, 'the same run')
  assert.equal(runs[0].attempt, 2)
  const publishJob = runs[0].jobs.find((/** @type {any} */ j) => j.name === 'publish')
  assert.equal(publishJob.outputs['released-now'], 'true')
})

test('released, GitHub Release missing or a draft: the CLI adds or publishes it', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  await p.cli('publish', [pick(/^rc/)], { cwd: folder })
  p.gh.releaseList = p.gh.releaseList.filter((r) => r.tagName !== '1.0.0-rc.1')
  await p.cli('publish', [{ match: 'What do you want to publish?', answer: (/** @type {any} */ c) => /1\.0\.0-rc\.1 is released but its GitHub Release is missing/.test(c.label) }])
  const rel = p.gh.releaseList.find((r) => r.tagName === '1.0.0-rc.1')
  assert.ok(rel && !rel.draft && rel.prerelease)
  assert.match(rel.body, /created-by: release-tools CLI/)
  const again = p.gh.releaseList.find((r) => r.tagName === '1.0.0-rc.1')
  if (again) again.draft = true
  await p.cli('publish', [{ match: 'What do you want to publish?', answer: (/** @type {any} */ c) => /1\.0\.0-rc\.1 is released but its GitHub Release is a draft/.test(c.label) }])
  assert.equal(p.gh.releaseList.find((r) => r.tagName === '1.0.0-rc.1')?.draft, false)
})

test('tags outside the tool are ignored; a run of a lightweight version tag releases nothing', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await git(p.work, ['push', '--quiet', 'origin', 'HEAD:refs/tags/0.9.0'])
  await p.gh.sync()
  await p.gh.pump()
  const r = p.gh.runList.find((x) => x.headBranch === '0.9.0')
  assert.equal(r.conclusion, 'success')
  const build = r.jobs.find((/** @type {any} */ j) => j.name === 'build')
  assert.equal(build.outputs.release, 'false')
  assert.match(build.annotations[0].message, /^nothing: /)
  assert.equal(p.registry.store.size, 0)
})

test('a tag created again on the same commit: the old run cannot publish (tag object checked)', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  await git(folder, ['push', '--quiet', 'origin', 'HEAD:refs/heads/release/1.0.0'])
  // An old tag object on the same commit, a bit older, then deleted and created again by the tool.
  const commit = await git(folder, ['rev-parse', 'HEAD'])
  const content = mktagContent({ commit, name: '1.0.0-rc.1', tagger: { name: 'x', email: 'x@example.com' }, epochSeconds: Math.floor(Date.now() / 1000), message: formatTagMessage({ kind: 'prerelease', id: 'old' }) })
  const old = (await run('git', ['mktag'], { cwd: p.bare, input: content })).stdout.trim()
  p.gh.autoRun = false
  await git(p.bare, ['update-ref', 'refs/tags/1.0.0-rc.1', old])
  await p.gh.onRefChange('refs/tags/1.0.0-rc.1', '0'.repeat(40), old, p.gh.now())
  const oldRun = p.gh.runList.find((r) => r.headBranch === '1.0.0-rc.1')
  // the tag is created again (a new object on the same commit) between the build and the publish job
  const fresh = (await run('git', ['mktag'], { cwd: p.bare, input: content.replace('id: old', 'id: new') })).stdout.trim()
  p.gh.betweenJobs = async (r) => {
    if (r.id === oldRun.id) await git(p.bare, ['update-ref', 'refs/tags/1.0.0-rc.1', fresh])
  }
  p.gh.autoRun = true
  await p.gh.pump()
  assert.equal(p.registry.store.has('1.0.0-rc.1'), false, 'the old run published nothing')
  const pub = oldRun.jobs.find((/** @type {any} */ j) => j.name === 'publish')
  assert.match(pub?.annotations[0]?.message ?? '', /^invalid-run: /)
})

test('init: writes the files once, identical files are done, different ones are asked', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await git(p.work, ['rm', '--quiet', 'release.config.json', '.github/workflows/release.yml', 'doc/changelog/template.md'])
  await git(p.work, ['commit', '--quiet', '-m', 'remove the tool'])
  await git(p.work, ['push', '--quiet', 'origin', 'main'])
  const answers = [
    { match: 'Does the project publish to npm?', answer: 'yes, npm' },
    { match: 'File name of the release workflow', answer: 'release.yml' },
    { match: 'ci.checks', answer: 'npm test' },
    { match: 'Node version', answer: '24' },
  ]
  const plan = /** @type {any[]} */ (await p.cli('init', answers))
  assert.deepEqual(
    plan.map((x) => `${x.path}:${x.action}`),
    ['.github/workflows/release.yml:write', 'release.config.json:write', 'package.json:write', 'doc/changelog/template.md:write', 'CHANGELOG.md:done'],
  )
  const config = JSON.parse(await readFile(join(p.work, 'release.config.json'), 'utf8'))
  assert.equal(config.repo, 'test/pkg')
  assert.deepEqual(config.ci.checks, ['npm test'])
  const pkg = JSON.parse(await readFile(join(p.work, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['release:start'], 'npx -y --allow-git=all github:anzusystems/release-tools#main start')
  const again = /** @type {any[]} */ (await p.cli('init', answers))
  assert.ok(again.every((x) => x.action === 'done'), 'running it again changes nothing')
  await writeFile(join(p.work, '.github/workflows/release.yml'), 'name: other\n')
  const third = /** @type {any[]} */ (await p.cli('init', [...answers, { match: 'exists with a different content', answer: false }]))
  assert.equal(third.find((x) => x.path === '.github/workflows/release.yml').action, 'skip')
})

test('git safety: no local tags, nothing pushed but the refs of the tool, other refs of the user survive', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await git(p.work, ['config', '--add', 'remote.origin.fetch', '+refs/tags/*:refs/tags/*'])
  await git(p.work, ['config', 'push.followTags', 'true'])
  await git(p.work, ['config', 'fetch.prune', 'true'])
  await git(p.work, ['config', 'fetch.pruneTags', 'true'])
  await git(p.work, ['update-ref', 'refs/remotes/origin/pr/1', 'HEAD'])
  await git(p.work, ['tag', '-a', '-m', 'stray', '9.9.9'])
  const folder = await startRelease(p, '1.0.0', '1.0.0')
  await p.cli('publish', [pick(/^beta/)], { cwd: folder })
  await p.cli('publish', [FINAL], { cwd: folder })
  assert.deepEqual(await p.localTags(), ['9.9.9'], 'only the stray local tag, untouched')
  assert.equal(await p.gh.tag('9.9.9'), null, 'the stray tag was never pushed')
  assert.ok(await git(p.work, ['rev-parse', '--verify', 'refs/remotes/origin/pr/1']), 'a foreign ref survives')
  assert.ok(await git(p.work, ['rev-parse', '--verify', 'refs/release-tools/tags/1.0.0']))
})

test('--dry-run changes nothing', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  await assert.rejects(p.cli('start', [{ match: 'What do you want to start?', answer: '1.0.0' }], { dryRun: true }), /DryRun|would/)
  assert.equal(await p.gh.branchSha('release/1.0.0'), null)
  assert.equal(p.exists(p.folder('release/1.0.0')), false)
})
