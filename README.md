# release-tools

Release flow for anzusystems projects. Two commands release a version, a third one cleans up:

| Command | What it does |
|---|---|
| `release:start` | starts a release (patch, minor, major) or a hotfix of an older version in its own folder next to the repository, or cancels one |
| `release:publish` | publishes a prerelease (alpha, beta, rc), a dev build, or the final version, which it merges into `main` after publishing |
| `release:cleanup` | deletes dev builds and tags that never became a release |

Every release starts with a pushed version tag and is checked, built and published by GitHub Actions from exactly the tagged commit. The changelog is written by people, one file per version. Nobody creates branches, tags or GitHub Releases by hand, and the tool never pushes to `main`.

**All situations, checks and what happens in detail: [docs/guide.md](docs/guide.md).**

## Setting up a project

```sh
npx -y --allow-git=all github:anzusystems/release-tools#main init
```

`init` writes the release workflow (`.github/workflows/release.yml`, a stub that calls `anzusystems/release-tools/publish@main`), `release.config.json`, the aliases in `package.json`, the changelog template and the index `CHANGELOG.md`. It never overwrites a different file without asking; running it again only adds what is missing. The files reach `main` through a normal pull request.

What the tool needs from the repository (it changes no settings and bypasses nothing without asking):
- merge commits allowed into `main` (repository setting, rulesets and branch protection), and no merge queue;
- for npm: the environment `npmjs-publish` and a trusted publisher on npmjs.com for the release workflow. The very first version of a new npm package is not handled by the tool yet: npm allows trusted publishing only for a package that exists;
- required approvals are respected: the final waits until the release pull request may be merged, and offers a bypass only when just the approval is missing and you may bypass.

Projects that do not publish to npm (applications) use `"publish": "none"`: the release is the GitHub Release. Deploy from a job with `needs: publish` and the outputs of the publish job (see the guide).

## Running with npx

The aliases in the project's `package.json`:

```json
"scripts": {
  "release:start": "npx -y --allow-git=all github:anzusystems/release-tools#main start",
  "release:publish": "npx -y --allow-git=all github:anzusystems/release-tools#main publish",
  "release:cleanup": "npx -y --allow-git=all github:anzusystems/release-tools#main cleanup"
}
```

- The tool is not published to npm. The aliases run it from GitHub: on every run npx checks the current commit of `main`, keeps the package in `~/.npm/_npx/<hash>/` and downloads a newer commit when there is one. Nothing is installed in the project.
- `-y` answers npx's question whether to download the package.
- `--allow-git=all`: npm 12 refuses packages from git by default, and only `all` works with both npm 11 and 12.
- Use `npx` whatever package manager the project uses (`yarn release:start` runs the alias with npx): `pnpm dlx` keeps its cache for a day and `yarn dlx` needs an allow list for git repositories.
- In GitHub Actions the stub calls `anzusystems/release-tools/publish@main`, which GitHub resolves at the start of every job. The CLI and the action therefore always come from the same `main`, which holds the released state of the tool.

On your computer you need Node 22.14+, git 2.38+, `gh` logged in with the scopes `repo` and `workflow` (`gh auth refresh --scopes repo,workflow`), and a git e-mail that GitHub knows (commits with an unknown e-mail may need an extra approval).

## What it covers

Releases of the latest line (patch, minor, major), prereleases from a release branch or any branch, dev builds of any branch (GitHub only, never npm), hotfixes of older lines from their last tag, a tested prerelease before a stable version (`requireTestedPrerelease`), npm, pnpm and yarn 4+, projects with and without npm. Every command can be run again after a failure and continues where it stopped; nothing changes before all checks pass.

## Development

```sh
npm ci --ignore-scripts
npm test              # tsc, unit and integration tests (real git, fake GitHub and registry)
npm run test:e2e      # real GitHub, a sandbox repository, locally only (see test/e2e/README.md)
```

Plain JavaScript (ESM) with JSDoc types, no runtime dependencies. `package.json` has no install or build scripts: npx would run `npm install` for a git package on every new commit. The CLI loads all its modules at start, because another run may replace the package in the npx cache while a command waits.

The tool releases itself with its own commands as a `"publish": "none"` project (`"build": false`). A new release applies to every project at once, so all tests including e2e run before it. After 1.0.0 release it through its aliases (`github:…#main`), not from the release folder.

## License

[Apache-2.0](LICENSE)
