# #17 Patches: lists, detail, and revision review

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 41, 63, 70, 71

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Separate open, closed and merged patch lists with search, labels, counts and pagination. Patch detail shows source, target, current revision, commit count, no-change state, and available mergeability. Links take the reviewer to that revision's files, commits and diff, using the backend's base-bounded revision semantics so unrelated history is excluded.

## Acceptance criteria

- [ ] Open/closed/merged lists and filters match the TUI
- [ ] Patch detail fields are correct for a branch-backed fixture, including a no-change patch
- [ ] Revision commit list and diff exclude commits already on the target (base-bounded)
- [ ] Revision links are deep-linkable and survive refresh
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#08 Commit diffs with pagination and path filtering](08-commit-diffs.md)
- [#11 Issues: lists, counts, filters, labels, and issue detail](11-issues-read.md)
