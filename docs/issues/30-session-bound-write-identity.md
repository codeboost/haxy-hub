# #30 Writes never land under a different signed-in user

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 99, 100 (security hardening)

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md) · follow-up from the [#04](04-account-management.md) review

## Background

The CSRF token is `HMAC(nonce)`, where the nonce is the browser's `haxy_csrf` cookie (see Security notes in [api-conventions.md](../api-conventions.md)). The JSON API rotates that nonce on login and logout, and so do #04's register and delete. Haxy's own HTML routes don't: `/login`, `/logout`, sign-up's automatic login, account deletion, and any other route that starts or ends a session.

So if one tab signs in through Haxy's own pages while a Haxy Hub tab has a form open for another user, that form's next write passes the CSRF guard and runs under the new session. Separately, `requestJson` answers a `csrf` refusal by fetching a fresh token and replaying the write once. That replay also runs as whoever is signed in by then.

#04 closed this for account routes only, with the optional `X-Haxy-Viewer` header. Every later write slice (#10, #12 onwards) would hit the same problem.

## What to build

- **Backend:** every route that starts, replaces or ends a session (HTML or API) rotates the `haxy_csrf` nonce, so a token issued under the previous session stops passing. Put this in one shared helper that both the HTML and API session paths call.
- **Client:** generalise #04's viewer check into `requestJson`:
  - A write records the viewer it was issued for.
  - Before replaying after a `csrf` refusal, the client re-reads the session. If the viewer has changed, it doesn't replay; it reports a viewer-changed error, which pages show with a reload prompt.
  - Decide whether every write route should accept the optional `X-Haxy-Viewer` header, as account routes do. Recommended: yes, checked once in the shared guard.

## Acceptance criteria

- [ ] Logging in, logging out, signing up or deleting an account through Haxy's HTML pages rotates `haxy_csrf`; a token from before is refused with `csrf`
- [ ] A Haxy Hub write started for user A, after another tab signs in as B through either Haxy's HTML login or Haxy Hub, changes nothing for B and tells the user who is signed in now
- [ ] The rotation helper is shared by the HTML and API session paths, with Zig unit tests
- [ ] Two-tab e2e tests cover both the HTML and the Hub login paths, for at least one non-account write route once one exists
- [ ] Existing Zig suites pass; frontend typecheck, build and e2e pass; compatible `haxy-hub-impl` commit recorded

## Blocked by

- [#04 Account management](04-account-management.md)
