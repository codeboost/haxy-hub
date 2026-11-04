# #19 Merge and squash-merge patches

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 74, 75, 76

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Authorized maintainers merge an eligible patch using its source revision, or squash-merge it. The backend rechecks revision and target state at execution time; stale revisions, conflicts, and changed eligibility are reported without a false success. Merge is a long-running operation distinguishable from connectivity failure and never auto-retried. Server mode only.

## Acceptance criteria

- [ ] Merge and squash-merge update the target branch and patch status, visible after refresh and in the TUI
- [ ] A target branch that moved after page load produces a stale/conflict error and no success state
- [ ] Non-maintainers cannot merge via direct API
- [ ] Local mode shows merge as unavailable
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#18 Branch-backed patches: create, edit, close/reopen, and remove](18-patches-branch-write.md)
