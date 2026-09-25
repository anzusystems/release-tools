// @ts-check
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync, lstatSync, readlinkSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { run } from './exec.mjs'
import { ReleaseError } from './util.mjs'

/**
 * @param {Buffer} buf
 * @returns {Buffer[]}
 */
function splitNul(buf) {
  const out = []
  let start = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      out.push(buf.subarray(start, i))
      start = i + 1
    }
  }
  if (start < buf.length) out.push(buf.subarray(start))
  return out
}

export const TAGS_NS = 'refs/release-tools/tags/'
export const MOVING_NS = 'refs/release-tools/moving/'

/**
 * @typedef {object} Guard
 * @property {(action: string) => void} mutate called before every change; throws in --dry-run
 */

/**
 * Git in one working directory. The tool never reads or writes local tags (`refs/tags/*`): tags from GitHub are
 * fetched into refs/release-tools/tags/*, tag objects are created with `git mktag` and pushed as `<sha>:refs/tags/X`.
 */
export class Git {
  /**
   * @param {string} dir
   * @param {{ guard?: Guard, env?: Record<string, string> }} [options]
   */
  constructor(dir, options = {}) {
    this.dir = dir
    this.guard = options.guard ?? { mutate() {} }
    this.env = options.env ?? {}
  }

  /** @param {string} dir */
  at(dir) {
    return new Git(dir, { guard: this.guard, env: this.env })
  }

