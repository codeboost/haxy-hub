# #30 Writes never land under a different signed-in user

**Type:** AFK · **Status:** done · **User stories:** 99, 100 (security hardening)

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

- [x] Logging in, logging out, signing up or deleting an account through Haxy's HTML pages rotates `haxy_csrf`; a token from before is refused with `csrf`
- [x] A Haxy Hub write started for user A, after another tab signs in as B through either Haxy's HTML login or Haxy Hub, changes nothing for B and tells the user who is signed in now
- [x] The rotation helper is shared by the HTML and API session paths, with Zig unit tests
- [x] Two-tab e2e tests cover both the HTML and the Hub login paths, for at least one non-account write route once one exists
- [x] Existing Zig suites pass; frontend typecheck, build and e2e pass; compatible `haxy-hub-impl` commit recorded (`bc5b1c2` on `issue-30-write-identity`)

## Implementation notes

The contract is in [api-conventions.md](../api-conventions.md), under Security notes →
Session-bound writes. In short:

- **Rotation.** `CsrfNonce.rotate` in `haxy/src/api/session.zig` returns a fresh nonce,
  its token and the `Set-Cookie` that stores it. It is the only way a nonce is minted
  (including the first one `GET /api/v1/session` issues). It is called by:
  - the API's `respondLoggedIn` (login, registration) and `respondLoggedOut` (logout,
    account deletion);
  - in `haxy/src/web.zig`, the HTML `handleLogin`, `handleLogout`, `handleUserNew`
    (sign-up's login) and `handleDelete` (the user target), and the page render that
    claims the `try` demo's auto-login.

  These are every place that sets or clears `haxy_session`. HTML responses set the new
  nonce cookie instead of clearing it (the reasons are in the conventions). Unit tests:
  `haxy/src/test/api_session.zig`.
- **Viewer check.** `checkViewer` and `viewer_header` moved from `api/account.zig` to
  `api/session.zig`. `guardWrite(io, request, allocator, host)` runs it after the CSRF
  check, so it covers every `/api/` write; account.zig's own `guardViewer` was removed. It
  reads the session's active user only when the header is sent. A header naming someone
  while nobody is signed in is `unauthenticated`; naming someone else is `conflict`.
- **Client.** `requestJson` takes a `viewer` option (a name, `null`, or `anyViewer`). It
  defaults to the viewer `SessionProvider` shows (`bindWritesTo`). Its token cache records
  the viewer each token was read for, and a bound write never sends a token recorded for
  anyone else (a mismatch is confirmed by one fresh read), so even a write for nobody can't
  run under a token from another tab's login (review finding). It re-reads the session
  before a CSRF replay and maps viewer refusals to `ViewerChangedError`, which moved from
  `src/lib/account.ts` to `src/lib/api.ts`. account.ts lost `asViewer`/`viewerHeader` and
  passes `viewer`. Login, logout and registration pass `anyViewer`. `SessionProvider`
  doesn't re-read the session after a `ViewerChangedError`, so a stale deletion form keeps
  its message and Reload button.
- **Tests.** `haxy-hub/e2e/write-identity.spec.ts`:
  - raw HTTP: a token from before an HTML login, logout, sign-up or account deletion is
    refused with `csrf`; the guard's viewer check on any route; anonymous plus a header;
    registration without the header;
  - two-tab browser tests: switching users through Haxy's own server-rendered login form
    and through Haxy Hub. The stale tab's password, email, key and deletion writes are
    refused without a replay, and the page says who is signed in now;
  - the app's own `requestJson`, imported in the page: once a refusal has refreshed the
    token, a write for nobody or for the old user is still refused before it is sent.

  #04's two-tab test in `account.spec.ts` still covers email and key changes.
- **Non-account write routes.** None existed yet, so the account routes stand in, as the
  issue allows. The guard test also posts to an unknown `/api/` path, showing that the check
  runs before routing for any write route. #10's repo create gets it without opting in.
- **Not changed.** Haxy's HTML login doesn't revoke the browser's previous session file,
  as the API's login does. Its old cookie is replaced in the browser, and the stale nonce is
  rotated, so it can't be used to write; the old session file just lingers until logout.
  This is left for a follow-up.

## Blocked by

- [#04 Account management](04-account-management.md)
