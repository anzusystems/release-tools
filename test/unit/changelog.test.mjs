// @ts-check
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseHeader,
  hasContent,
  renderTemplate,
  setReleaseDate,
  indexLines,
  releasedEntries,
  replaceIndexBlock,
  rebuildIndex,
  absolutizeLinks,
  otherUnreleased,
  DEFAULT_TEMPLATE,
} from '../../lib/changelog.mjs'

test('header and content', () => {
  const t = renderTemplate(DEFAULT_TEMPLATE, '3.1.0')
  assert.deepEqual(parseHeader(t), { version: '3.1.0', date: null, lineIndex: 0 })
  assert.equal(hasContent(t), false)
  assert.equal(hasContent(`${t}\n- **Filters** keep the page.\n`), true)
  assert.equal(hasContent('3.1.0 — unreleased\n===\n\n### Added\n\n'), false)
  assert.equal(hasContent('3.1.0 — unreleased\n===\n\nSome text\n'), true)
  assert.deepEqual(parseHeader('2.1.0 — 2026-08-17\n===\n'), { version: '2.1.0', date: '2026-08-17', lineIndex: 0 })
  assert.equal(parseHeader('planned\n===\n'), null)
})

test('the release date is set once', () => {
  const t = '3.1.0 — unreleased\n===\n\ntext\n'
  const d = setReleaseDate(t, '3.1.0', '2026-09-25')
  assert.equal(d, '3.1.0 — 2026-09-25\n===\n\ntext\n')
  assert.equal(setReleaseDate(d, '3.1.0', '2026-10-01'), d)
  assert.throws(() => setReleaseDate(t, '3.2.0', '2026-09-25'))
})

test('index: sorted by version, only released files, block rewritten in place', () => {
  const files = [
    { name: '2.30.2.md', text: '2.30.2 — 2026-09-20\n===\n' },
    { name: '3.0.0.md', text: '3.0.0 — 2026-09-01\n===\n' },
    { name: '3.1.0.md', text: '3.1.0 — unreleased\n===\n' },
    { name: '2.31.0.md', text: '2.31.0 — 2026-08-01\n===\n' },
    { name: 'template.md', text: '{version} — unreleased\n===\n' },
  ]
  const entries = releasedEntries(files)
  assert.deepEqual(indexLines(entries, 'CHANGELOG.md', 'doc/changelog'), [
    '- [3.0.0](doc/changelog/3.0.0.md) — 2026-09-01',
    '- [2.31.0](doc/changelog/2.31.0.md) — 2026-08-01',
    '- [2.30.2](doc/changelog/2.30.2.md) — 2026-09-20',
  ])
  const existing = '# Changelog\n\nIntro text.\n\n- [2.31.0](doc/changelog/2.31.0.md) — 2026-08-01\n- [3.1.0](doc/changelog/3.1.0.md) — 2026-09-25\n\nNotes of older releases.\n'
  assert.equal(
    rebuildIndex(existing, entries, 'CHANGELOG.md', 'doc/changelog'),
    '# Changelog\n\nIntro text.\n\n- [3.0.0](doc/changelog/3.0.0.md) — 2026-09-01\n- [2.31.0](doc/changelog/2.31.0.md) — 2026-08-01\n- [2.30.2](doc/changelog/2.30.2.md) — 2026-09-20\n\nNotes of older releases.\n',
  )
})

test('index block is inserted after the first paragraph when missing', () => {
  const commonAdmin =
    '# Changelog\n\nChanges are tracked from 2.0.0 on.\n\nNotes of the releases up to 1.46.0: [link](https://x).\n'
  assert.equal(
    replaceIndexBlock(commonAdmin, ['- [2.0.0](doc/changelog/2.0.0.md) — 2026-10-01']),
    '# Changelog\n\nChanges are tracked from 2.0.0 on.\n\n- [2.0.0](doc/changelog/2.0.0.md) — 2026-10-01\n\nNotes of the releases up to 1.46.0: [link](https://x).\n',
  )
  assert.equal(replaceIndexBlock('# Changelog\n', ['- [1.0.0](doc/changelog/1.0.0.md) — 2026-10-01']), '# Changelog\n\n- [1.0.0](doc/changelog/1.0.0.md) — 2026-10-01\n')
})

test('relative links become absolute at the tag; code is left alone', () => {
  const md = [
    'See [the README](../../README.md#versioning) and [upgrade](./upgrade.md).',
    '![logo](../img/logo.png "Logo")',
    'Absolute [x](https://example.com) and [anchor](#top) and [mail](mailto:a@b.c).',
    '`[code](not/a/link.md)` stays; [y](/doc/root.md) is repository-absolute.',
    '```',
    '[in fence](a.md)',
    '```',
    '[ref]: ../other.md',
  ].join('\n')
  const out = absolutizeLinks(md, { repo: 'o/r', ref: '3.1.0', fileDir: 'doc/changelog' })
  assert.equal(
    out,
    [
      'See [the README](https://github.com/o/r/blob/3.1.0/README.md#versioning) and [upgrade](https://github.com/o/r/blob/3.1.0/doc/changelog/upgrade.md).',
      '![logo](https://github.com/o/r/raw/3.1.0/doc/img/logo.png "Logo")',
      'Absolute [x](https://example.com) and [anchor](#top) and [mail](mailto:a@b.c).',
      '`[code](not/a/link.md)` stays; [y](https://github.com/o/r/blob/3.1.0/doc/root.md) is repository-absolute.',
      '```',
      '[in fence](a.md)',
      '```',
      '[ref]: https://github.com/o/r/blob/3.1.0/doc/other.md',
    ].join('\n'),
  )
})

test('changelog files of other unreleased versions', () => {
  const files = [
    { name: '4.0.0.md', text: '4.0.0 — unreleased\n===\n' },
    { name: '3.1.0.md', text: '3.1.0 — unreleased\n===\n' },
    { name: '3.0.1.md', text: '3.0.1 — 2026-09-01\n===\n' },
    { name: '3.0.2.md', text: '3.0.2 — 2026-09-02\n===\n' },
  ]
  assert.deepEqual(otherUnreleased(files, '4.0.0', new Set(['3.0.1'])), ['3.1.0', '3.0.2'])
})
