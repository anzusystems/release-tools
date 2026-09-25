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

Status: 12 scenarios (`main.test.mjs`, `flows.test.mjs`) pass on real GitHub as a whole (anzusystems/release-tools-sandbox, 25 September 2026, 49 minutes): the main path of every command and the behaviors of GitHub the fake of the integration tests assumes. The other variants of the plan's matrix are covered by the integration tests.

What the e2e showed about GitHub (the fake follows it):
- an empty repository answers 409 where it answers 404 otherwise;
- pull requests cannot be deleted, so a sandbox keeps the merged ones of earlier scenarios;
- after main is rewritten, the workflow is reported `deleted` until the next push;
- deleting a tag starts no run;
- the Release of a deleted tag becomes a draft;
- "Re-run failed jobs" gets the artifact of the first attempt.
