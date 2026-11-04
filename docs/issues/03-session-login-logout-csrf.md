# #03 Session: login, logout, persistent session, and CSRF protection for writes

**Type:** HITL · **Status:** in-review · **User stories:** 16, 17, 18, 99

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Users log in from wherever they are and return to the same route; the session persists across navigation and refresh using Zig's existing cookie-backed session model (the proxy forwards cookies; no tokens in JS-visible storage). Logout clears the session and all viewer-specific cached client state. The shell shows the active viewer.

Choose and implement the CSRF / same-origin strategy that every state-changing `/api/v1` endpoint (including local-mode writes) will use, compatible with the Vite proxy preserving Host and Origin. Absence of CORS is not treated as protection.

**HITL:** the CSRF strategy is an architectural decision to be reviewed before write slices land.

## Acceptance criteria

- [ ] Login with valid credentials returns to the originating route; invalid credentials show an error and keep the username
- [ ] Session survives refresh and a backend restart where the existing session store persists
- [ ] Logout clears private cached data: navigating back does not show private content
- [ ] A state-changing request without the CSRF token / with a foreign Origin is rejected (HTTP contract test against the running fixture)
- [ ] An invalidated session results in unauthenticated state on the next request
- [ ] CSRF strategy documented alongside the API conventions; local mode has no login UI
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#01 Foundation: acceptance harness, routed app shell, and API conventions](01-foundation-harness-and-app-shell.md)
