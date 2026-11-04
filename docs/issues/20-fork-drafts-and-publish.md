# #20 Fork-backed drafts: start a fork, manage drafts, and publish

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 65, 66, 67, 69

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Authorized server contributors start a patch using a new fork, list/open/edit/remove their drafts, and publish a draft under existing preconditions. Show the fork's push, clone and fetch/merge commands. Draft privacy follows existing rules. Server mode only.

## Acceptance criteria

- [ ] Starting a fork creates a draft visible only to its owner (other users get not-found)
- [ ] Draft edit/remove persist; publishing produces a repository patch
- [ ] Publishing with unmet preconditions shows the backend reason
- [ ] Fork Git commands match server transport configuration; pushing via SSH updates the draft
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#18 Branch-backed patches: create, edit, close/reopen, and remove](18-patches-branch-write.md)
