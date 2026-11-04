# #15 Assigning and unassigning people

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 60, 61, 62

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Show assignees by account name when resolved, otherwise by email (both modes). Authorized contributors assign and unassign using existing identity-resolution rules. Assignee links open the issue list filtered by that assignee.

## Acceptance criteria

- [ ] Assign/unassign persists and is visible in the TUI
- [ ] Unresolved identities display by email; local mode works
- [ ] Assignee link lands on the filtered issue list
- [ ] Unauthorized users cannot assign via direct API
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#12 Issues: create, edit, close/reopen, and remove](12-issues-write.md)
