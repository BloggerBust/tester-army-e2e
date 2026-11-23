<!--
Title: Conventional Commits, `!` for a breaking change. It becomes the squash commit.
Body: the source of truth for the change. Keep it true to the latest commit: update it
with every push that changes behavior, scope, or a number. Each section is short.
See .dev/skills/writing-pr/SKILL.md. No history; run output only as `## Verified` evidence.
When CI is green and all review feedback is handled, comment `/ready` to ask for human review
(CONTRIBUTING.md#ready-for-human-review).
-->

## What

<!-- The change as a user or caller meets it, in one to three sentences. -->

-

## Why

<!-- The problem that led here, and what this does about it. -->

-

## How it works

<!-- Numbered steps a reviewer can follow through the diff, each with a file:line. One step is fine for a small fix. -->

1.

## Issue

<!-- Fixes #123. Required for fix, chore, test, perf, ci, build, and revert PRs (CONTRIBUTING.md#pull-requests). -->

## Verified

<!--
Evidence it works: the command you ran and what you saw, then what the change calls for.
- A fix: the bug and the fix in a `| main | this PR |` table.
- A speedup, or a runner, agent, or engine change: the `pnpm bench:ab` table.
- Terminal output or UI: a recording from `pnpm record:terminal`.
- On-screen behavior: the video from `e2e run --video`.
-->

Ran it locally: yes | no - <why>

-

## Checklist

- [ ] Changeset added (`pnpm changeset`) for any change to a published package, or the change is testbed, docs, or CI only.
- [ ] Breaking change: title carries `!`, the changeset body names what breaks and what replaces it, and the deprecation warning landed a window earlier (stability policy in CONTRIBUTING.md).
- [ ] Docs updated in the same PR: the `docs/**/*.mdx` page for the behavior, and `skills/e2e/` if the skill describes it.
- [ ] Contract change: emitted `.d.ts` reviewed, `tests/types/sdk-types.ts` updated; wire change edits the schema and both fixtures.
- [ ] Engine contract change (`e2e/engine`): changesets for `e2e`, `@e2e-dev/web`, and `@e2e-dev/mobile`.
