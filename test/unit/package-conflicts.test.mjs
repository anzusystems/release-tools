// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { checkManifest, compareWithCandidate, verifyPack, tarballName } from '../../lib/package-check.mjs'
import { rootVersionLines, setRootVersion, resolveVersionConflict, resolveIndexConflict } from '../../lib/conflicts.mjs'
import { readTgz, integrity } from '../../lib/tar.mjs'
import { formatFooter, parseFooter, withFooter, composeBody, stripHeader } from '../../lib/release-body.mjs'
import { parseConfig, repoSettings, buildSettings } from '../../lib/config.mjs'
import { detectPackageManager, ciInstall, packCommand } from '../../lib/pm.mjs'
import { tagAge } from '../../publish/validate.mjs'
import { cleanEnv } from '../../publish/publish.mjs'
import { globToRegExp, repoFromUrl } from '../../lib/util.mjs'

const f = (/** @type {string} */ path, /** @type {string} */ text) => ({ path, data: Buffer.from(text) })

test('manifest checks: name, version, repository, private, publishConfig allow list', () => {
  const ok = { name: '@a/b', version: '1.0.0', repository: { url: 'git+https://github.com/o/r.git' }, publishConfig: { exports: {} } }
  assert.deepEqual(checkManifest(ok, { packageName: '@a/b', version: '1.0.0', repo: 'o/r', npm: true }), [])
  const bad = { name: '@a/c', version: '1.0.1', private: true, repository: 'https://github.com/x/y', publishConfig: { registry: 'x', '@x:registry': 'y', provenance: false, tag: 'latest', access: 'restricted', 'dry-run': true } }
  const p = checkManifest(bad, { packageName: '@a/b', version: '1.0.0', repo: 'o/r', npm: true })
  assert.equal(p.length, 10)
  assert.deepEqual(checkManifest({ name: 'app', version: '1.0.0' }, { packageName: 'app', version: '1.0.0', repo: 'o/r', npm: false }), [])
})

test('candidate comparison ignores the changelog, the version and the self dependency', () => {
  const pkg = (/** @type {string} */ v) => JSON.stringify({ name: '@a/b', version: v, dependencies: { '@a/b': `^${v}`, x: '1' } })
  const stable = [f('package.json', pkg('3.1.0')), f('dist/a.js', 'A'), f('CHANGELOG.md', 'new'), f('doc/changelog/3.1.0.md', '3.1.0 — 2026-09-25'), f('npm-shrinkwrap.json', JSON.stringify({ version: '3.1.0', packages: { '': { version: '3.1.0' } } }))]
  const rc = [f('package.json', pkg('3.1.0-rc.1')), f('dist/a.js', 'A'), f('CHANGELOG.md', 'old'), f('doc/changelog/3.1.0.md', '3.1.0 — unreleased'), f('npm-shrinkwrap.json', JSON.stringify({ version: '3.1.0-rc.1', packages: { '': { version: '3.1.0-rc.1' } } }))]
  assert.deepEqual(compareWithCandidate(stable, rc, { packageName: '@a/b', changelogDir: 'doc/changelog' }), [])
  const changed = [...rc.filter((e) => e.path !== 'dist/a.js'), f('dist/a.js', 'B'), f('dist/extra.js', '')]
  assert.deepEqual(compareWithCandidate(stable, changed, { packageName: '@a/b', changelogDir: 'doc/changelog' }), ['different: dist/a.js', 'only in the prerelease: dist/extra.js'])
})

test('pack.verify', () => {
  const entries = [f('dist/a.js', 'A'), f('package.json', '{}'), f('src/vite/x.ts', 'x'), f('secret.env', 's')]
  const local = new Map([['dist/a.js', Buffer.from('A')], ['dist/b.js', Buffer.from('B')]])
  assert.deepEqual(verifyPack(entries, local, { compare: ['dist'], allow: ['package.json', 'src/vite/**'] }), ['missing in the package: dist/b.js', 'not allowed in the package: secret.env'])
  assert.equal(globToRegExp('src/**').test('src/a/b.ts'), true)
  assert.equal(globToRegExp('*.md').test('a/b.md'), false)
  assert.equal(tarballName('@anzusystems/common-admin', '3.0.0-dev.20260923143000'), 'anzusystems-common-admin-3.0.0-dev.20260923143000.tgz')
})

