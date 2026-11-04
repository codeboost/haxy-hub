# #29 Same-origin check for Haxy's HTML form routes

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 100 (security hardening)

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md) · follow-up from the [#03](03-session-login-logout-csrf.md) CSRF review

## What to build

Haxy's existing browser-rendered UI accepts state-changing form posts outside `/api/` (login, logout, registration, repo creation, settings, deletions and the other `…/new` and action routes). Today they rely only on the `haxy_session` cookie being `SameSite=Lax`, which treats other ports on the same host as same-site, so another local web app could post to them.

Apply the same Origin rule the JSON API uses (see Security notes in [api-conventions.md](../api-conventions.md)) to every non-GET/HEAD request on these routes: if an `Origin` header is present, it must name the request's own `Host`; otherwise the request is refused before the form handler runs. Reuse the API guard's origin comparison rather than duplicating it. No token is required here: the server-rendered forms (including the no-JavaScript path) must keep working unchanged when submitted from Haxy's own pages.

Backend only; Haxy Hub needs no UI change.

## Acceptance criteria

- [ ] Every state-changing HTML form route refuses a request whose `Origin` names another host or port (including `Origin: null`), with a clear error page and no side effect
- [ ] The same forms submitted from Haxy's own pages (with and without JavaScript, including the WASM renderer) still work
- [ ] Requests without an `Origin` header (non-browser clients) keep working as before
- [ ] Git smart-HTTP and the SSH/TUI paths are unaffected
- [ ] The origin comparison is shared with the `/api/` guard, with unit tests for the shared function
- [ ] HTTP contract tests through the e2e harness cover a foreign-origin login post and a same-origin one
- [ ] Existing Zig suites pass; frontend e2e suite passes; compatible `haxy-hub-impl` commit recorded

## Blocked by

- [#03 Session: login, logout, persistent session, and CSRF protection for writes](03-session-login-logout-csrf.md)
