// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  lastStable,
  lastOfLine,
  latestLine,
  olderLineHeads,
  nextPrereleaseNumber,
  candidateFor,
  npmTagFor,
  isLatest,
  devVersion,
  isOlderLine,
} from '../../lib/versions.mjs'

const released = ['2.30.0', '2.30.1', '2.29.4', '3.0.0', '3.1.0-rc.1', '3.1.0-beta.2', '1.46.0', '1.47.0-alpha77']

test('last released versions per line, from released versions, not tags', () => {
  assert.equal(lastStable(released), '3.0.0')
  assert.equal(latestLine(released), '3.0')
  assert.equal(lastOfLine(released, '2.30'), '2.30.1')
  assert.equal(lastOfLine(released, '2.31'), null)
  assert.deepEqual(olderLineHeads(released), ['2.30.1', '2.29.4', '1.46.0'])
  assert.equal(lastStable([]), null)
  assert.equal(isOlderLine('2.30.2', released), true)
  assert.equal(isOlderLine('3.0.1', released), false)
  assert.equal(isOlderLine('3.1.0', released), false)
})

test('prerelease numbers come from tags and registry versions', () => {
  assert.equal(nextPrereleaseNumber('3.1.0', 'beta', ['3.1.0-beta.1', '3.1.0-beta.2', '3.1.0-rc.1']), 3)
  assert.equal(nextPrereleaseNumber('3.1.0', 'rc', ['3.1.0-beta.1', '3.1.0-rc.1', '3.1.0-rc.4']), 5)
  assert.equal(nextPrereleaseNumber('3.1.0', 'alpha', ['3.1.0-beta.1']), 1)
  assert.equal(nextPrereleaseNumber('3.1.0', 'beta', ['3.1.0-beta.2.dev.x', '3.2.0-beta.7']), 1)
})

test('candidate is the highest released prerelease of the version', () => {
  assert.equal(candidateFor('3.1.0', released), '3.1.0-rc.1')
  assert.equal(candidateFor('3.2.0', released), null)
})

test('npm tags never move back and latest never moves on a prerelease', () => {
  const others = new Set(released)
  assert.equal(npmTagFor({ version: '3.1.0-rc.2', kind: 'prerelease', distTags: { rc: '3.1.0-rc.1', latest: '3.0.0' }, released: others }), 'rc')
  assert.equal(npmTagFor({ version: '3.0.1-rc.1', kind: 'prerelease', distTags: { rc: '3.1.0-rc.1' }, released: others }), 'rc-3.0')
  assert.equal(npmTagFor({ version: '2.30.2-rc.1', kind: 'prerelease', distTags: {}, released: others }), 'rc-2.30')
  assert.equal(npmTagFor({ version: '3.2.0-beta.1', kind: 'prerelease', distTags: { beta: 'garbage' }, released: others }), 'beta')
  assert.equal(npmTagFor({ version: '3.1.0', kind: 'final', distTags: {}, released: others }), 'latest')
  assert.equal(npmTagFor({ version: '2.30.2', kind: 'hotfix', distTags: {}, released: others }), 'latest-2.30')
})

test('Latest is the highest released stable version', () => {
  assert.equal(isLatest('3.1.0', released), true)
  assert.equal(isLatest('2.30.2', released), false)
  assert.equal(isLatest('3.0.0', released), true)
  assert.equal(isLatest('3.1.0-rc.1', released), false)
})

test('dev build versions', () => {
  assert.equal(devVersion('3.0.0', '3.0.0', '20260923143000'), '3.0.0-dev.20260923143000')
  assert.equal(devVersion('3.1.0-beta.2', '3.0.0', '20260923143000'), '3.1.0-beta.2.dev.20260923143000')
  assert.equal(devVersion(null, '1.47.0-beta.dev-2', 'new-filter'), '1.47.0-dev.new-filter')
  assert.equal(devVersion('2.30.1', '2.30.1', 'fix'), '2.30.1-dev.fix')
  assert.throws(() => devVersion('3.0.0', '3.0.0', '01'))
})
