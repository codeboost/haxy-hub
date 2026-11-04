# #10 Create a repository or copy an existing one

**Type:** AFK · **Status:** done · **User stories:** 25, 26

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Registered users create a repository with name, description, visibility and supported hash format, or create one by copying an accessible existing repository using Haxy's existing copy option. On success they land on the new repository.

## Acceptance criteria

- [x] Creating a repo with each supported hash format succeeds and is browseable after refresh and restart
- [x] Name/validation errors appear by field with input preserved
- [x] Copying an accessible repo produces a repo with its content; copying an inaccessible one is rejected
- [x] Anonymous users and local mode cannot create repos (UI and API)
- [x] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [x] Existing Zig suites pass; frontend typecheck and build pass
- [x] Compatible `haxy-hub-impl` backend commit recorded (`28868f8` on `issue-10-repo-create`)

## Blocked by

- [#03 Session: login, logout, persistent session, and CSRF protection for writes](03-session-login-logout-csrf.md)
- [#05 Repository overview and file browsing at the default branch](05-repo-overview-and-file-browsing.md)

## Implementation notes

Haxy: `POST /api/v1/repos` in `src/api/repo_create.zig`, routed in `routeApiRequest`
after the CSRF guard (contract in [API conventions](../api-conventions.md), Repository
creation). Unit tests: `src/test/api_repo_create.zig`.

Shared operations, extracted into `src/ui/NewRepo.zig` and now used by the TUI's new-repo
tab, the web form (`POST …/repo/new` in `web.zig`) and the API:

- `NewRepo.Fields` — what the form asks for (also the type of the TUI's saved form
  feedback), with the TUI's defaults (private, sha1);
- `NewRepo.create` — creates through `evt.createRepo` (name rules, taken names, the copy
  source resolved with the viewer's role so a hidden repository is refused like a missing
  one) and maps its errors with `RepoFailure.fromError`;
- `NewRepo.parseAccess` / `parseHash` and `access_names` / `hash_names` — the choices,
  derived from `evt.Repo.Access` and `xit.hash.HashKind`, which the TUI's radios also
  list.

Creation is atomic per name: `evt.createRepo` still checks the name first (to fail fast
before a slow copy), then makes the directory, then registers it with
`evt.registerNewRepo`, which checks the name again inside the user repo's write
transaction that records the repo event (`evt.consumeGuarded`, a `consume` that runs a
guard against the state it builds on, under the same exclusive lock). If the name was
taken meanwhile, the transaction is abandoned, the new directory is deleted and the
creation fails with `NameTaken`, so two overlapping creations of one name (a retry while
a slow copy runs, two clients, the TUI and the web at once) never both land. Zig test:
"two creations of one repo name never both register…" in `src/test/event.zig`. Not
changed here: `evt.createUser` and the create branch of `evt.resolveOrCreateRepo` (only
reached from tests) have the same check-then-write shape.

The API adds only request-shape checks the TUI's radios make impossible: `access` and
`hash` must name a choice, a copy names no `hash` (it keeps its source's), and `copy` is
`owner:name` (`evt.parseOwnerRepoPath`).

Haxy Hub: `src/lib/repoCreate.ts`, `src/pages/NewRepoPage.tsx` at `/repos/new` (a
`?copy=owner:name` query pre-fills the copy source), and a "New repository" link in the
header for signed-in viewers in server mode. The form reuses `form.tsx`'s `TextField`,
`failureOf` and `FailureMessage`, keeps every field after a refusal (none is secret), and
sends `X-Haxy-Viewer` through `asViewer` (now exported from `src/lib/account.ts`). An
unknown outcome is never reported as success or failure. The name is the operation's
identity (a second creation with it is refused as taken), so the form reads
`/api/v1/repos/<viewer>/<name>` and says only what exists now: if the repository exists,
"it may or may not be from this attempt", with a link instead of the button (it may have
existed already); if it isn't found, a copy may still be finishing, so it offers "Check
again" and a retry, and a retry of the same name refused as taken is shown as "it exists
now", not as a field error; if Haxy can't say, the button stays disabled until "Check
again" gets an answer. Success navigates with `repoRoute`. Anonymous visitors get a
log-in link that returns to the same URL (keeping `?copy=`); local mode says it can't
create repositories. The uncertain-outcome notice belongs to the owner and name it was
about: editing the name sets it aside (and brings the button back, keeping the other
fields); editing it back restores it. A request still running when the form unmounts
(the user moved on or logged out) finishes without navigating or touching the page. Every attempt and
every existence check starts a new generation, and an answer applies only while its
generation is the latest, so a late check of an earlier name (or an earlier check of the
same one) never overrides what is known about a newer attempt.

Proxy timeout: Vite's 10s `proxyTimeout` no longer covers `/api/v1/repos`, which has no
proxy (or client) timeout, like every write (`vite.config.ts`). Copies stream the source's
database file, so they are fast — 55 MB (Haxy's own 796-commit history pushed over SSH)
copied in 30–50 ms locally — but scale with repository size.

Tests: `e2e/repo-create-api.spec.ts` (each hash format, verified after a restart by
cloning over HTTP and reading `git rev-parse --show-object-format`; refusals per field;
copying visible, hidden and missing repositories; forged viewers; anonymous, wrong
method and local mode; the proxy waiting past 10s) and `e2e/repo-create.spec.ts` (the
browser flows, each browsed after a refresh and a backend restart, plus lost answers and a
viewer switched in another tab).

Decisions:

- `hash` sent with a copy is refused rather than silently ignored (the TUI ignores its
  hash radio for copies). Haxy Hub disables the hash choice while a copy source is
  filled in.
- A malformed copy source is `validation`; a well-formed one the viewer can't read (or
  that doesn't exist) is `not_found`, keyed by `copy`, with one message for both.
- The response is the new repository's identity, not its overview; Hub navigates to the
  overview, which reads the authoritative state.
- A copy shortcut on the repository page is left out to stay clear of #06's edits there;
  `/repos/new?copy=owner:name` is ready for one.
- A viewer switched in another tab is reported with #04's `ViewerChangedError` wording,
  which speaks of a change to the original user's account. The viewer binding is in one
  place on each side, for #30 to replace: the `X-Haxy-Viewer` check in
  `repo_create.handle` and `asViewer` in `createRepo` (`src/lib/repoCreate.ts`).
