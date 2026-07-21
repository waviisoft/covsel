<!--
Summary (no heading): 1–3 prose paragraphs describing the change and the new
behavior. Write it so it reads well as the squash-and-merge commit message — do
NOT reference issues, PRs, commits, or reviewers here (put those at the bottom).
-->

## Why

<!-- Optional. Why is this change needed? Link issues/PRs/commits for context. -->

## Changes

<!-- Optional. The notable changes, by file or by area, for reviewers. -->

## Checklist

- [ ] Tests added/updated
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass locally
- [ ] `pnpm format:check` passes
- [ ] Changeset added (`pnpm changeset`) if user-facing
- [ ] For adapters: conformance assertions pass
- [ ] Fail-open behavior preserved (nothing here can cause a needed test to be skipped)
- [ ] No secrets, tokens, or personal data in the diff or description

<!--
Optional (no heading): GitHub attributions at the very bottom — e.g.
"Fixes #123", "Implements #45", or credit to contributors. Keep these out of the
summary so the squash commit message stays clean.
-->
