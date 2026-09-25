// @ts-check

export const TOOL_SPEC = 'github:anzusystems/release-tools#main'
export const ACTION = 'anzusystems/release-tools/publish@main'

/**
 * The release workflow of a project. It only triggers and calls the action of the tool; the logic comes from
 * the tool's main. Tags that are not versions of the tool are ignored by the action.
 * @param {{ publish: 'npm' | 'none', environment: string, actionRef?: string, extraEnv?: Record<string, string> }} o
 */
export function stubWorkflow(o) {
  const action = o.actionRef ?? ACTION
  const env = o.extraEnv && Object.keys(o.extraEnv).length
    ? `env:\n${Object.entries(o.extraEnv)
        .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
        .join('\n')}\n`
    : ''
  const publishJob =
    o.publish === 'npm'
      ? `  publish:
    needs: build
    if: needs.build.outputs.release == 'true'
    runs-on: ubuntu-latest
    environment: ${o.environment}
    permissions: { contents: write, id-token: write }`
      : `  publish:
    needs: build
    if: needs.build.outputs.release == 'true'
    runs-on: ubuntu-latest
    permissions: { contents: write }`
  return `# Created by release-tools init: releases are made with release:start and release:publish, never by hand.
name: Release
on:
  push:
    tags: ['[0-9]*.[0-9]*.[0-9]*']
concurrency:
  group: release
  cancel-in-progress: false
  queue: max
${env}jobs:
  build:
    if: \${{ !github.event.deleted }}
    runs-on: ubuntu-latest
    permissions: { contents: read, actions: read, pull-requests: read }
    outputs:
      release: \${{ steps.build.outputs.release }}
      tag-object: \${{ steps.build.outputs.tag-object }}
      tarball-sha512: \${{ steps.build.outputs.tarball-sha512 }}
    steps:
      - id: build
        uses: ${action}
        with: { mode: build }
${publishJob}
    outputs:
      version: \${{ steps.publish.outputs.version }}
      tag: \${{ steps.publish.outputs.tag }}
      prerelease: \${{ steps.publish.outputs.prerelease }}
      latest: \${{ steps.publish.outputs.latest }}
      published: \${{ steps.publish.outputs.published }}
      released-now: \${{ steps.publish.outputs.released-now }}
    steps:
      - id: publish
        uses: ${action}
        with:
          mode: publish
          tag-object: '\${{ needs.build.outputs.tag-object }}'
          tarball-sha512: '\${{ needs.build.outputs.tarball-sha512 }}'
`
}

/** Aliases of the commands in package.json. */
export function aliases() {
  return {
    'release:start': `npx -y --allow-git=all ${TOOL_SPEC} start`,
    'release:publish': `npx -y --allow-git=all ${TOOL_SPEC} publish`,
    'release:cleanup': `npx -y --allow-git=all ${TOOL_SPEC} cleanup`,
  }
}

export const INDEX_TEMPLATE = `# Changelog

One file per release in [\`doc/changelog/\`](doc/changelog/).
`
