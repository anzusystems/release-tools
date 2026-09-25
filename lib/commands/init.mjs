// @ts-check
import { existsSync } from 'node:fs'
import { readFile, writeFile, rename, mkdir, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { detectPackageManager } from '../pm.mjs'
import { DEFAULT_TEMPLATE } from '../changelog.mjs'
import { stubWorkflow, aliases } from '../templates.mjs'
import { CONFIG_FILE } from '../config.mjs'
import { repoFromUrl, ReleaseError } from '../util.mjs'
import * as semver from '../semver.mjs'

/**
 * @typedef {import('../context.mjs').Context} Context
 */

/**
 * release:init — writes the release workflow, release.config.json, the aliases, the changelog template and the
 * index. Checks every file first: identical files are done, different files are conflicts to confirm.
 * @param {Context} ctx
 */
export async function init(ctx) {
  const root = ctx.mainDir
  const pkgPath = join(root, 'package.json')
  if (!existsSync(pkgPath)) throw new ReleaseError('package.json is missing')
  const pkgText = await readFile(pkgPath, 'utf8')
  const pkg = JSON.parse(pkgText)
  const repo = ctx.gh.repo
  const pm = detectPackageManager(pkg, (p) => existsSync(join(root, p)))
  const existingConfig = existsSync(join(root, CONFIG_FILE)) ? JSON.parse(await readFile(join(root, CONFIG_FILE), 'utf8')) : null
  const o = ctx.options

  const publish = o.publish ?? existingConfig?.publish ?? (await ctx.ui.select('Does the project publish to npm?', [
    { label: 'yes, npm', value: 'npm', hint: pkg.private ? 'package.json is private' : undefined },
    { label: 'no, GitHub Releases only (an application)', value: 'none' },
  ], { default: pkg.private ? 1 : 0 }))
  if (publish === 'npm') {
    const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
    const r = url ? repoFromUrl(url.replace(/^git\+/, '')) : null
    if (!r || r.toLowerCase() !== repo?.toLowerCase()) {
      ctx.ui.warn(`package.json needs repository.url of ${repo} for npm provenance; the tool adds it`)
    }
  }
  const workflows = existsSync(join(root, '.github/workflows')) ? await readdir(join(root, '.github/workflows')) : []
  const defaultWorkflow = existingConfig?.releaseWorkflow ?? (workflows.includes('release-package.yml') ? 'release-package.yml' : 'release.yml')
  const releaseWorkflow = o.workflow ?? (await ctx.ui.input('File name of the release workflow in .github/workflows', { default: defaultWorkflow }))
  const checks = o.checks ?? existingConfig?.ci?.checks ?? (await askChecks(ctx, pm.name))
  const node = o.node ?? existingConfig?.node ?? (existsSync(join(root, '.nvmrc')) || pkg.engines?.node ? null : await ctx.ui.input('Node version for the build', { default: '24' }))
  const changelogDir = existingConfig?.changelogDir ?? 'doc/changelog'
  const changelogTemplate = existingConfig?.changelogTemplate ?? `${changelogDir}/template.md`
  const changelogIndex = existingConfig?.changelogIndex ?? (o.index === false ? null : 'CHANGELOG.md')
  const environment = existingConfig?.npmEnvironment ?? 'npmjs-publish'

  /** @type {Record<string, any>} */
  const config = { ...(existingConfig ?? {}), version: 1, repo }
  config.publish = publish
  config.releaseWorkflow = releaseWorkflow
  if (changelogIndex) config.changelogIndex = changelogIndex
  if (node) config.node = String(node)
  if (o.build === false) config.build = false
  config.ci = { ...(existingConfig?.ci ?? {}), checks }
  const configText = `${JSON.stringify(config, null, 2)}\n`

  const nextPkg = structuredClone(pkg)
  nextPkg.scripts = { ...(pkg.scripts ?? {}), ...aliases() }
  if (!semver.valid(nextPkg.version ?? '')) nextPkg.version = '1.0.0'
  if (publish === 'npm' && repo) {
    const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
    const r = url ? repoFromUrl(url.replace(/^git\+/, '')) : null
    if (!r || r.toLowerCase() !== repo.toLowerCase()) nextPkg.repository = { type: 'git', url: `git+https://github.com/${repo}.git` }
  }
  const indentMatch = /^([ \t]+)"/m.exec(pkgText)
  const nextPkgText = `${JSON.stringify(nextPkg, null, indentMatch ? indentMatch[1] : 2)}\n`

  /** @type {{ path: string, content: string, onlyIfMissing?: boolean }[]} */
  const files = [
    { path: `.github/workflows/${releaseWorkflow}`, content: stubWorkflow({ publish, environment }) },
    { path: CONFIG_FILE, content: configText },
    { path: 'package.json', content: nextPkgText },
    { path: changelogTemplate, content: DEFAULT_TEMPLATE, onlyIfMissing: true },
  ]
  if (changelogIndex) files.push({ path: changelogIndex, content: `# Changelog\n\nOne file per release in [\`${changelogDir}/\`](${changelogDir}/).\n`, onlyIfMissing: true })

  // Check everything first.
  const plan = []
  for (const f of files) {
    const full = join(root, f.path)
    const current = existsSync(full) ? await readFile(full, 'utf8') : null
    if (current === f.content || (current !== null && f.onlyIfMissing)) {
      plan.push({ ...f, action: 'done' })
      continue
    }
    if (current === null) {
      plan.push({ ...f, action: 'write' })
      continue
    }
    plan.push({ ...f, action: 'conflict', current })
  }
  const changedAliases = Object.entries(aliases()).filter(([k, v]) => pkg.scripts?.[k] !== undefined && pkg.scripts[k] !== v)
  for (const p of plan.filter((x) => x.action === 'conflict')) {
    let ok
    if (p.path === 'package.json' && !changedAliases.length) ok = true
    else if (p.path === 'package.json') ok = await ctx.ui.confirm(`package.json has other ${changedAliases.map(([k]) => k).join(', ')}. Replace them?`, { default: false })
    else ok = await ctx.ui.confirm(`${p.path} exists with a different content. Replace it?`, { default: false })
    p.action = ok ? 'write' : 'skip'
  }
  for (const p of plan) {
    if (p.action !== 'write') continue
    const full = join(root, p.path)
    ctx.git.mutate(`write ${p.path}`)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(`${full}.release-tools-tmp`, p.content)
    await rename(`${full}.release-tools-tmp`, full)
    ctx.checkpoint(`init:${p.path}`)
    ctx.ui.step(`wrote ${p.path}`)
  }
  const merge = await ctx.gh.mergeRequirements().catch(() => ({ problems: [] }))
  ctx.ui.info(
    [
      '',
      'Next steps (by hand):',
      '- bring these files into main with a normal pull request;',
      ...merge.problems.map((p) => `- fix the repository settings: ${p};`),
      publish === 'npm'
        ? `- create the environment ${environment} and a trusted publisher on npmjs.com (repository ${repo}, workflow ${releaseWorkflow}, environment ${environment});`
        : '- deploy from the release workflow with a job that needs: publish (see the guide);',
      publish === 'npm' ? '- the very first version of a new npm package is not handled by the tool yet (see the guide).' : '',
    ]
      .filter(Boolean)
      .join('\n'),
  )
  return plan.map((p) => ({ path: p.path, action: p.action }))
}

/**
 * @param {Context} ctx
 * @param {string} pmName
 */
async function askChecks(ctx, pmName) {
  const answer = await ctx.ui.input('Commands CI runs before publishing, separated by ";" (ci.checks)', { default: `${pmName} test` })
  const list = answer.split(';').map((s) => s.trim()).filter(Boolean)
  if (!list.length) throw new ReleaseError('ci.checks needs at least one command')
  return list
}