test('root version lines only, formatting kept', () => {
  const lock = `{
  "name": "x",
  "version": "3.0.0",
  "lockfileVersion": 3,
  "packages": {
    "": {
      "name": "x",
      "version": "3.0.0",
      "dependencies": { "dep": "^1.0.0" }
    },
    "node_modules/dep": {
      "version": "1.0.0"
    }
  }
}
`
  assert.deepEqual(rootVersionLines(lock), [2, 7])
  const out = setRootVersion(lock, '3.1.0')
  assert.equal(out, lock.replace(/"version": "3.0.0"/g, '"version": "3.1.0"'))
  assert.match(out, /"node_modules\/dep": \{\n\s+"version": "1.0.0"/)
})

test('version conflicts are resolved, dependency changes of both sides kept, other conflicts stay', async () => {
  const pkg = (/** @type {string} */ v, /** @type {string} */ a, /** @type {string} */ c) =>
    `{\n  "name": "x",\n  "version": "${v}",\n  "private": false,\n  "type": "module",\n  "dependencies": {\n    "a": "${a}",\n    "b": "1.0.0",\n    "c": "${c}"\n  }\n}\n`
  const base = pkg('3.0.0', '1.0.0', '1.0.0')
  const ours = pkg('3.1.0', '2.0.0', '1.0.0')
  const theirs = pkg('3.0.1', '1.0.0', '3.0.0')
  assert.equal(await resolveVersionConflict({ base, ours, theirs }, '3.1.0'), pkg('3.1.0', '2.0.0', '3.0.0'))
  const theirs2 = pkg('3.0.1', '9.0.0', '3.0.0')
  assert.equal(await resolveVersionConflict({ base, ours, theirs: theirs2 }, '3.1.0'), null)
})

test('index conflicts are rebuilt, other lines stay a conflict', async () => {
  const base = '# Changelog\n\nIntro.\n\n- [3.0.0](doc/changelog/3.0.0.md) — 2026-09-01\n'
  const ours = '# Changelog\n\nIntro.\n\n- [3.1.0](doc/changelog/3.1.0.md) — 2026-09-25\n- [3.0.0](doc/changelog/3.0.0.md) — 2026-09-01\n'
  const theirs = '# Changelog\n\nIntro.\n\n- [3.0.1](doc/changelog/3.0.1.md) — 2026-09-20\n- [3.0.0](doc/changelog/3.0.0.md) — 2026-09-01\n'
  const lines = ['- [3.1.0](doc/changelog/3.1.0.md) — 2026-09-25', '- [3.0.1](doc/changelog/3.0.1.md) — 2026-09-20', '- [3.0.0](doc/changelog/3.0.0.md) — 2026-09-01']
  assert.equal(await resolveIndexConflict({ base, ours, theirs }, lines), `# Changelog\n\nIntro.\n\n${lines.join('\n')}\n`)
  assert.equal(await resolveIndexConflict({ base, ours: ours.replace('Intro.', 'Ours.'), theirs: theirs.replace('Intro.', 'Theirs.') }, lines), null)
})

test('tar reader and integrity', () => {
  const header = (/** @type {string} */ name, /** @type {number} */ size) => {
    const h = Buffer.alloc(512)
    h.write(name, 0)
    h.write('0000644\0', 100)
    h.write(size.toString(8).padStart(11, '0') + '\0', 124)
    h.write('0', 156)
    h.write('ustar\0', 257)
    return h
  }
  const content = Buffer.from('{"name":"x"}')
  const tar = Buffer.concat([header('package/package.json', content.length), content, Buffer.alloc(512 - content.length), Buffer.alloc(1024)])
  const tgz = gzipSync(tar)
  const entries = readTgz(tgz)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].path, 'package.json')
  assert.equal(entries[0].data.toString(), '{"name":"x"}')
  assert.match(integrity(tgz), /^sha512-/)
})

test('Release footer: last block wins, unknown keys ignored', () => {
  const body = withFooter('text\n<!-- release-tools\ncommit: ' + 'b'.repeat(40) + '\n-->', { commit: 'a'.repeat(40), runId: 42 })
  const p = parseFooter(body)
  assert.equal(p?.commit, 'a'.repeat(40))
  assert.equal(p?.runId, '42')
  assert.equal(parseFooter(`${formatFooter({ commit: 'c'.repeat(40) })}`)?.runId, null)
  assert.equal(parseFooter('<!-- release-tools\ncommit: nope\nnew-key: 1\n-->')?.commit, null)
  assert.equal(parseFooter('no footer'), null)
  assert.equal(stripHeader('3.1.0 — 2026-09-25\n===\n\nBody\n').trim(), 'Body')
  assert.match(composeBody({ repo: 'o/r', tag: '3.1.0-beta.1', commit: 'c', changelog: null, branch: 'release/3.1.0' }), /no changelog yet/)
})

