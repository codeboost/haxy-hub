# #25 Metadata conflicts: find, inspect, and resolve

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 79, 80, 81

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Collaborators find issues and patches with unresolved metadata conflicts, inspect both sides and their authors for conflicting fields and description chunks, and submit supported per-field and description resolutions recorded as events. Metadata conflicts are presented separately from code mergeability and never as a source-code conflict editor.

## Acceptance criteria

- [ ] A fixture with divergent metadata edits lists the conflicted thread
- [ ] Both sides and authors are displayed per field and description chunk
- [ ] Resolution persists through normal event processing and clears the conflict after refresh
- [ ] Patch code merge conflicts are not shown in this UI
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#18 Branch-backed patches: create, edit, close/reopen, and remove](18-patches-branch-write.md)
