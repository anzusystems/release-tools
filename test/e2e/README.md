# End-to-end tests

They run on real GitHub, locally, with your logged-in `gh` (never in CI):

```sh
RELEASE_E2E=1 RELEASE_E2E_ACTION_REF=<pushed branch of release-tools> npm run test:e2e
```

- `RELEASE_E2E_REPO` — the sandbox, default `anzusystems/release-tools-sandbox`. When it does not exist, the setup creates it as a public repository; if your token cannot, create it by hand.
- `RELEASE_E2E_ACTION_REF` — the branch of release-tools whose action the sandbox workflow uses (`anzusystems/release-tools/publish@<ref>`). It must be pushed.
- Nothing is published: `RELEASE_TOOLS_REGISTRY=mock` keeps the registry as tags `mock-npm/versions/<version>` and `mock-npm/tags/<tag>` of the sandbox, with the package as an asset of a GitHub Release.
- Before every scenario the sandbox is reset: `main` is force-pushed with the sample project, and all other branches, tags, Releases, runs and open pull requests are deleted.
- `KEEP_TEST_REPOS=1` keeps the local clones.

Status: the harness and two scenarios exist; they have not been run yet, and the full matrix of the plan is still to be written.
