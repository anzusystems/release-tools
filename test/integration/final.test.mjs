// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupProject } from '../helpers/project.mjs'

test('first final of a new project: start in bootstrap, publish, merge, clean up', async (t) => {
  const p = await setupProject({ version: '1.0.0' })
  t.after(() => p.dispose())
  const started = await p.cli('start', [{ match: 'What do you want to start?', answer: '1.0.0' }])
  assert.equal(started.branch, 'release/1.0.0')
  const folder = p.folder('release/1.0.0')
  assert.ok(p.exists(`${folder}/doc/changelog/1.0.0.md`))
  await p.writeChangelog('release/1.0.0', '1.0.0')
  await p.cli('publish', [{ match: 'What do you want to publish?', answer: (c) => c.label.startsWith('final') }], { cwd: folder })

  assert.ok(p.registry.store.has('1.0.0'), 'published to the registry')
  assert.equal(p.registry.tags.latest, '1.0.0')
  const rel = p.gh.releaseList.find((r) => r.tagName === '1.0.0')
  assert.ok(rel && !rel.draft && !rel.prerelease)
  assert.equal(p.gh.latestReleaseId, rel.id)
  const tagCommit = await p.sha('1.0.0^{commit}')
  assert.ok(await p.isAncestor(tagCommit, 'main'), 'the tagged commit is in main')
  const mainHead = await p.sha('main')
  const parents = (await p.show('main', '').catch(() => '')) && (await (await import('../helpers/project.mjs')).git(p.bare, ['log', '-1', '--format=%P', 'main'])).split(' ')
  assert.equal(parents[1], tagCommit, 'merged with a merge commit whose second parent is the tagged commit')
  assert.match(await p.show('main', 'CHANGELOG.md'), /- \[1\.0\.0\]\(doc\/changelog\/1\.0\.0\.md\) — \d{4}-\d{2}-\d{2}/)
  assert.match(await p.show('main', 'doc/changelog/1.0.0.md'), /^1\.0\.0 — \d{4}-\d{2}-\d{2}/)
  assert.equal(JSON.parse(await p.show('main', 'package.json')).version, '1.0.0')
  assert.equal(p.exists(folder), false, 'the folder is removed')
  assert.equal(await p.gh.branchSha('release/1.0.0'), null, 'the branch is deleted on GitHub')
  assert.deepEqual(await p.localTags(), [], 'no local tag is created')
  assert.ok(mainHead)
})