  /**
   * @param {string[]} args
   * @param {import('./exec.mjs').RunOptions} [options]
   */
  raw(args, options = {}) {
    return run('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: this.dir,
      ...options,
      extraEnv: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...this.env, ...(options.extraEnv ?? {}) },
    })
  }

  /** @param {string[]} args */
  async out(args) {
    return (await this.raw(args)).stdout.replace(/\n$/, '')
  }

  /** @param {string[]} args */
  async ok(args) {
    return (await this.raw(args, { allowFail: true })).code === 0
  }

  /** @param {string} action */
  mutate(action) {
    this.guard.mutate(action)
  }

  async version() {
    const v = await this.out(['version'])
    const m = /(\d+)\.(\d+)/.exec(v)
    return m ? [Number(m[1]), Number(m[2])] : [0, 0]
  }

  async toplevel() {
    return this.out(['rev-parse', '--show-toplevel'])
  }

  /** @returns {Promise<{ path: string, head: string | null, branch: string | null, bare: boolean }[]>} */
  async worktrees() {
    // -z: paths with a newline are not quoted
    const text = (await this.raw(['worktree', 'list', '--porcelain', '-z'])).stdout
    const list = []
    /** @type {any} */
    let cur = null
    for (const line of text.split('\0')) {
      if (line.startsWith('worktree ')) {
        cur = { path: line.slice(9), head: null, branch: null, bare: false }
        list.push(cur)
      } else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5)
      else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
      else if (cur && line === 'bare') cur.bare = true
    }
    return list
  }

  async mainWorktree() {
    return (await this.worktrees())[0].path
  }

  async remoteUrl(name = 'origin') {
    const r = await this.raw(['remote', 'get-url', name], { allowFail: true })
    return r.code === 0 ? r.stdout.trim() : null
  }

  /**
   * @param {string} ref
   * @returns {Promise<string | null>} commit sha
   */
  async commitOf(ref) {
    const r = await this.raw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true })
    return r.code === 0 ? r.stdout.trim() : null
  }

  /**
   * @param {string} ref
   * @returns {Promise<string | null>} object sha without peeling
   */
  async objectOf(ref) {
    const r = await this.raw(['rev-parse', '--verify', '--quiet', ref], { allowFail: true })
    return r.code === 0 ? r.stdout.trim() : null
  }

  /** @param {string} sha */
  async objectType(sha) {
    const r = await this.raw(['cat-file', '-t', sha], { allowFail: true })
    return r.code === 0 ? r.stdout.trim() : null
  }

  /** @param {string} sha */
  async hasObject(sha) {
    return this.ok(['cat-file', '-e', sha])
  }

  /**
   * @param {string} ancestor
   * @param {string} descendant
   */
  async isAncestor(ancestor, descendant) {
    const r = await this.raw(['merge-base', '--is-ancestor', ancestor, descendant], { allowFail: true })
    if (r.code > 1) throw new Error(`git merge-base failed: ${r.stderr}`)
    return r.code === 0
  }

  /**
   * @param {string} ref
   * @param {string} path
   * @returns {Promise<string | null>}
   */
  async show(ref, path) {
    const r = await this.raw(['show', `${ref}:${path}`], { allowFail: true })
    return r.code === 0 ? r.stdout : null
  }

  /**
   * @param {string} ref
   * @param {string} path
   */
  async exists(ref, path) {
    return this.ok(['cat-file', '-e', `${ref}:${path}`])
  }

  /**
   * Files directly in a directory of a commit.
   * @param {string} ref
   * @param {string} dir
   * @returns {Promise<string[]>}
   */
  async lsDir(ref, dir) {
    const r = await this.raw(['ls-tree', '--name-only', `${ref}:${dir}`], { allowFail: true })
    return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : []
  }

  /**
   * @param {string} sha
   * @returns {Promise<{ sha: string, tree: string, parents: string[], message: string, subject: string }>}
   */
  async commitInfo(sha) {
    const text = await this.out(['log', '-1', '--format=%H%n%T%n%P%n%B', sha])
    const [h, tree, parents, ...msg] = text.split('\n')
    const message = msg.join('\n')
    return { sha: h, tree, parents: parents ? parents.split(' ') : [], message, subject: msg[0] ?? '' }
  }

  /**
   * @param {string} range
   * @returns {Promise<{ sha: string, subject: string, parents: string[] }[]>}
   */
  async log(range, extra = []) {
    const text = await this.out(['log', '--format=%H%x00%P%x00%s', ...extra, range, '--'])
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha, parents, subject] = l.split('\0')
        return { sha, subject, parents: parents ? parents.split(' ') : [] }
      })
  }

  /** @param {string} range */
  async count(range) {
    return Number(await this.out(['rev-list', '--count', range]))
  }

  /**
   * @returns {Promise<{ tracked: string[], untracked: string[], unmerged: string[] }>}
   */
  async status() {
    const text = (await this.raw(['status', '--porcelain=v2', '-z', '--untracked-files=all'])).stdout
    const tracked = []
    const untracked = []
    const unmerged = []
    const parts = text.split('\0')
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]
      if (!p) continue
      if (p.startsWith('1 ')) tracked.push(p.split(' ').slice(8).join(' '))
      else if (p.startsWith('2 ')) {
        tracked.push(p.split(' ').slice(9).join(' '))
        i++
      } else if (p.startsWith('u ')) unmerged.push(p.split(' ').slice(10).join(' '))
      else if (p.startsWith('? ')) untracked.push(p.slice(2))
    }
    return { tracked, untracked, unmerged }
  }

  async gitDir() {
    return this.out(['rev-parse', '--git-dir'])
  }

  async hasMergeHead() {
    return this.ok(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
  }

  /**
   * An exact picture of what is not committed: the status (index and conflicts) and the content hash of every
   * changed or untracked file. Two equal fingerprints mean nothing changed in between.
   */
  async fingerprint() {
    // Bytes throughout: names and link targets that are not UTF-8 must not collapse into the same text.
    const status = (await this.raw(['status', '--porcelain=v2', '-z', '--untracked-files=all'])).stdoutBuffer
    const h = createHash('sha256').update(status)
    let unverifiable = false
    /** @type {Buffer[]} */
    const paths = []
    const segments = splitNul(status)
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]
      if (!s.length) continue
      const kind = String.fromCharCode(s[0])
      // number of space-separated fields before the path (porcelain v2)
      const fields = { 1: 8, 2: 9, u: 10, '?': 1 }[kind]
      if (fields === undefined) continue
      let at = -1
      for (let n = 0; n < fields; n++) at = s.indexOf(0x20, at + 1)
      if (at < 0) continue
      paths.push(s.subarray(at + 1))
      // A submodule with changes cannot be checked by content here: such a folder is never deleted.
      if (kind !== '?' && s.subarray(s.indexOf(0x20, s.indexOf(0x20) + 1) + 1)[0] === 0x53) unverifiable = true
      if (kind === '2') i++
    }
    paths.sort(Buffer.compare)
    const root = Buffer.from(`${this.dir}/`)
    for (const p of paths) {
      const full = Buffer.concat([root, p])
      h.update(Buffer.from([0])).update(p).update(Buffer.from([0]))
      let entry
      try {
        entry = lstatSync(full)
      } catch {
        h.update('-')
        continue
      }
      // lstat, not stat: a symbolic link counts by its own target, also when that target does not exist.
      if (entry.isSymbolicLink()) h.update('L').update(readlinkSync(full, { encoding: 'buffer' }))
      else if (entry.isFile()) h.update(entry.mode & 0o111 ? 'Fx' : 'F').update(createHash('sha256').update(readFileSync(full)).digest())
      else {
        h.update('D')
        unverifiable = true
      }
    }
    return { text: h.digest('hex'), unverifiable }
  }

  /**
   * The folder that has the branch checked out or is rebasing it, if any.
   * @param {string} name
   * @returns {Promise<string | null>}
   */
  async branchInUse(name) {
    for (const w of await this.worktrees()) {
      if (w.branch === name) return w.path
      if (!existsSync(w.path)) continue
      // rebasing (head-name) or bisecting (BISECT_START holds the branch the bisect started from)
      for (const f of ['rebase-merge/head-name', 'rebase-apply/head-name', 'BISECT_START']) {
        const r = await this.at(w.path).raw(['rev-parse', '--git-path', f], { allowFail: true })
        const p = r.stdout.trim()
        const full = isAbsolute(p) ? p : join(w.path, p)
        if (r.code !== 0 || !existsSync(full)) continue
        const named = readFileSync(full, 'utf8').trim()
        if (named === `refs/heads/${name}` || named === name) return w.path
      }
    }
    return null
  }

  /**
   * A merge, rebase, cherry-pick or revert that is not finished in this working tree.
   * @returns {Promise<string | null>}
   */
  async operationInProgress() {
    const names = { MERGE_HEAD: 'a merge', CHERRY_PICK_HEAD: 'a cherry-pick', REVERT_HEAD: 'a revert', 'rebase-merge': 'a rebase', 'rebase-apply': 'a rebase or git am' }
    for (const [name, what] of Object.entries(names)) {
      const p = await this.out(['rev-parse', '--git-path', name])
      if (existsSync(isAbsolute(p) ? p : join(this.dir, p))) return what
    }
    return null
  }

  async currentBranch() {
    const r = await this.raw(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true })
    return r.code === 0 ? r.stdout.trim() : null
  }

  /**
   * @param {string} prefix e.g. refs/release-tools/tags/
   * @returns {Promise<{ ref: string, sha: string, type: string }[]>}
   */
  async refs(prefix) {
    const text = await this.out(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(objecttype)', prefix])
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [ref, sha, type] = l.split('\0')
        return { ref, sha, type }
      })
  }

  /**
   * Refs under a prefix whose commit is an ancestor of `commit`.
   * @param {string} prefix
   * @param {string} commit
   */
  async refsMerged(prefix, commit) {
    const text = await this.out(['for-each-ref', `--merged=${commit}`, '--format=%(refname)', prefix])
    return text.split('\n').filter(Boolean)
  }

  /** @param {string} key */
  async config(key) {
    const r = await this.raw(['config', '--get', key], { allowFail: true })
    return r.code === 0 ? r.stdout.trim() : null
  }

  async identity() {
    const name = (await this.config('user.name')) ?? ''
    const email = await this.config('user.email')
    if (!email) throw new ReleaseError('git has no user.email', { hint: 'git config --global user.email <the e-mail of your GitHub account>' })
    return { name, email }
  }

  /**
   * Fetches branches into refs/remotes/origin/* and tags into refs/release-tools/tags/*, never into refs/tags/*.
   * `--refmap=` keeps git from using remote.origin.fetch (which may map tags to refs/tags/*).
   * @param {{ pruneTags?: boolean }} [options] pruneTags: false while an interrupted tag move is recovered
   */
  async fetch(options = {}) {
    const pruneTags = options.pruneTags ?? true
    await this.raw(['fetch', '--quiet', '--no-tags', '--refmap=', '--no-prune', '--no-prune-tags', '--no-recurse-submodules', 'origin', '+refs/heads/*:refs/remotes/origin/*'])
    await this.raw([
      'fetch',
      '--quiet',
      '--no-tags',
      '--refmap=',
      pruneTags ? '--prune' : '--no-prune',
      '--no-prune-tags',
      '--no-recurse-submodules',
      'origin',
      `+refs/tags/*:${TAGS_NS}*`,
    ])
  }

  /**
   * @param {string[]} refspecs
   * @param {{ setUpstream?: boolean, leases?: string[], description?: string, allowFail?: boolean }} [options]
   */
  async push(refspecs, options = {}) {
    this.mutate(options.description ?? `git push origin ${refspecs.join(' ')}`)
    const args = ['push', '--quiet', '--no-follow-tags', '--no-verify', '--porcelain']
    if (options.setUpstream) args.push('--set-upstream')
    for (const l of options.leases ?? []) args.push(`--force-with-lease=${l}`)
    // Tags go to the URL, not to the remote: after a push to a named remote git updates the refs that
    // remote.origin.fetch maps the pushed refs to, and a user's `+refs/tags/*:refs/tags/*` would create local tags.
    const tags = refspecs.some((r) => /(^|:)refs\/tags\//.test(r))
    const target = tags ? ((await this.out(['remote', 'get-url', '--push', 'origin'])) || 'origin') : 'origin'
    const r = await this.raw([...args, target, ...refspecs], { allowFail: true })
    if (r.code !== 0 && !options.allowFail) {
      throw new ReleaseError(`git push ${refspecs.join(' ')} was refused:\n${(r.stderr || r.stdout).trim()}`)
    }
    return r.code === 0
  }

  /**
   * @param {string} content the whole tag object
   * @returns {Promise<string>} sha of the tag object
   */
  async mktag(content) {
    return (await this.raw(['mktag'], { input: content })).stdout.trim()
  }

  /**
   * @param {string} ref
   * @param {string} sha
   */
  async updateRef(ref, sha) {
    if (ref.startsWith('refs/tags/')) throw new Error('the tool never writes local tags')
    this.mutate(`git update-ref ${ref} ${sha}`)
    await this.raw(['update-ref', ref, sha])
  }

  /** @param {string} ref */
  async deleteRef(ref) {
    if (ref.startsWith('refs/tags/')) throw new Error('the tool never deletes local tags')
    this.mutate(`git update-ref -d ${ref}`)
    await this.raw(['update-ref', '-d', ref])
  }

  /**
   * @param {string} path
   * @param {{ branch: string, start?: string, existing?: boolean }} o
   */
  async worktreeAdd(path, o) {
    this.mutate(`git worktree add ${path} (${o.branch})`)
    if (o.existing) await this.raw(['worktree', 'add', path, o.branch])
    else await this.raw(['worktree', 'add', '--no-track', '-b', o.branch, path, /** @type {string} */ (o.start)])
  }

  /**
   * @param {string} path
   * @param {boolean} force
   */
  async worktreeRemove(path, force) {
    this.mutate(`git worktree remove ${path}`)
    await this.raw(['worktree', 'remove', ...(force ? ['--force'] : []), path])
  }

  async worktreePrune() {
    await this.raw(['worktree', 'prune'])
  }

  /** @param {string} name */
  async branchExists(name) {
    return this.ok(['show-ref', '--verify', '--quiet', `refs/heads/${name}`])
  }

  /**
   * Deletes a local branch, only while it still points to `expect` when given.
   * @param {string} name
   * @param {string | null} [expect]
   */
  async deleteBranch(name, expect = null) {
    this.mutate(`git branch -D ${name}`)
    // Never a branch that a folder has checked out or is rebasing (what `git branch -D` would refuse) …
    const inUse = await this.branchInUse(name)
    if (inUse) throw new ReleaseError(`the local branch ${name} is used by the folder ${inUse}; it stays`)
    // A symbolic branch would make update-ref delete the branch it points to.
    if ((await this.raw(['symbolic-ref', '--quiet', `refs/heads/${name}`], { allowFail: true })).code === 0) {
      throw new ReleaseError(`the local branch ${name} is a symbolic ref; it stays`)
    }
    // … and only while it still points to the expected commit: update-ref compares and deletes in one step.
    const r = expect
      ? await this.raw(['update-ref', '--no-deref', '-d', `refs/heads/${name}`, expect], { allowFail: true })
      : await this.raw(['branch', '-D', name], { allowFail: true })
    if (r.code !== 0) throw new ReleaseError(`the local branch ${name} changed meanwhile or could not be deleted; it stays`)
    // what `git branch -D` removes as well; only a missing section is fine
    const c = await this.raw(['config', '--remove-section', `branch.${name}`], { allowFail: true })
    if (c.code !== 0 && !/no such section/i.test(c.stderr)) {
      throw new ReleaseError(`the local branch ${name} is deleted, but its settings (branch.${name}) could not be removed: ${c.stderr.trim()}`)
    }
  }

  /**
   * Deletes a branch on GitHub only while it still points to `sha` (compare and delete).
   * @param {string} name
   * @param {string} sha
   * @returns {Promise<boolean>} false when the branch moved or is gone
   */
  async deleteRemoteBranch(name, sha) {
    return this.push([`:refs/heads/${name}`], { leases: [`refs/heads/${name}:${sha}`], allowFail: true, description: `delete ${name} on GitHub` })
  }

  /**
   * @param {string} ref
   * @param {string} message
   * @returns {Promise<{ clean: boolean, conflicts: string[] }>}
   */
  async merge(ref, message) {
    this.mutate(`git merge ${ref}`)
    const r = await this.raw(['merge', '--no-edit', '--no-verify', '-m', message, ref], { allowFail: true })
    if (r.code === 0) return { clean: true, conflicts: [] }
    const conflicts = (await this.out(['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean)
    if (!conflicts.length) throw new ReleaseError(`git merge ${ref} failed:\n${(r.stderr || r.stdout).trim()}`)
    return { clean: false, conflicts }
  }

  /** @param {string} ref */
  async mergeFfOnly(ref) {
    this.mutate(`git merge --ff-only ${ref}`)
    const r = await this.raw(['merge', '--ff-only', ref], { allowFail: true })
    return r.code === 0
  }

  /**
   * @param {string} path
   * @param {1 | 2 | 3} stage
   */
  async stage(path, stage) {
    const r = await this.raw(['show', `:${stage}:${path}`], { allowFail: true })
    return r.code === 0 ? r.stdout : null
  }

  /** @param {string[]} paths */
  async add(paths) {
    this.mutate(`git add ${paths.join(' ')}`)
    await this.raw(['add', '--', ...paths])
  }

  /**
   * @param {string} message
   * @param {{ allowEmpty?: boolean }} [options]
   */
  async commit(message, options = {}) {
    this.mutate(`git commit -m ${JSON.stringify(message)}`)
    await this.raw(['commit', '--quiet', '--no-verify', ...(options.allowEmpty ? ['--allow-empty'] : []), '-m', message])
    return this.out(['rev-parse', 'HEAD'])
  }

  /**
   * `git merge-tree --write-tree`.
   * @param {string} ours
   * @param {string} theirs
   * @returns {Promise<{ tree: string, clean: boolean, conflicts: { mode: string, sha: string, stage: number, path: string }[] }>}
   */
  async mergeTree(ours, theirs) {
    const r = await this.raw(['merge-tree', '--write-tree', '-z', '--no-messages', ours, theirs], { allowFail: true })
    if (r.code !== 0 && r.code !== 1) throw new Error(`git merge-tree failed: ${r.stderr}`)
    const parts = r.stdout.split('\0')
    const tree = parts[0]
    const conflicts = []
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i]
      if (!p) break
      const m = /^(\d+) ([0-9a-f]+) (\d)\t(.*)$/.exec(p)
      if (m) conflicts.push({ mode: m[1], sha: m[2], stage: Number(m[3]), path: m[4] })
    }
    return { tree, clean: r.code === 0, conflicts }
  }

  /** @param {string} sha */
  async blob(sha) {
    return (await this.raw(['cat-file', 'blob', sha])).stdout
  }

  /** @param {string} text */
  async writeBlob(text) {
    return (await this.raw(['hash-object', '-w', '--stdin'], { input: text })).stdout.trim()
  }

  /**
   * A tree equal to `tree` with some files replaced.
   * @param {string} tree
   * @param {{ path: string, blob: string, mode?: string }[]} files
   */
  async replaceInTree(tree, files) {
    const dir = await mkdtemp(join(tmpdir(), 'release-tools-index-'))
    const extraEnv = { GIT_INDEX_FILE: join(dir, 'index') }
    try {
      await this.raw(['read-tree', tree], { extraEnv })
      for (const f of files) {
        await this.raw(['update-index', '--add', '--cacheinfo', `${f.mode ?? '100644'},${f.blob},${f.path}`], { extraEnv })
      }
      return (await this.raw(['write-tree'], { extraEnv })).stdout.trim()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /** @param {string} commit */
  async treeOf(commit) {
    return this.out(['rev-parse', `${commit}^{tree}`])
  }

  /**
   * Files changed between two commits.
   * @param {string} a
   * @param {string} b
   */
  async changedFiles(a, b) {
    const text = await this.out(['diff', '--name-only', '-z', a, b])
    return text.split('\0').filter(Boolean)
  }
}
