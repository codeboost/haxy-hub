# #01 Foundation: acceptance harness, routed app shell, and API conventions

**Type:** HITL · **Status:** done · **User stories:** 1, 2, 3, 4, 9

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Establish the end-to-end path every later slice builds on. A single command (or documented pair of commands) builds or selects a Haxy backend binary, starts it against an isolated temporary data directory seeded through existing Zig setup/event utilities, starts Vite pointed at it via `HAXY_BACKEND_URL`, and runs a Playwright suite through the Vite proxy. Both server mode and local mode fixtures can be launched.

On the React side, introduce client-side routing and an application shell (header, mode indicator, content area) replacing the single connection screen. The shell shows whether the backend is in server or local mode, and distinguishes unreachable, incompatible, and connected states with a retry.

This slice also fixes the JSON API conventions all later slices follow, written down in `haxy-hub/docs/` (and enforced by a shared Zig helper plus matching TypeScript types):

- Structured error envelope: stable `code`, user-facing `message`, optional `field_errors`; codes for validation, unauthenticated, forbidden, not_found (also used for hidden resources), conflict/stale, unsupported, backend failure.
- Pagination: opaque cursor/page tokens, explicit `has_more`, exact count vs. lower bound vs. unknown.
- Identifiers: event IDs, repository identities, Git object IDs, and any large integers are opaque strings.
- Timestamps: explicit unit and encoding.
- Viewer capabilities / action availability shape, including a reason for unavailable actions.
- Per-request timeouts: the 10s status timeout does not apply to long-running operations.

**HITL:** the conventions document needs human review before slices 2+ start building on it.

## Acceptance criteria

- [x] `npm run test:e2e` (or equivalent) starts an isolated backend + Vite and runs Playwright; it never touches the developer's live data directory or an existing session
- [x] Harness can launch both a server-mode fixture and a local-mode fixture (git repo) and an alternate backend port
- [x] App shell renders with routing; refresh on any route reconstructs the same view
- [x] Mode indicator shows server vs local; unreachable and incompatible backends show recoverable error states with retry (browser-tested)
- [x] API conventions doc is written and reviewed; Zig error/pagination helpers and matching TS types exist and are used by `/api/v1/status`
- [x] Existing Zig test suites still pass; README documents the two-process startup and test workflow


## Blocked by

None - can start immediately
