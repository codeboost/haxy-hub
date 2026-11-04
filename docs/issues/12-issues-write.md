# #12 Issues: create, edit, close/reopen, and remove

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 45, 46, 47, 48

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Authorized contributors create issues with title, description and labels, edit supported fields, close and reopen, and remove with confirmation. All writes go through the existing event operations so the TUI sees the same result. Respect per-kind creation thresholds, authorship rules and role checks; works with local-mode event editing.

## Acceptance criteria

- [ ] Created/edited/closed/removed issues persist across refresh and backend restart and are visible in the TUI
- [ ] Readers and anonymous users cannot write (hidden controls and rejected direct API calls)
- [ ] A writer whose role is revoked after page load gets a forbidden error, not a false success
- [ ] Removal requires confirmation; double-submit is prevented
- [ ] Local mode issue edits work without login
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#03 Session: login, logout, persistent session, and CSRF protection for writes](03-session-login-logout-csrf.md)
- [#11 Issues: lists, counts, filters, labels, and issue detail](11-issues-read.md)