test('configuration: defaults, validation, unknown keys ignored', () => {
  const raw = parseConfig(JSON.stringify({ version: 1, repo: 'o/r', ci: { checks: ['yarn ci'] }, futureKey: true }), 'test')
  const r = repoSettings(raw, { name: '@o/r' })
  assert.deepEqual(r, { repo: 'o/r', package: '@o/r', publish: 'npm', releaseWorkflow: 'release.yml', requireTestedPrerelease: false, worktreeCopy: [], npmEnvironment: 'npmjs-publish' })
  const b = buildSettings(raw)
  assert.equal(b.changelogDir, 'doc/changelog')
  assert.equal(b.build, null)
  assert.throws(() => parseConfig(JSON.stringify({ version: 1, repo: 'o/r', ci: { checks: [] } }), 'test'), /ci.checks/)
  assert.throws(() => parseConfig(JSON.stringify({ version: 2, repo: 'o/r', ci: { checks: ['x'] } }), 'test'), /not supported/)
  assert.equal(buildSettings(parseConfig(JSON.stringify({ version: 1, repo: 'o/r', build: false, ci: { checks: ['x'] } }), 't')).build, false)
})

test('package managers', () => {
  assert.deepEqual(detectPackageManager({ packageManager: 'yarn@4.14.1' }, () => false), { name: 'yarn', version: '4.14.1' })
  assert.throws(() => detectPackageManager({ packageManager: 'yarn@1.22.22' }, () => false))
  assert.equal(detectPackageManager({}, (p) => p === 'pnpm-lock.yaml').name, 'pnpm')
  assert.throws(() => detectPackageManager({}, (p) => p === 'yarn.lock'))
  assert.equal(detectPackageManager({}, () => false).name, 'npm')
  assert.equal(ciInstall({ name: 'yarn', version: null }, false), 'yarn install --immutable --mode=skip-build')
  assert.equal(ciInstall({ name: 'npm', version: null }, false), 'npm ci --ignore-scripts')
  assert.equal(ciInstall({ name: 'pnpm', version: null }, true), 'pnpm install --frozen-lockfile')
  assert.deepEqual(packCommand({ name: 'yarn', version: null }, '/t/a.tgz', '/t').args, ['pack', '--out', '/t/a.tgz'])
})

test('tag age: under, at and over the limits', () => {
  const tag = new Date('2026-09-25T10:00:00Z')
  const at = (/** @type {number} */ ms) => new Date(tag.getTime() + ms)
  assert.equal(tagAge(at(60 * 60 * 1000 - 1000), tag), 'ok')
  assert.equal(tagAge(at(60 * 60 * 1000), tag), 'too-old')
  assert.equal(tagAge(at(60 * 60 * 1000 + 1000), tag), 'too-old')
  assert.equal(tagAge(at(-5 * 60 * 1000 + 1000), tag), 'ok')
  assert.equal(tagAge(at(-5 * 60 * 1000), tag), 'ok')
  assert.equal(tagAge(at(-5 * 60 * 1000 - 1000), tag), 'too-new')
  assert.equal(tagAge(at(0), null), 'too-old')
})

test('npm_config_* variables are removed in any case', () => {
  const env = cleanEnv({ PATH: '/bin', npm_config_registry: 'x', NPM_CONFIG_TAG: 'y', Npm_Config_Dry_Run: 'z', NPM_TOKEN: 'keep' })
  assert.deepEqual(env, { PATH: '/bin', NPM_TOKEN: 'keep' })
})

test('repository names from URLs', () => {
  assert.equal(repoFromUrl('git@github.com:anzusystems/common-admin.git'), 'anzusystems/common-admin')
  assert.equal(repoFromUrl('https://github.com/anzusystems/common-admin'), 'anzusystems/common-admin')
  assert.equal(repoFromUrl('ssh://git@github.com/anzusystems/admin-dam.git'), 'anzusystems/admin-dam')
})
