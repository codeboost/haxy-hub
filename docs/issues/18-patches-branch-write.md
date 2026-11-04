# #18 Branch-backed patches: create, edit, close/reopen, and remove

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 64, 72, 73

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Authorized contributors create a patch from an existing source branch to a target branch, edit its metadata, close/reopen it, and remove it with its existing removal semantics. Available in both server and local mode.

## Acceptance criteria

- [ ] Creating a patch from two branches persists and appears in the TUI
- [ ] Edit, close/reopen and remove persist with correct confirmation
- [ ] Unauthorized users are rejected at the API
- [ ] Local mode can create and edit branch-backed patches
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#12 Issues: create, edit, close/reopen, and remove](12-issues-write.md)
- [#17 Patches: lists, detail, and revision review](17-patches-read.md)
