# #27 Local mode: offline metadata edits and remote sync

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 84, 85, 86

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

In local mode, users browse and edit supported metadata while disconnected from a remote, then synchronize events with the configured remote through Zig using existing merge rules. Failures (transport or conflicts) are reported accurately while retaining locally applied changes; the code HEAD is preserved. Sync is a long-running operation with explicit completion/failure results.

## Acceptance criteria

- [ ] Local edits made with no remote reachable persist across restart
- [ ] Sync against a fixture remote pushes and pulls events; results visible on both sides
- [ ] Transport failure reports honestly and keeps local changes
- [ ] Sync preserves the code HEAD and surfaces resulting metadata conflicts
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#12 Issues: create, edit, close/reopen, and remove](12-issues-write.md)
- [#24 Event browsing and transaction views](24-events-browsing.md)
