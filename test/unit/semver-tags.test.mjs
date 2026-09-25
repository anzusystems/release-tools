// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as semver from '../../lib/semver.mjs'
import { classifyVersion, formatTagMessage, parseTagMessage, mktagContent, toolTag, skipsCi } from '../../lib/tags.mjs'

test('semver parse, compare and bump', () => {
  assert.equal(semver.valid('1.2.3'), true)
  assert.equal(semver.valid('01.2.3'), false)
  assert.equal(semver.valid('1.2.3-rc.01'), false)
  assert.equal(semver.isStable('1.2.3'), true)
  assert.equal(semver.isStable('1.2.3+build'), false)
  assert.equal(semver.isStable('1.2.3-beta.1'), false)
  const sorted = semver.sortAsc(['3.1.0', '3.1.0-rc.1', '3.1.0-alpha.1', '3.1.0-beta.2', '3.1.0-beta.10', '3.0.9', '3.1.0-beta.2.dev.x'])
  assert.deepEqual(sorted, ['3.0.9', '3.1.0-alpha.1', '3.1.0-beta.2', '3.1.0-beta.2.dev.x', '3.1.0-beta.10', '3.1.0-rc.1', '3.1.0'])
  assert.equal(semver.compare('1.0.0+a', '1.0.0+b'), 0)
  assert.equal(semver.bump('3.0.0', 'patch'), '3.0.1')
  assert.equal(semver.bump('3.0.5', 'minor'), '3.1.0')
  assert.equal(semver.bump('3.4.5', 'major'), '4.0.0')
  assert.equal(semver.line('2.30.1'), '2.30')
  assert.equal(semver.core('3.1.0-rc.2'), '3.1.0')
  assert.equal(semver.max(['1.0.0', '2.0.0-rc.1', '1.9.9']), '2.0.0-rc.1')
})

test('classifyVersion: stable, prerelease, dev', () => {
  assert.deepEqual(classifyVersion('3.1.0'), { kind: 'stable', version: '3.1.0', core: '3.1.0' })
  assert.deepEqual(classifyVersion('3.1.0-rc.2'), { kind: 'prerelease', version: '3.1.0-rc.2', core: '3.1.0', id: 'rc', n: 2 })
  assert.equal(classifyVersion('3.1.0-gamma.1'), null)
  assert.equal(classifyVersion('3.1.0-rc.0x'), null)
  assert.equal(classifyVersion('v3.1.0'), null)
  assert.deepEqual(classifyVersion('3.0.0-dev.20260923143000'), { kind: 'dev', version: '3.0.0-dev.20260923143000', core: '3.0.0', base: '3.0.0', label: '20260923143000' })
  assert.deepEqual(classifyVersion('3.1.0-beta.2.dev.new-filter'), {
    kind: 'dev',
    version: '3.1.0-beta.2.dev.new-filter',
    core: '3.1.0',
    base: '3.1.0-beta.2',
    label: 'new-filter',
  })
  assert.equal(classifyVersion('3.0.0-dev.01'), null)
  assert.equal(classifyVersion('3.0.0-dev.123'), null)
  assert.equal(classifyVersion('3.0.0-dev.a_b'), null)
  assert.equal(classifyVersion('1.47.0-beta.dev-2'), null)
})

test('tag message: format and parse, both separators, unknown keys, old formats', () => {
  const m = formatTagMessage({ kind: 'final', pr: 12, candidate: '3.1.0-rc.2', confirmedBy: 'a-maintainer', id: 'abc123' })
  assert.equal(m, 'release-tools: final\npr: 12\ncandidate: 3.1.0-rc.2\nconfirmed-by: a-maintainer\nid: abc123\n')
  const p = parseTagMessage(m)
  assert.equal(p?.kind, 'final')
  assert.equal(p?.pr, 12)
  assert.equal(p?.candidate, '3.1.0-rc.2')
  assert.equal(p?.confirmedBy, 'a-maintainer')
  assert.equal(p?.id, 'abc123')
  // The one-line form of the plan and unknown keys from a newer version.
  const one = parseTagMessage('release-tools: final; pr: 7; candidate: 3.1.0-rc.1; future-key: x\nsomething: else\n')
  assert.equal(one?.pr, 7)
  assert.equal(one?.candidate, '3.1.0-rc.1')
  assert.equal(one?.fields['future-key'], 'x')
  assert.equal(parseTagMessage('release-tools: dev\n')?.kind, 'dev')
  assert.equal(parseTagMessage('Release 3.1.0'), null)
  assert.equal(parseTagMessage('release-tools: party'), null)
  assert.equal(parseTagMessage('release-tools: final\npr: x'), null)
  assert.equal(parseTagMessage('release-tools: final\ncandidate: 3.1.0'), null)
  const signed = parseTagMessage('release-tools: hotfix\nid: 1\n-----BEGIN PGP SIGNATURE-----\npr: 5\n')
  assert.equal(signed?.kind, 'hotfix')
  assert.equal(signed?.pr, undefined)
})

test('toolTag: format, annotation and kind must fit', () => {
  const msg = formatTagMessage({ kind: 'final', id: '1' })
  assert.ok(toolTag({ name: '3.1.0', annotated: true, message: msg }))
  assert.equal(toolTag({ name: '3.1.0', annotated: false, message: msg }), null)
  assert.equal(toolTag({ name: '3.1.0-rc.1', annotated: true, message: msg }), null)
  assert.equal(toolTag({ name: 'v3.1.0', annotated: true, message: msg }), null)
  assert.ok(toolTag({ name: '3.1.0-rc.1', annotated: true, message: formatTagMessage({ kind: 'prerelease', id: '1' }) }))
  assert.ok(toolTag({ name: '3.1.0-dev.x', annotated: true, message: formatTagMessage({ kind: 'dev', id: '1' }) }))
  assert.equal(toolTag({ name: '3.1.0-dev.x', annotated: true, message: formatTagMessage({ kind: 'prerelease', id: '1' }) }), null)
})

test('mktag content writes the tagger line directly', () => {
  const c = mktagContent({ commit: 'a'.repeat(40), name: '3.1.0', tagger: { name: 'A <x>', email: 'a@b.c' }, epochSeconds: 1790000000.9, message: 'release-tools: final\n' })
  assert.equal(c, `object ${'a'.repeat(40)}\ntype commit\ntag 3.1.0\ntagger A x <a@b.c> 1790000000 +0000\n\nrelease-tools: final\n`)
})

test('skip markers', () => {
  assert.equal(skipsCi('fix: x [skip ci]'), true)
  assert.equal(skipsCi('fix: x [CI SKIP]'), true)
  assert.equal(skipsCi('fix\n\nskip-checks: true'), true)
  assert.equal(skipsCi('fix\n\nskip-checks:true'), true)
  assert.equal(skipsCi('fix\n\nskip-checks: false'), false)
  assert.equal(skipsCi('docs: how to [skip] things'), false)
})
