# Haxy JSON API conventions

> **Status: Reviewed on 2026-11-04.** Decisions are listed at the end; change them only by
> updating this document.
> These rules, from issue [#01](issues/01-foundation-harness-and-app-shell.md), fix the
> shape of every later endpoint.

These conventions apply to every route under `/api/` served by Haxy (Zig) and consumed
by Haxy Hub (React) through Vite's proxy. They are implemented by:

- `haxy/src/api.zig` — `writeError`/`respondError`, `writePage`, `Count`, `writeStatus`,
  `respondJson`; unit tests in `haxy/src/test/api.zig`.
- `haxy/src/api/session.zig` — the session route, the CSRF guard with its viewer check, and
  the nonce rotation every session change shares (see Session and Security notes); unit
  tests in `haxy/src/test/api_session.zig`.
- `haxy-hub/src/lib/api.ts` — matching TypeScript types, `ApiError`, `parseErrorEnvelope`,
  `requestJson`/`getJson`, and `timeouts`.

Each feature slice still defines its own request/response schemas; these rules only fix
what they have in common.

## Namespace and versioning

- All JSON routes live under `/api/v1/`. The whole `/api/` prefix is reserved: unknown
  paths there answer with the JSON `not_found` envelope, never an HTML page.
- `GET /api/v1/status` (also `HEAD`) returns
  `{"service":"haxy","api_version":1,"mode":"server"|"local"}`. It needs no session and
  reveals nothing else. Haxy Hub treats any other answer as an *incompatible* backend.
- `api_version` changes only for breaking changes. Adding optional fields or new routes is
  not breaking; clients ignore fields they don't know.
- Responses carry `content-type: application/json; charset=utf-8` and
  `cache-control: no-store` (responses are viewer-specific).

## Errors

Every non-2xx API response has this body:

```json
{
  "error": {
    "code": "validation",
    "message": "Check the highlighted fields.",
    "field_errors": {
      "name": "Name is required."
    }
  }
}
```

- `code` is stable and machine-readable. Clients branch on `code`, not on `message` or
  the HTTP status.
- `message` is user-facing, safe to display, and never contains filesystem paths, tokens,
  hashes of secrets, or the existence of resources the viewer can't see.
- `field_errors` is present only when non-empty (normally with `validation`). It is an
  object mapping each rejected request field, named exactly as the client sent it, to one
  user-facing message; a field appears at most once. Forms show these beside the field
  and keep non-secret input.

| `code`            | HTTP | Meaning |
| ----------------- | ---- | ------- |
| `validation`      | 400  | The request is malformed or a value is invalid. |
| `unauthenticated` | 401  | A session is required (or expired) for this request. |
| `forbidden`       | 403  | The viewer is known and may see the resource, but may not do this. |
| `csrf`            | 403  | A write failed the same-origin or CSRF token check (see Security notes); it did not run. |
| `not_found`       | 404  | No such resource **or** the viewer may not know it exists (private repo, draft). |
| `conflict`        | 409  | Stale or concurrent state: revision changed, name taken, target moved. Reload, then retry deliberately. |
| `unsupported`     | 405  | The method/operation isn't available here — wrong HTTP method (sent with `Allow`), or an operation this host mode doesn't offer (e.g. undo in local mode). |
| `internal`        | 500  | Backend failure. The message is generic; details go to the server log. |

Rules:

- **Hidden means not found.** When a viewer may not learn that a resource exists, answer
  exactly as for a missing one (`not_found`, same message). Use `forbidden` only when the
  viewer can already see the resource.
- The Zig helper picks the status from the code; a route may override the status but not
  invent new codes. New codes are an API change and need review.
- Clients map unknown codes to `internal`. The TypeScript client also produces
  client-side codes when no envelope is available: `unreachable` (no answer, or the
  proxy's 502/503/504), `timeout`, and `invalid_response`.
- Any failure inside an `/api/` route that escapes it (e.g. the admin repo or session
  store can't be opened) is caught at the API boundary (`handleApiRequest`), logged with
  its details, and answered with the generic `internal` envelope, never a plain-text page.
- A response that leaves a request body unread closes the connection when the client
  sent `Expect: 100-continue`, rather than waiting for a body the client is still holding.
- Writes are never retried automatically after an ambiguous failure (`timeout`,
  `unreachable`, `internal`); the UI reloads authoritative state first.

## Pagination

Lists return:

```json
{
  "items": [ ... ],
  "page": {
    "has_more": true,
    "next_cursor": "b3BhcXVl",
    "count": { "kind": "at_least", "value": 100 }
  }
}
```

- `next_cursor` is an **opaque** string: clients pass it back unchanged (as the `cursor`
  query parameter) and never parse, build or compare it. It is `null` on the last page.
- `has_more` is explicit and always equals `next_cursor != null`.
- `count` describes the whole listing, not the page:
  - `{"kind":"exact","value":N}` — exactly N results;
  - `{"kind":"at_least","value":N}` — counting stopped at N (bounded reads); show "N+";
  - `{"kind":"unknown"}` — the backend did not count.
- Paginated routes accept two query parameters: `cursor` (a previous page's
  `next_cursor`, omitted for the first page) and an optional `page_size`. The backend
  honours `page_size` up to its own maximum for the route and otherwise uses its default;
  existing bounded reads and their limits are preserved. A non-integer or non-positive
  `page_size`, or a cursor the backend can't use, is a `validation` error.
- Order is stable for a given cursor; newest-first unless the route says otherwise.
- Other partial results (truncated file windows, binary files, missing indexes) use
  explicit fields in the route's own schema, never a silent short list.

## Identifiers and numbers

- Event IDs, repository identities, Git object IDs (SHA-1 or SHA-256 hex), ordering
  tokens and any integer that may exceed 2^53 − 1 are JSON **strings**. Clients treat
  them as opaque: compare and send back, never parse or do arithmetic.
- Small bounded integers (counts, line numbers, sizes below 2^53) are JSON numbers.
- Refs, paths and other names go in URLs percent-encoded per segment (slashes in a ref or
  path are encoded when they are part of one segment); JSON bodies carry them raw, except
  repository paths and ref names, which may not be UTF-8 (see Repository paths and Refs
  below).
- Optional fields: an absent field and `null` mean the same thing ("no value"). Required
  fields are always present. Discriminated variants use a `kind` string field.

### Repository paths

> Decided in issue #05; #06–#09 (refs, history, diffs, file finder) reuse it.

Git paths are bytes and need not be UTF-8, so JSON can't carry them raw (and a name may
contain `%`, `/`-like escapes, `?` or `#`). Therefore:

- Every repository path in a response (`path` fields) is **percent-encoded bytes**: each
  byte other than the unreserved `A–Z a–z 0–9 - . _ ~` and the `/` separator is written
  as `%XX` (uppercase hex). Example: the file `docs/café x.txt` with a Latin-1 `é` is
  `docs/caf%E9%20x.txt`; a file literally named `a%2Fb.txt` is `a%252Fb.txt`.
- Clients send such a path back **unchanged** as the `path` query parameter (it is
  already safe in a query string), and Haxy decodes it exactly once to the original
  bytes. Haxy Hub also puts it unchanged into its own URLs
  (`/repos/<owner>/<name>/files/<path>`) and reads it back from the raw pathname, never
  from a router-decoded parameter, so it round-trips through refresh and shared links.
- Paths are not for display. Responses carry a `name` (the last segment) as UTF-8 with
  ill-formed sequences replaced by U+FFFD, as the WHATWG decoder (a browser's
  `TextDecoder`) replaces them; a client may decode a path's segments the same way for
  breadcrumbs. Other names that may not be UTF-8 (a local repository's directory name)
  are likewise sent for display with U+FFFD replacement; branch and tag names follow the
  Refs rule below.

### Refs

> Decided in issue #06, consistent with Repository paths; #07–#09 (history, diffs, file
> finder) reuse it.

Branch and tag names are bytes too, and may hold `/`, spaces (in a git repository), `%`,
Unicode or bytes that aren't UTF-8. A view names *what* it is read at with a **ref id**:

- A ref id is `<kind>:<value>`: `branch:<name>`, `tag:<name>`, `commit:<object id>` (a
  full lowercase hex commit id) or `revision:<patch revision id>`. A name is
  **percent-encoded bytes** exactly as a path is (`/` stays, every byte but an unreserved
  one becomes `%XX`): the branch `feature/café x` with a Latin-1 `é` is
  `branch:feature/caf%E9%20x`; one literally named `a%2Fb` is `branch:a%252Fb`.
- Responses carry the id in `id` fields, beside a `name` for display (U+FFFD-replaced as
  for paths; null for a commit or revision). Clients send an id back **unchanged** as the
  `ref` query parameter (it is already safe in a query string), and Haxy decodes it
  exactly once. A missing `ref` means the default branch, so existing links keep working.
- Haxy Hub puts the id unchanged into its own URLs (`…?ref=<id>`) and reads it back from
  the raw query string, never from a decoded parameter, so it round-trips through
  refresh, back/forward and shared links.
- A `ref` that isn't `<kind>:<value>` with a known kind, or isn't validly encoded, is
  `validation` (field `ref`). An id naming no branch, tag, commit or revision in the
  repository — including a commit id of an object that isn't a commit, such as an
  annotated tag object (only `tag:` reads through one) — is `not_found`. An overview's
  `empty` describes the default branch only; explicit refs resolve on their own.

| Route | Answer |
| --- | --- |
| `GET …/branches`, `GET …/tags` (`…` = `/api/v1/repos/<owner>/<name>` or `/api/v1/repo`) | a page of `{"name", "id"}` in byte order of the names; `search` keeps names that start with it; `cursor`/`page_size` as for every list (default 50, the TUI's refs window; at most 100); the count is `unknown`, as the TUI doesn't count refs. The cursor is opaque. |
| `GET …/files?ref=<id>&path=…` | the files view at that ref; its `ref` is `{"kind": "branch"\|"tag"\|"commit"\|"revision", "name", "id", "commit"}`, where `commit` is the commit shown (a tag's target, a revision's source commit). Without `ref`, `id` names the default branch explicitly. |

## Timestamps

- Instants are RFC 3339 strings in UTC with a `Z` suffix and whole seconds, e.g.
  `"2026-11-04T14:03:00Z"` (Haxy stores seconds since the Unix epoch).
- Field names end in `_at` (`created_at`, `updated_at`). Durations, if any, are integer
  seconds in fields ending in `_seconds`.
- Clients format for display in the viewer's locale and time zone.

## Capabilities and action availability

Resources that offer actions include what the current viewer may do:

```json
{
  "actions": {
    "edit":  { "available": true },
    "merge": { "available": false, "reason": { "code": "conflict", "message": "The target branch moved; reload to review the new revision." } },
    "undo":  { "available": false, "reason": { "code": "unsupported", "message": "Undo is not available in local mode." } }
  }
}
```

- Reason codes: `unauthenticated`, `forbidden`, `unsupported`, `disabled` (turned off in
  repository/feature settings), `conflict`. The message is user-facing.
- Availability is a hint for presentation. The backend **always** rechecks authorization
  and preconditions when the action executes, and answers with the error envelope.
- Unavailable actions are shown disabled with the reason when the viewer should know the
  action exists, and omitted when revealing it would leak a hidden resource.

## Timeouts

- The **10-second** client timeout applies **only** to `GET /api/v1/status` (connection
  check). Vite's proxy uses the same 10s bound today (`vite.config.ts`, `proxyTimeout`).
- Ordinary reads use a 30-second client timeout (`timeouts.read`).
- Writes, uploads, merges and syncs have **no client timeout** (`timeouts.write = null`);
  their outcome comes from the backend. If an operation can outlive a request, Zig must
  expose it as an operation resource with explicit completion/failure state; Node never
  owns the work. A timeout or lost connection on a write is reported as "outcome
  unknown — reload", never as failure or success.
- The Vite proxy's 10s `proxyTimeout` is scoped per route (`vite.config.ts`; Vite uses
  the first matching entry). Every `/api/` route keeps it except those listed before the
  catch-all, which have no proxy timeout: `/api/v1/repos` (repository creation, #10),
  `/api/v1/repo/sync` (local-mode sync, #27) and a thread's attachments (uploads and
  downloads, #14; see Attachments). A slow write route lands in that list along
  with its endpoint.

## Session

From issue [#03](issues/03-session-login-logout-csrf.md). One route, `/api/v1/session`,
whose every 2xx body is:

```json
{ "viewer": { "name": "alice" }, "csrf_token": "3f1c…(64 hex)" }
```

`viewer` is `null` when nobody is logged in, and always in local mode. Nothing else about
the account (email, password hash, session token) is serialized.

| Method | Server mode | Local mode |
| --- | --- | --- |
| `GET`/`HEAD` | The viewer and this browser's CSRF token. Sets the `haxy_csrf` cookie if the browser has none. Never claims the `try` demo's one-shot auto-login. | Same, with `viewer: null`. |
| `POST` | Log in. Body `{"username": "...", "password": "..."}` as `application/json` (form encodings are refused). Sets the same `haxy_session` HttpOnly cookie as the web UI's login form, replaces any session the browser already had, and rotates the CSRF token. | `unsupported` (405, `Allow: GET, HEAD`): local mode has no accounts. |
| `DELETE` | Log out. Revokes the session on the server (as the web UI's logout does), clears the cookie and rotates the CSRF token. | `unsupported` (405). |

Login errors: empty fields are `validation` with `field_errors` for `username` and/or
`password`; a body that isn't a JSON object with string fields is `validation` without
field errors; wrong credentials (unknown user, wrong password, or a deleted account) are
`unauthenticated` (401) with the single message "Incorrect username or password.", so the
answer doesn't say which part was wrong. Credentials are checked by
`evt.User.verifyCredentials`, the same check the TUI and the login form use. Sessions are
the existing disk-backed store (`<data-dir>/sessions/`), so they survive a backend restart
and have no expiry; a session revoked or deleted on the server reads as `viewer: null` on
the next request.

The React client lets a confirmed login or logout win: a session read that overlaps one
(it may describe the state before it) neither changes the shown viewer nor records its
CSRF token. `next` after login must stay a path in the app after URL normalisation
(`/.//host` and backslash forms are rejected).

Implemented in `haxy/src/api/session.zig` (unit tests in `haxy/src/test/api_session.zig`)
and `haxy-hub/src/lib/session.ts`, `src/app/session.tsx`.

## Account

From issue [#04](issues/04-account-management.md). Routes under `/api/v1/account` act on
the **session's viewer** only; no route names another user, so one user can't reach
another's settings. Anonymous (or deleted-account) sessions get `unauthenticated` (401);
local mode answers `unsupported` (405) for every route. Bodies are JSON objects of string
fields (form encodings are refused with `validation`); a missing field reads as empty, so
the shared rules report it.

A change to an existing account may name the account it is for in the optional
`X-Haxy-Viewer` header (the user the form was loaded for), as every API write may since
issue #30; see "Session-bound writes" under Security notes. Without it the change acts on
the session's viewer, so non-browser clients needn't send it; with a name other than the
session's viewer it is `conflict` (409, no field errors) and nothing changes. The check runs
in the shared write guard, before these routes, so they have none of their own. Haxy Hub
names the viewer on every account change except registration (which changes the viewer by
design), and on a refusal tells the user who is signed in now, offering a reload.

| Route | Method | Body | Answer |
| --- | --- | --- | --- |
| `/api/v1/account` | `GET`/`HEAD` | — | `{"name","email"}` |
| `/api/v1/account` | `POST` | `{name, email, password, password_again}` | 201 with the session body (`{viewer, csrf_token}`); logs the browser in and rotates the CSRF token, like login. `forbidden` while logged in. |
| `/api/v1/account` | `DELETE` | `{confirm, password}` | the session body with `viewer: null`; revokes this session and rotates the token, like logout. Other sessions of the account read as logged out. |
| `/api/v1/account/email` | `PUT` | `{email}` | the account |
| `/api/v1/account/password` | `PUT` | `{current_password, new_password, new_password_again}` | the account |
| `/api/v1/account/keys` | `GET`/`HEAD` | — | a single page of `{fingerprint, type, comment, key}` (`comment` is null when absent; at most 50 keys, count exact) |
| `/api/v1/account/keys` | `POST` | `{key}` (one OpenSSH public key line) | 201 with the key as stored |
| `/api/v1/account/keys/<fingerprint>` | `DELETE` | — | the remaining keys; `not_found` for a key the viewer doesn't hold. The fingerprint (`SHA256:…`) is percent-encoded as one segment. |

The rules are the TUI's and the web forms' own: `evt.createUser`, `evt.updateUser`,
`evt.addUserKey`, `evt.removeUserKey` and `ui.Delete.perform` (typed name, then password).
They report one failure at a time, as `field_errors` beside the field: `validation`, or
`conflict` (409) for a taken name or email and a key already added. A password change must
name `current_password` (otherwise the shared update would change nothing), and keeps the
email stored when it is written, so it never reverts an email changed meanwhile. Deleting the
account removes everything in its user directory — every repository and fork it owns.
Implemented in `haxy/src/api/account.zig` (unit tests in `haxy/src/test/api_account.zig`)
and `haxy-hub/src/lib/account.ts`.

## Threads: issues

From issue [#11](issues/11-issues-read.md). A repository's threads of one kind (issues now;
discussions and patches reuse the same routes and shapes in #16/#17) live under the
repository's API path, `/api/v1/repos/{owner}/{name}/<kind>` on a server and
`/api/v1/repo/<kind>` in local mode. The routes below are `GET`/`HEAD`; the writes are
under "Threads: writing issues". They resolve the repository
with `ui.Repo.resolve` like the repository routes, so a repository the viewer can't read
is `not_found` with the repository message; each mode answers the other's routes with
`unsupported`. A repository whose issues are turned off (`issue_role` "nobody", so the
`issues` section is absent from its overview) answers `not_found` ("This repository doesn't
use issues."), as the TUI has no issues tab then; this isn't hidden, since the overview
already shows the repository.

| Route | Answer |
| --- | --- |
| `…/issues?status=open\|closed&search=&cursor=&page_size=` | One status's window: `{"status", "filters", "counts": {"open": Count, "closed": Count}, "items": ThreadSummary[], "page"}`. `status` defaults to `open`. |
| `…/issues/labels?search=&cursor=&page_size=` | A page of `{"name", "search"}`: every label the issues use (open or closed), sorted by name. |
| `…/issues/{id}` | One issue: a `ThreadSummary` plus `"description": MarkdownBlock[]`, the whole description parsed by Haxy's reader. `not_found` for an unknown or removed issue. |

- Every answer is read by the TUI's issues tab (`ui.Repo.Issues.init`), so the lists,
  their order (newest first), counts, windows and filters are the TUI's. A list's count is
  `exact`, or `at_least` when a search stopped counting at the TUI's cap of 1000 (the
  TUI's "(1000+)"). `counts` has both statuses, as the TUI's tabs do; `page.count` is the
  listed status's.
- The cursor is opaque. (It names the next window's first issue, as the TUI's "next"
  link does, so it is not an offset.) A cursor naming an issue the listing no longer holds
  — changed status, removed, or filtered out — is `validation` on `cursor`: start again
  from the first page. `page_size` defaults to the TUI's window of 20 and is capped at
  100; the labels list defaults to the TUI's whole listing (at most 1000, then `at_least`).
- `search` is Haxy's thread search, never parsed by the client: whitespace-separated
  words (matched against title, labels and description), `label:<name>` and
  `assignee:<account name or email>` terms. `filters` is how Haxy split it:
  `{"labels": string[], "assignees": string[], "words": string, "assignee_not_found": bool}`;
  an assignee name no account holds lists nothing and sets `assignee_not_found`.
- `ThreadSummary` is `{"id", "title", "status", "labels": FilterLink[], "author",
  "assignees", "created_at", "comment_count", "conflicted"}`. `id` is the hex event id.
  `author` is `{"kind": "user", "name"}`, `{"kind": "email", "email"}` (no account holds
  it) or `{"kind": "unknown"}`. Each assignee is `{"name", "email", "search"}`: `name`
  when an account holds the email (then `email` is null), else `email` alone.
- A `FilterLink` (`{"name", "search"}`, labels and assignees alike) carries the search
  that lists threads with it: the request's `search` with its own `label:` (or
  `assignee:`) terms replaced, as the TUI's links build it (`search_thread.withFilter`).
  An issue's own route extends no search.

- Haxy's own issue URLs in Markdown (descriptions, READMEs, the about page) open the
  matching Hub pages (`hubPathForIssuePath` in `src/lib/threads.ts`, hooked into
  `hubPathForHaxyPath`). `<repo>` is `/<owner>:<name>` on a server and empty in local mode;
  `search:`/`start:` parameter segments may come before or after the view word:

  | Haxy | Haxy Hub |
  | --- | --- |
  | `<repo>/issues`, `<repo>/issues/open[/search:<s>]` | `<hub repo>/issues[?search=<s>]` |
  | `<repo>/issues/closed[/search:<s>]` | `<hub repo>/issues/closed[?search=<s>]` |
  | `<repo>/issues/labels[/search:<s>]` | `<hub repo>/issues/labels[?search=<s>]` |
  | `<repo>/issue:<id>[/search:<s>][/start:<n>]`, `…/description` | `<hub repo>/issues/<id>` |
  | `<repo>/issue:<id>/comment:<c>[/start:<n>]` | `<hub repo>/issues/<id>/comments/<c>` (#13) |
  | `<repo>/issues/new` | `<hub repo>/issues/new` (#12) |
  | `<repo>/issue:<id>/edit` | `<hub repo>/issues/<id>/edit` (#12) |

  The other forms (`…/remove`, `…/resolve`) and `…/issues/conflicts` have no Hub page yet
  and stay as written. In local mode, `/` is the repository (`/repo`), and the
  home, about and user paths, which local Haxy doesn't have, stay as written.
- Hub always requests a thread route rather than trusting a sections list it read
  earlier; the repository overview is read again on each navigation within the
  repository, so a kind another client turned on or off shows without a reload.

Implemented in `haxy/src/api/thread.zig` (routes, repository access and shapes shared by
every thread kind) and `haxy/src/api/issues.zig`; unit tests in
`haxy/src/test/api_issues.zig`. Haxy Hub: `src/lib/threads.ts`.

## Repository creation

From issue [#10](issues/10-repo-create-and-copy.md). `POST /api/v1/repos` creates a
repository owned by the **session's viewer**, either empty or as a copy of a repository
the viewer can read. Anonymous (or deleted-account) sessions get `unauthenticated` (401);
local mode answers `unsupported` (405) and other methods `unsupported` with `Allow: POST`.
Like every `/api/` write it honours the optional `X-Haxy-Viewer` header through the shared
write guard (#30): a name other than the session's viewer is `conflict` without field
errors, and nothing is created. Haxy Hub sends it.

The body is a JSON object of strings (form encodings are refused with `validation`; a
missing field reads as empty):

| Field | Meaning |
| --- | --- |
| `name` | The new repository's name, under the TUI's rules. |
| `description` | Free text; may be empty. |
| `access` | `"public"` or `"private"` (the TUI's choices). |
| `hash` | `"sha1"` or `"sha256"` for an empty repository. Must be empty or absent for a copy, which keeps the hash format of the repository it copies. |
| `copy` | `owner:name` of the repository to copy, or empty. |

The answer is 201 with the new repository's identity, `{"owner", "name"}`; its overview is
at `/api/v1/repos/{owner}/{name}`. A copy carries the source's Git data and history but
none of its events (issues, discussions, patches) or forks, as in the TUI.

Refusals carry one field error at a time, beside the field: `validation` for an unknown
`access` or `hash`, a `hash` sent with a copy, a `copy` that isn't `owner:name`, and a
missing or invalid name; `conflict` (409) for a name the viewer already uses; `not_found`
(404, keyed by `copy`) when there is no repository by that name **that the viewer can
read** — a hidden repository and a missing one get the same answer. The rules are the
TUI's and the web form's own: all three create through `ui.NewRepo.create`
(`evt.createRepo`, `evt.Repo.validateName`, and the copy source resolved with the
viewer's role), and read the choices with `ui.NewRepo.parseAccess`/`parseHash`.

The route has no client or proxy timeout (see Timeouts); a copy of a 55 MB repository
measured about 50 ms. When the outcome is unknown (timeout, `unreachable`, `internal`, or
an unreadable answer), Haxy Hub reads `/api/v1/repos/{viewer}/{name}` before offering a
retry and reports only what exists now, never what the attempt did: an existing repository
may predate it, and a copy may still be running when the read finds nothing. The name is
the operation's identity, so a retry refused as a taken name means the repository exists.
That holds because creation is atomic per name: Haxy checks the name again in the
transaction that registers the repository and discards a creation that lost the race, so
two overlapping creations of one name never both succeed. Implemented in
`haxy/src/api/repo_create.zig` (unit tests in `haxy/src/test/api_repo_create.zig`) and
`haxy-hub/src/lib/repoCreate.ts`.

## Events and transactions

From issue [#24](issues/24-events-browsing.md). A repository's events live under its API
path (`/api/v1/repos/{owner}/{name}` on a server, `/api/v1/repo` in local mode). All are
`GET`/`HEAD`, and each mode answers the other's routes with `unsupported`.

| Route | Answer |
| --- | --- |
| `…/events?view=active\|removed&cursor=&page_size=` | One view's window: `{"view", "counts": {"active": Count, "removed": Count}, "items": Event[], "page"}`. `view` defaults to `active`. |
| `…/transactions/{id}/events?view=&cursor=&page_size=` | The events one transaction wrote, read as that transaction left them: the same shape plus `"transaction": "{id}"`. |

- Every answer is read by the TUI's events tab (`ui.Repo.Events.init`), so the two lists,
  their order (most recently updated first), exact counts, windows and detail targets are
  the TUI's. Active and removed events are separate lists, each with its own count and
  pages; `counts` has both, as the TUI's tabs do.
- **Who may see them.** The TUI shows the events tab only to viewers who may write to the
  repository (`ui.Repo.hasSection(.events, …)`; the overview's `sections` lists `events`
  then). Anyone else who can read the repository gets `not_found` ("Only people who may
  write to this repository see its events.") from every event route, checked before
  anything the request names, so a transaction id, cursor or view reveals nothing. It is
  `not_found` rather than `forbidden` because the TUI answers these pages not found, and so
  that no event route answers differently for an existing and a missing transaction. A
  repository the viewer can't read is `not_found` with the repository message, as for
  every repository route.
- **Transactions.** A transaction id is the transaction's index in the repository's
  history, sent as a decimal JSON string and treated as opaque. Haxy reads the events from
  that transaction's own state, so later changes and undos don't change what it lists.
  `not_found` ("There is no transaction with this id whose events can be shown.") for an id
  that isn't canonical decimal, names no transaction, or lies below the history's undo floor
  (the history a copied repository carries from its source), and for git repositories, which have no
  transaction history (local mode on a git repository, as in the TUI). A transaction that
  wrote no events lists none. Undo (#26) builds on these ids and shapes.
- The cursor is opaque. (It names the next window's first event, as the TUI's "next" row
  does, so it is not an offset.) A cursor naming an event this list no longer starts a
  window at — since removed, or not one this transaction wrote — is `validation` on
  `cursor`; so is a `view` other than `active` or `removed` (on `view`). `page_size` defaults
  to the TUI's window of 20 and is capped at 100.
- `Event` is `{"id", "kind", "author", "created_at", "target"}`. `kind` is Haxy's event kind
  (`user`, `repo`, `fork`, `grant`, `notify`, `discuss`, `issue`, `comment`, `attach`,
  `assign`, `patchrev`, `patch`); `author` is a thread's author shape; `created_at` is null
  for kinds whose records don't keep a time (only discussions, issues, comments and patches
  do).
- `target` is what the event's detail opens, built by Haxy as a structure rather than a URL
  for the client to parse: `{"kind": "thread", "thread_kind", "thread"}` or `{"kind":
  "comment", "thread_kind", "thread", "comment"}`, where `thread_kind` is `discuss`,
  `issue` or `patch` and the others are hex event ids. As in the TUI, only active events
  have one, and only in a thread kind the repository has turned on; an attachment opens its
  thread. Hub opens an issue's page for a thread and a comment's own page for a comment (#13); discussions, patches and comments on them have no Hub page yet and
  are shown as unavailable rather than linked to Haxy.
- Haxy's own event URLs in Markdown open the matching Hub pages (`hubPathForEventsPath` in
  `src/lib/events.ts`, hooked into `hubPathForHaxyPath`). `<repo>` is `/<owner>:<name>` on a
  server and empty in local mode:

  | Haxy | Haxy Hub |
  | --- | --- |
  | `<repo>/events`, `<repo>/events/active` | `<hub repo>/events` |
  | `<repo>/events/removed` | `<hub repo>/events/removed` |
  | `<repo>/events[/active\|/removed]/moment:<n>` (`moment:` before or after the view) | `<hub repo>/events/transactions/<n>[/removed]` |
  | `<repo>/event:<id>/kind:<kind>[/moment:<n>]` | `<hub repo>/events[/transactions/<n>]` |

  An `event:` URL is a window rooted at that event; like `start:` windows it is dropped,
  since only Haxy issues cursors.

Implemented in `haxy/src/api/events.zig` (unit tests in `haxy/src/test/api_events.zig`);
the TUI's reader (`ui.Repo.Events`) now builds each event's `Target` and creation time, from
which the TUI derives its own link. Haxy Hub: `src/lib/events.ts` and
`src/pages/events/EventsSection.tsx`.

## File finder

From issue [#09](issues/09-file-finder.md). `GET`/`HEAD` `…/find?ref=<id>&search=<s>&cursor=&page_size=`
(`…` = `/api/v1/repos/<owner>/<name>` or `/api/v1/repo`) finds the files at a ref whose
names start with `search`, from the file index Haxy keeps for the TUI's files-tab finder. It
resolves the repository and the `ref` (the default branch when absent) as the files view
does, with the same `not_found` and `validation` answers.

Haxy indexes only an **xit repository's branch tips** (a push, a merge or a fork indexes
every branch in the same transaction), so every answer carries the `ref` it read and a
`kind`:

| `kind` | Meaning | Other fields |
| --- | --- | --- |
| `indexed` | The branch's latest commit is indexed. | `items` (`{"name", "path"}`, the path percent-encoded as every repository path is) and `page` |
| `no_index` | A branch whose latest commit no index covers (such as `haxy/events`, or a repository indexed before the branch moved outside Haxy). | `reason: null` |
| `unsupported` | A view Haxy never indexes: `reason` is `"ref"` for a tag, commit or patch revision, `"repository"` for a git repository (local mode). | `reason` |

Neither `no_index` nor `unsupported` is an empty result, and Hub shows each differently.

- Matching and order are the TUI's (`Files.fileIndex` and `Files.findFiles` in
  `ui/Repo/Files.zig`, over `find.zig`): a file matches when its name (the last path
  segment) starts with `search` byte for byte, ignoring ASCII case only; results are ordered
  by that lowercased name, then by path. `search` is decoded once and never trimmed (a name
  may start with a space). An empty `search` matches nothing; it only says whether the view
  is indexed. Submodules aren't indexed.
- Like the TUI, a search stops at 1000 results: past that, `count` is `{"kind":"at_least",
  "value":1000}` and the rest aren't listed; otherwise it is `exact`. Those results page by
  an opaque cursor; `page_size` defaults to the TUI's whole list (1000) and is capped at 100.
- Haxy Hub's finder is `/repos/<owner>/<name>/find` (`/repo/find` in local mode) with the
  ref, search and cursor in the query (`?ref=<id>&search=<s>&cursor=…`), reached from the
  ref bar's **Find a file**. A result opens the file at the URL's ref
  (`repoRoute(repo, path, ref)`). Haxy's own finder URLs are translated
  (`hubPathForFindPath` in `src/lib/finder.ts`, hooked into `hubPathForHaxyPath`):

  | Haxy | Haxy Hub |
  | --- | --- |
  | `<repo>/files[/<ref>]/find:<s>[/line:<n>]` | `<hub repo>/find?[ref=<id>&]search=<s>` |
  | `<repo>/files[/<ref>]/find:<s>[/line:<n>]/path:<path>` | `<hub repo>/files/<path>[?ref=<id>][&line=<n>]`, the result it selects |

  `<repo>` is `/<owner>:<name>`, or empty in local mode. A search that isn't UTF-8 has no
  Hub form and stays as written.
- The TUI shows its search box in server mode only, but Haxy answers `find:` routes in both
  modes, and so does this route: a local xit repository with an index is searchable, and a
  local git repository answers `unsupported`.

Implemented in `haxy/src/api/find.zig` (unit tests in `haxy/src/test/api_find.zig`) and
`haxy-hub/src/lib/finder.ts`.

## Commit history

From issue [#07](issues/07-commit-history-and-search.md). A repository's history lives
under its API path, `/api/v1/repos/{owner}/{name}/commits` on a server and
`/api/v1/repo/commits` in local mode; both routes are `GET`/`HEAD`. They resolve and hide
the repository like the repository routes (`ui.Repo.resolve`): a repository the viewer
can't read is `not_found` with the repository message, and each mode answers the other's
routes with `unsupported`. Every answer is read through the TUI's commits tab
(`ui.Repo.Commits`), so the log, its page size and limits, its committer rule, its
statistics and its search are the TUI's.

| Route | Answer |
| --- | --- |
| `…/commits?ref=&search=&cursor=&page_size=` | `{"ref": Ref, "history", "search": Search, "query", "items": Commit[], "page"}`: a page of the history at `ref` (see Refs; the default branch without one), or of the commits matching `search`. |
| `…/commits/{id}` | One commit (`id` is its full lowercase hex object id): a `Commit` plus `"message"` and `"message_truncated"`. |

- The history is the TUI's log: first parents only, newest first, from the ref's commit
  (a tag peeled). A `revision:` ref lists the revision's source commit back to its base
  (exclusive), as the TUI lists a patch's commits. `ref` is the files view's `Ref` shape.
  Each request reads one snapshot of the repository. The ref, its commits, their
  statistics and count, the revision record and the search index all come from it, and
  the page walks from `ref.commit`. A push that lands during the read therefore can't
  mix two states into one answer.
- `history` is `{"available": true, "reason": null}`, or `{"available": false,
  "reason": {"code": "unsupported", "message"}}` when the history's commits aren't in
  the repository. That happens to a patch revision whose fork was squash-merged: the
  merge keeps the revision but brings in only the squashed commit, so its source commit
  stays in the fork. The page is then empty, but by this field, never as an empty
  history. The revision's files still read, since they are the squashed commit's tree.
- `page_size` defaults to the TUI's page of 20 and is capped at 100. The cursor is the
  id of the next page's first commit, which is how the TUI's pages are keyed (`from:`),
  so a page never reads the log before it. Clients still treat it as opaque. A cursor
  that isn't a commit of this repository is `validation` on `cursor`. A cursor whose commit
  a force push has since removed from the ref still pages from that commit, as the TUI's
  pages do.
- `page.count` is `exact` where Haxy counts the first-parent log (xit repositories: the
  depth xit records for the commit, or a revision's commit count) and `unknown` otherwise
  (git repositories, and search results).
- A `Commit` is `{"id", "parent", "summary", "author", "committer", "committed_at",
  "merge", "stats"}`:
  - `parent` is the first parent (what the commit's diff is against), null for a root
    commit;
  - `summary` is the message's first line; the list sends nothing more of the message;
  - `author` and `committer` are thread authors (`{"kind": "user", "name"}` when an
    account holds the email, else `{"kind": "email", "email"}`, or `{"kind": "unknown"}`).
    `committer` is null when its identity (`Name <email>`) is the author's, as in the TUI;
  - `committed_at` is the committer's timestamp, which the TUI shows;
  - `merge` is true for a commit with more than one parent;
  - `stats` is `{"first_parent_depth", "lines_added", "lines_changed", "lines_removed",
    "bytes_added", "bytes_removed", "files_added", "files_changed", "files_removed"}`.
    Xit computes these when commits arrive (a push), so zeros are real. `stats` is null
    where Haxy has computed none (git repositories, and commits xit made in place), and
    Hub shows "Statistics unavailable" then, never zero.
- A commit's `message` is whole up to the TUI's limit of 100 KiB, trimmed of surrounding
  whitespace. Past the limit, `message_truncated` is true and `message` is its start (an
  incomplete UTF-8 sequence at the cut is dropped). Messages, summaries and emails are
  bytes in git, so they are sent with ill-formed UTF-8 replaced by U+FFFD; they are for
  display only.
- `search` says whether commit search is offered and where. It is
  `{"available": true, "ref": <ref id>, "reason": null}` or `{"available": false, "ref":
  null, "reason": {"code": "unsupported", "message"}}`. Search is Haxy's commit index,
  which a push (and a patch merge) builds for every branch and tag tip of a server
  repository: forks and local mode have none, and the TUI offers no search box in local
  mode. For a branch or tag, `ref` is the listed ref itself when its tip is indexed. For a
  `commit:` or `revision:` ref, as in the TUI, it is the default branch when that is
  indexed. Clients search by sending `search` with that `ref`.
- `search` is Haxy's index query: words, each matching indexed words that start with it,
  all required; results come newest first, a page at a time, with the same cursors.
  `query` echoes it (null for the plain history). A search with no matches is an empty
  page with `search.available` true. A search where the history isn't searchable
  (unindexed, local mode, or a `commit:`/`revision:` ref) is refused with
  `unsupported` (405), never answered with an empty list, so "unavailable" and "no
  matches" stay distinct.
- Errors: a malformed `ref`, `cursor` or `page_size` is `validation` on that field. A ref
  that names nothing is `not_found` ("This repository has no such branch, tag, commit or
  revision."). A history without `ref` whose default branch has no commits is `not_found`
  ("This repository has no commits yet."). A `{id}` that isn't a full commit id of this
  repository (a tree, blob or tag object too) is `not_found`.
- Haxy Hub's routes are `<hub repo>/commits[?ref=<id>][&search=…][&cursor=…]` and
  `<hub repo>/commits/<id>[?ref=<id>]`, where the ref is the history the commit was opened
  from and its way back leads there. The Files and Commits section tabs keep the page's
  ref, as the TUI's tabs do. A commit's diff hangs off both
  `…/commits/{id}`s (see Commit diffs). Haxy's own commits URLs in Markdown are translated by
  `hubPathForCommitPath` (`src/lib/commits.ts`, hooked into `hubPathForHaxyPath`):
  `<repo>/commits[/branch:<n>|tag:<n>][/search:<s>][/from:<c>]` opens the history
  (`from:` dropped) and `<repo>/commits/object:<oid>[/message]` opens the commit.
  Base-bounded and merge lists (`base:`, `merge:`) have no Hub page yet and stay as written.

Implemented in `haxy/src/api/commits.zig` (unit tests in `haxy/src/test/api_commits.zig`);
Haxy Hub: `src/lib/commits.ts`, `src/pages/commits/CommitsSection.tsx`.

## Repository administration

From issue [#23](issues/23-repo-administration.md). A server repository's owners manage it
under `/api/v1/repos/{owner}/{name}/settings…`, and its main owner deletes it with
`DELETE /api/v1/repos/{owner}/{name}` (the repository's other methods stay the overview's).
Local mode answers `unsupported` (405) for every route, including `/api/v1/repo/settings…`
and `DELETE /api/v1/repo`; a wrong method is `unsupported` with `Allow`.

**Who.** Every route needs an owner: the **main owner** (the repository's creator, who owns it
without a grant and can't be demoted or removed) or a **granted owner** (a member promoted to
owner). A viewer who can't read the repository gets `not_found`, exactly as for a missing one;
a reader who isn't an owner gets `forbidden`; an anonymous visitor to a public repository gets
`unauthenticated`. Only the main owner may delete; anyone else gets `forbidden`, and a
granted owner's action on the main owner (demote, remove) is `forbidden` too. Like every
`/api/` write these honour `X-Haxy-Viewer` through the shared write guard (#30). A request
authorizes the one repository record it reads by owner and name, then reads and writes that
record by id (`resolveTarget`, `evt.readNamedRepo`): a repository renamed meanwhile, and one
that took its name, are `not_found`, never served, changed or deleted under another's
authorization (the deletion's check and tombstone run in one transaction).

**Write-time checks.** Authorization is read afresh on every request, so a permission change
applies to the affected user's next request (reads, writes, Git over SSH). Each change also
checks, in the transaction that lands it, that its actor still owns the repository and that
what it read is still there (`evt.changeRole`, `evt.writeRepoChange`, both through
`evt.consumeGuarded`): a member change lands only on the role it read, so a promote never
re-adds someone revoked meanwhile and an add never demotes someone promoted meanwhile
(`conflict`), and an owner demoted while their request ran changes nothing (answered as their
authorization now reads: `forbidden` or `not_found`). Settings and protected-branch changes
apply their fields to the repository as it is when they land, so concurrent changes of other
fields are kept (`conflict` only after repeated collisions), and never to another repository
that took the name meanwhile. Moving the default branch, which writes no event, checks
ownership under the lock role changes take (`evt.whileOwner`).

| Route | Method | Body | Answer |
| --- | --- | --- | --- |
| `…/settings` | `GET`/`HEAD` | — | `{"owner","name","revision","description","access","discuss_role","issue_role","patch_role","hash","main_owner","actions":{"delete":Action}}` |
| `…/settings` | `PUT` | `{revision, description, access, discuss_role, issue_role, patch_role}` | the settings, as `GET` |
| `…/settings/members` | `GET`/`HEAD` | — | a page of `{"name","role"}` plus `"main_owner"` |
| `…/settings/members` | `POST` | `{name}` | 201 `{"name","role":"member"}` |
| `…/settings/members/{name}` | `PUT` | `{role}` (`"owner"` or `"member"`) | `{"name","role"}` |
| `…/settings/members/{name}` | `DELETE` | — | `{"name","role":null}` |
| `…/settings/branches` | `GET`/`HEAD` | — | `{"default_branch": {"name","id"} \| null, "protected": [{"name","id"}], "max_protected": 50}` |
| `…/settings/branches/default` | `PUT` | `{ref}` | the branches, as `GET` |
| `…/settings/branches/protected` | `POST` | `{ref}` | 201, the branches |
| `…/settings/branches/protected?ref=<id>` | `DELETE` | — | the branches; a branch that isn't protected changes nothing |
| `/api/v1/repos/{owner}/{name}` | `DELETE` | `{confirm, password}` | `{"owner","name"}` of the deleted repository |

- Bodies are JSON objects of strings (form encodings are refused with `validation`; a missing
  field reads as empty). Roles for starting threads are the TUI's choices: `"nobody"` (the
  kind is turned off and its section disappears), `"members"` or `"anybody"` (anyone who can
  read the repository). `access` is `"public"` or `"private"`. `hash` (`"sha1"` or
  `"sha256"`) is fixed at creation and only shown; renaming isn't offered.
- A settings change names the `revision` of the settings it was made from, as #12's issue
  edits do: an opaque digest of the name, description, visibility and thread roles
  (`evt.Repo.settingsRevision`; protected branches and the default branch don't move it).
  It is required (`validation` on `revision` otherwise), and when the settings changed since,
  the change is `conflict` keyed by `revision` and nothing is written, so a form loaded before
  another owner's change never saves over it. The check runs in the write's transaction
  (`evt.SettingsChange`). Haxy Hub refreshes an untouched form from fresh settings, and after
  a refusal offers to load the current settings (replacing the edits). The TUI and the HTML
  form still change the settings without a revision.
- Members are listed newest first, without the main owner (named in `main_owner`), readers or
  deleted accounts, as the TUI lists them; `page_size` defaults to the TUI's 20 (at most 100),
  the cursor is opaque and the count `unknown` (the TUI doesn't count members).
- Branches travel as ref ids (`branch:<percent-encoded name>`, see Refs) with display names;
  `ref` is decoded exactly once, and anything but a `branch:` id is `validation` on `ref`. The
  default branch is the one HEAD names, which the repository page, history and clones follow.
  Protected branches can't be deleted or force-pushed over SSH or HTTP; owners push to them
  directly, members only change them by merging a patch.
- Refusals carry one field error beside the field: `validation` for an unknown `access` or
  role (`access`, `discuss_role`, `issue_role`, `patch_role`), a missing name (`name`), an
  unknown member `role` (`role`), too many protected branches or a name too long to protect
  (`ref`), and the typed name or password of a deletion (`confirm`: type `owner:name`
  exactly; `password`); `not_found` for no such user (`name`) or branch (`ref`); `conflict`
  for someone already a member or owner (`name`) and a branch already protected (`ref`).
  Changing someone who isn't a member is `not_found` without field errors; a role another
  owner changed meanwhile is `conflict`.
- The rules are the TUI's and Haxy's web forms' own: `ui.Repo.Settings.update`
  (`evt.updateRepo`), `ui.Repo.Members.readWindow`/`perform` (`evt.changeRole`),
  `ui.Repo.Branches.perform` (`evt.protectBranch`, HEAD for the default) and
  `ui.Delete.perform` (typed `owner:name`, then the password; `evt.deleteRepo` tombstones the
  repository, then removes its directory).

Haxy Hub shows a **Settings** section to owners only (the overview's `settings` section),
at `/repos/<owner>/<name>/settings[/members|/branches|/delete]`. Every write names its viewer,
is guarded against a second submission while pending, and after an unknown outcome reads the
settings, members, branches or repository again and says only what holds now. Demoting and
removing members ask for confirmation; deletion says what goes, then needs the typed
`owner:name` and the password. Implemented in `haxy/src/api/repo_admin.zig` (unit tests in
`haxy/src/test/api_repo_admin.zig`; the transaction checks in
`haxy/src/test/event/repo_admin.zig`) and `haxy-hub/src/lib/repoAdmin.ts`.

## Security notes

- Sessions stay in Haxy's HttpOnly cookie. Tokens, password hashes, local paths, signing
  configuration and SSH private material are never serialized.

### CSRF and same-origin protection

> **Status: Accepted on 2026-11-04** (issue #03 review).

**Rule.** Every `/api/` request whose method is not `GET` or `HEAD` (so `POST`, `PUT`,
`PATCH`, `DELETE`, `OPTIONS` and anything else) passes one check in Zig *before routing*
(`guardWrite` in `haxy/src/api/session.zig`, called first in `handleApiRequest`). It is
refused with `csrf` (403) unless both hold:

1. **Same origin.** If the request has an `Origin` header, its `scheme://host[:port]` must
   name the request's own `Host` (case-insensitive; `:80`/`:443` match their absence for
   http/https). `Origin: null`, another host, or another port is refused. Browsers send
   `Origin` on every non-GET `fetch`, so a browser write can't omit it; a non-browser
   client without `Origin` still needs the token.
2. **Token.** The `X-Haxy-CSRF` header must equal `HMAC-SHA256(key = nonce,
   "haxy-csrf-v1")` in hex, where the nonce is the browser's `haxy_csrf` cookie: 16 random
   bytes, `HttpOnly; SameSite=Strict; Path=/`, issued by `GET /api/v1/session` and
   rotated whenever a session starts, changes or ends, through the API or Haxy's own HTML
   forms (see Session-bound writes). The token is read from the JSON body of
   `GET /api/v1/session`, which only same-origin script can read (Haxy sends no CORS
   headers, and Haxy Hub's Vite server has `cors: false`).

Because the guard runs before routing, a later slice can't add a write route without it,
and unknown paths and wrong methods also answer 403 to a request without a valid token
(404/405 only once the token is valid). The React client (`requestJson` in
`src/lib/api.ts`) adds the header to every non-GET/HEAD request, fetching the token from
the session route the first time; login and logout responses replace it. A `csrf`
refusal means the write never ran, so the client forgets the token, reads the session
again and, if the same viewer is still signed in, retries the write exactly once with the
fresh token (not for streamed bodies); a second refusal is reported. If someone else is
signed in now, it doesn't retry (see Session-bound writes).

**Why this works through the proxy.** Vite forwards `Host` and `Origin` unchanged
(`changeOrigin: false`), so the browser's page origin (`http://127.0.0.1:5173`) and the
`Host` Zig sees (`127.0.0.1:5173`) agree, without configuring Zig with the frontend's
address. A production reverse proxy must likewise preserve `Host` (or the check fails
closed). `X-Forwarded-Host` is deliberately not trusted.

**Why both layers.** The Origin check alone stops cross-site forms and fetches from
modern browsers; the token additionally covers browsers or intermediaries that drop or
rewrite `Origin`, and a custom header can't be sent cross-origin without a CORS preflight
that Haxy never approves. Cookies on `127.0.0.1`/`localhost` are shared across ports, so
another local app could plant a `haxy_csrf` cookie; it still couldn't pass the Origin
check or the preflight.

**Why the token is bound to its own cookie, not the session.** Local mode has no
sessions but has writes, and logging in is itself a write (login CSRF), so the token must
exist before any session does. Binding to a separate nonce also means a session revoked
elsewhere makes the next write fail as `unauthenticated` rather than as a CSRF error. The
token is stateless (no server storage) and survives backend restarts with the cookie.

**Alternatives considered.**

- *Origin/`Sec-Fetch-Site` check only:* simplest, but no defence where `Origin` is
  missing or rewritten, and the issue asks for an explicit token.
- *Plain double-submit cookie (JS-readable cookie echoed in a header):* needs a
  non-HttpOnly cookie; on localhost any app on another port can set it, so the attacker
  knows the value.
- *Synchronizer token stored server-side per session:* needs new storage (the issue says
  no new session store), doesn't cover local mode or login, and is lost on restart.
- *Token derived from the session token:* no new cookie, but nothing exists before login
  or in local mode, and a server-side logout turns the next write into a CSRF error.
- *HMAC with a server secret:* would need a persisted key (local mode has no data dir);
  the per-browser HttpOnly nonce already makes the token unforgeable.
- *Relying on `SameSite` cookies:* `haxy_session` is `Lax` (links from other sites must
  arrive logged in), and `SameSite` treats other ports on the same host as same-site.

### Session-bound writes

> From issue [#30](issues/30-session-bound-write-identity.md). The session cookie is shared
> by every tab, so a write must never land under a user who signed in after it was issued.

**Every session change rotates the nonce.** Each response that starts, replaces or ends a
browser's session sets a fresh `haxy_csrf` nonce, so every token issued before it is
refused with `csrf`. They all use one helper, `CsrfNonce.rotate` in
`haxy/src/api/session.zig`:

| Route | Session change |
| --- | --- |
| `POST /api/v1/session` | API login (replaces any session the browser had) |
| `DELETE /api/v1/session` | API logout |
| `POST /api/v1/account` | API registration, which logs in |
| `DELETE /api/v1/account` | API account deletion, which logs out |
| `POST …/login` (HTML form) | Haxy's own login form |
| `POST …/logout` (HTML form) | Haxy's own logout |
| `POST …/user/new` (HTML form) | Haxy's own sign-up, which logs in |
| `POST …/user/delete/delete` (HTML form) | Haxy's own account deletion, which logs out |
| any page `GET` that claims the `try` demo's auto-login | sets a session cookie, as a login does |

The HTML responses **set the new nonce cookie** rather than clearing it. This is the same
helper and the same `Set-Cookie` as the API's, so the browser never lacks a nonce. Two tabs
reading `GET /api/v1/session` at once therefore can't each mint a different one and
invalidate each other's token. Nothing else sets or clears `haxy_session`; a session
revoked server-side (an account deleted from another browser) leaves the nonce alone, and
its next write fails as `unauthenticated` (see below).

**`X-Haxy-Viewer` on every write.** Any `/api/` write may name the user it is for in the
optional `X-Haxy-Viewer` header. `guardWrite` checks it right after the CSRF check, before
routing, so every write route honours it without opting in, and an unknown path or wrong
method answers as below before 404/405. The session's viewer is read only when the header
is present. The header stays **optional** (user decision, #04):

- absent: the write proceeds as the session's viewer, or anonymously;
- names the session's viewer: the write proceeds;
- names someone else: `conflict` (409, no `field_errors`), and nothing changes;
- names someone while nobody is signed in (anonymous, a deleted account, or local mode):
  `unauthenticated` (401), whatever the route. A client that names a viewer believes
  someone is signed in, so even a route that needs no session (registration, login) is
  refused rather than run anonymously. Registration and login without the header are
  unaffected.

**Haxy Hub binds each write to a viewer** (`requestJson` in `src/lib/api.ts`):

- A write is issued for the viewer named by its `viewer` option (account changes pass the
  account their form was loaded for), else by an `X-Haxy-Viewer` header the caller set,
  else for the viewer the app shows (`SessionProvider` calls `bindWritesTo`). Before the
  app shows one, it uses the viewer the latest session read named. A named viewer is sent
  as `X-Haxy-Viewer`; nobody (`null`) sends no header but is still compared.
- The token cache records the viewer of the session read that supplied the token. A bound
  write (anything but `anyViewer`) never sends a token recorded for another viewer, on a
  first attempt or a retry, and that includes `null`, which the backend can't check. A
  mismatch is confirmed with one fresh session read; if it holds, the write isn't sent and
  `ViewerChangedError` is thrown.
- After a `csrf` refusal it forgets the token and re-reads the session before replaying, so
  the replay obeys the same rule: it runs only if the same viewer is still signed in.
- A `conflict` without field errors, or `unauthenticated`, on a write that named a viewer
  means the same once a session read confirms someone else (or nobody) is signed in now.
- `ViewerChangedError` (a `conflict` `ApiError`) says who is signed in now. Forms show it
  with a Reload button (`failureOf`/`FailureMessage` in `src/components/form.tsx`), and the
  page keeps what it showed until then.
- Login, logout and registration pass `viewer: anyViewer`: they change the viewer by
  design, so they are never refused or held back for it. Account deletion stays bound to
  its viewer.

**HTML form routes.** From [issue #29](issues/29-origin-check-for-html-form-routes.md).
Haxy's own server-rendered form routes outside `/api/` (`/login`, `/logout`, `…/new`, …)
apply rule 1 alone, without a token, so the forms keep working with and without
JavaScript: every request whose method is not `GET` or `HEAD` and that carries an `Origin`
must name its own `Host`, or it is refused with a static 403 HTML page before any route is
matched (`guardForm` in `haxy/src/origin.zig`, called in `handleRequest` right after the
`/api/` dispatch). A request without `Origin` (a non-browser client) behaves as before.
Git's smart HTTP is dispatched before this check and is unaffected, as are SSH and the
TUI. The origin comparison itself (`sameOrigin` in `haxy/src/origin.zig`, unit tests in
`haxy/src/test/origin.zig`) is the one `guardWrite` uses, and it also refuses an `Origin`
with no host.

## Decided in review (2026-11-04)

- `unsupported` is 405 both for wrong methods (with `Allow`) and for operations a host
  mode doesn't offer.
- `validation` is 400 for both malformed requests and invalid values; there is no
  separate 422.
- Timestamps are RFC 3339 UTC strings (see Timestamps), not integer Unix seconds.
- `field_errors` is an object keyed by field name, not an array.
- Pagination uses `cursor` and an optional client `page_size`.
- CSRF protection is the Origin check plus a token bound to a per-browser HttpOnly nonce
  (not a server secret or the session), so it covers local mode and login.
- CSRF refusals have their own `csrf` code (403), and the client retries once with a
  fresh token.
- The guard runs before routing, so a write without a valid token answers 403 even for
  unknown paths and wrong methods; this also hides which write routes exist.
- Wrong credentials give one generic `unauthenticated` message, not which field was wrong.
- A production reverse proxy must preserve `Host`; writes fail closed otherwise.
- Rich text (such as the about page) is sent as Haxy's parsed Markdown blocks, so Hub
  renders what the TUI renders; later slices reuse that shape.
- Hub routes may differ from Haxy's TUI paths where those collide (e.g. `/about`,
  `/users/<name>`); Haxy links in content are translated to Hub routes.
- `page_size` is capped at 100 per request; the default stays the TUI's page size.
- Repository paths travel percent-encoded byte for byte, with separate U+FFFD-replaced
  display names (#05; see Repository paths).
- `X-Haxy-Viewer` is optional; when sent it must name the session's viewer (user decision, #04).
  Since #30 the shared write guard checks it for every `/api/` write. A header naming
  someone while nobody is signed in is `unauthenticated`.
- Every session change, through the API or Haxy's HTML forms, rotates the CSRF nonce
  through one helper; HTML responses set the new nonce cookie rather than clearing it (#30).
- Timestamps go through `api.Instant` (Zig), which writes RFC 3339 UTC and clamps
  instants past the year 9999 (a commit may claim any time) (#11).
- A ref travels as one `ref=<kind>:<value>` parameter (`branch`, `tag`, `commit`,
  `revision`), its name percent-encoded byte for byte like paths; a `commit:` id must name a
  commit object, and only `tag:` peels annotated tags (user decision, #06; see Refs).
- A header naming a viewer while nobody is signed in is refused, login and registration
  included; login, logout and registration are never bound to a viewer, so a stale tab can
  still log out whoever is signed in now (user decisions, #30).
- `POST /api/v1/repos` has no Vite proxy timeout (copies grow with repository size); every
  other `/api/` route keeps 10s (user decision, #10).
- A repository's events and transaction views are for people who may write to it, as in
  the TUI; anyone else gets `not_found` (user decision, #24).
- Creating an issue is idempotent by a client-chosen event id; editing an issue and saving
  repository settings must send a `revision` (a digest of the editable fields) and a stale one
  is `conflict`. The TUI and HTML forms still overwrite as before (user decisions, #12, #23).
- The file finder is offered in both modes wherever an index exists; commit search only on
  a server, where Haxy builds commit indexes on push (user decisions, #09, #07).
- A commit's diff is against its first parent; added and removed files list their path,
  not their lines; the path filter names one exact file; binary and too-large files show
  placeholders, and the TUI now shows them too instead of omitting the file or failing the
  page (user decisions, #08).
- Comments page oldest first, replies included, as in the TUI; removed comments stay
  listed as removed, without their text (user decisions, #13).
- Assigning someone already assigned is `conflict`, as in the TUI, not an idempotent
  success; Hub settles a lost answer by reading the issue again or by a safe repeat (user
  decision, #15).
- Any owner of a repository may execute an undo, granted owners included, as in the TUI
  and Haxy's HTML form (the spec's "main owner" is amended); ownership is re-checked at
  execution, and an undo must name the history's `revision` (user decisions, #26).
- A local-mode sync is one request that answers when it finishes; a failed sync answers
  200 with `outcome: "failed"` and the step that failed; the last result lives in memory,
  and conflict counts include every unresolved conflict. `evt.consume` merges histories
  with no common ancestor with no baseline, which also fixes the TUI's first sync after
  both sides wrote (user decisions, #27).
- A member lookup for someone the member list doesn't hold answers 200 with `role: null`,
  not `not_found`, which the settings pages read as lost access (user decision, #31).

## Known follow-up

- Vite's 10s `proxyTimeout` is now scoped per route (see Timeouts); repository creation and
  local-mode sync are exempt. Long-running endpoints still to come (merge) must be added to the
  exempt list as they land; attachment uploads and downloads are on it (#14).
- A sync that fetches events Haxy can't read reports a `merge` failure, but leaves the local
  events branch at the unreadable commit, so later local reads fail; the TUI does the same.
  Tracked as [#32](issues/32-sync-unreadable-remote-events.md).

## Threads: writing issues

From issue [#12](issues/12-issues-write.md). The issue routes of "Threads: issues" also
take writes. Like every `/api/` write they pass the shared write guard first (CSRF token,
`Origin`, optional `X-Haxy-Viewer`), and Haxy Hub binds each to the viewer its page was
loaded for. Bodies are JSON objects of strings (form encodings and other types are
refused with `validation`, no field errors); a missing field reads as empty.

| Route | Method | Body | Answer |
| --- | --- | --- | --- |
| `…/issues` | `POST` | `{id?, title, labels, description}` | 201, the new issue as `…/issues/{id}` reads it |
| `…/issues/{id}` | `PATCH` | `{revision, title, labels, description}` | the issue, its fields replaced |
| `…/issues/{id}/status` | `PUT` | `{status: "open" \| "closed"}` | the issue |
| `…/issues/{id}` | `DELETE` | — | `{"id"}` |

Wrong methods are `unsupported` with `Allow` (`GET, HEAD, POST` on the list,
`GET, HEAD, PATCH, DELETE` on an issue, `PUT` on its status, `GET, HEAD` on the labels).

**One set of rules.** Every write goes through `haxy/src/thread_write.zig`, which the
TUI's thread tabs and Haxy's HTML forms (`…/issues/new`, `…/edit`, `…/close`, `…/open`,
`…/remove`) now use too: `create`, `editIssue`, `setStatus` and `remove`, generic over the
thread kind where the kinds agree, so discussions (#16) and patches (#18) extend them.

- *Who may write at all* is `ui.authorizeUser`, read from the admin db **when the write
  runs**: the viewer's role in the repository, then the kind's thread-creation role
  (`issue_role`: anybody who can read, members, or nobody, which turns issues off).
  Anonymous (or deleted-account) viewers get `unauthenticated`; a role below the threshold
  gets `forbidden` ("Your role in this repository doesn't allow writing issues."). A role
  revoked after the page loaded is refused the same way, never a false success.
- *Who may change an issue* is `ui.RepoSource.canModify`: anyone with the write role,
  otherwise only its author (by email). Others get `forbidden`.
- *What an issue holds* is `evt.Issue.fieldsValid` (via `thread_write.checkFields`): a
  non-blank title (`validation` on `title`) and labels of at most 64 bytes each
  (`validation` on `labels`). The description's CRLF line breaks become `\n`, as the HTML
  form stores them.
- An issue the id doesn't name (or a removed one) is `not_found` ("There is no issue with
  this id."), checked before the viewer's rights. A repository the viewer can't read is
  `not_found` with the repository message, and one whose issues are off answers as reads do.
- **Local mode** writes without logging in, as its repository's owner, with the author
  from the repository's (and the global) Git config (`ui.localAuthor`), as the TUI's local
  event editing does.

**What the viewer may do.** List answers carry `"actions": {"create": Availability}` and
issue answers `"actions": {"edit", "set_status", "remove"}`, in the shape of "Capabilities
and action availability": the TUI's own decision (its issues tab viewer, and each entry's
`can_modify`), with `unauthenticated` or `forbidden` reasons. Haxy Hub shows a control only
when its action is available (readers and anonymous viewers see none); Haxy checks again
when the write runs. Because the answer depends on the viewer, Hub reads it again when the
viewer changes.

**Creation is idempotent by id (decision, #12).** `id`, when sent, is the new issue's
event id: 32 lowercase hex digits (`validation` on `id` otherwise); without it Haxy picks a
random one. An id any event in the repository already has is `conflict` keyed by `id`, and
nothing is written. The check runs inside the write's own transaction for a xit repository
(every server repository); a Git repository's events (local mode) have none, so every
shared write to one holds an in-process lock across its read, check and write (local mode is
one process serving one repository; see "Atomic checks" below). Haxy Hub generates one id per form, so when an outcome is
unknown (timeout, `unreachable`, `internal`, unreadable answer) it reads `…/issues/{id}`:
found means the issue was opened; `not_found` means it wasn't, and the same submission can
be sent again safely, since a second creation under the id is refused rather than opening a
duplicate (Hub reads a `conflict` on its own `id` as "already opened"). This was chosen over
an idempotency-key store (new state to keep) and over matching by title (ambiguous).

**Edits name the revision they replace (decision, #12).** Issue answers carry `revision`,
an opaque string: a digest of exactly what an edit replaces (title, labels and description;
`evt.Issue.contentRevision`), computed from the stored issue. It moves whenever any of
those changes, however the change arrived (an edit from any client, a conflict resolution,
or a merge from another host, which may leave the record's event order where it was), and
stays when only the status, comments or assignees change, which an edit keeps. `PATCH` must
send it (`validation` on `revision` otherwise); when the fields have changed since, the edit
is `conflict` keyed by `revision` and nothing is written, so an edit based on stale fields
never silently overwrites someone else's. A xit repository re-checks inside the write's
transaction (`evt.Issue.updateAt`); a Git repository's under the lock below. Haxy Hub keeps the user's text, offers to show the current version (which moves the
revision it saves against), and only then lets them save over it. After an unknown outcome
Hub reads the issue: holding exactly what was sent means saved; still at the old revision
means not saved (a retry is safe, the revision guards it); anything else is someone else's
change. The TUI and the HTML edit form still replace the fields without a revision, as
before. A merge that leaves a field conflict keeps this server's values, so the revision
stays; the answer's `conflicted` says so, and an edit settles the conflict as every event
does (#25 resolves conflicts).

**Atomic checks (#12 review).** A write never re-emits fields it didn't mean to change from
a stale read. In a xit repository `evt.Issue.updateAt` builds the event again inside the
write's transaction from the issue as it is there: an edit changes only title, labels and
description and keeps the live status, and a status change keeps the live fields (setting
the status the issue already has writes nothing). In a Git repository every
`thread_write` operation (`create`'s id check, `editIssue`'s revision check, `setStatus`,
`remove`'s author and existence checks) holds one process-wide lock across its read, check
and write, so two concurrent edits from one revision can't both pass: one lands and the
other is `conflict`. Writes outside `thread_write` (comments, assignments, conflict
resolution) don't take it; none of them checks issue fields before writing them, except a
resolution, which #25 owns.

**Local mode reads its events branch first.** Every shared write in local mode first brings
the repository's event db up to date with its events branch (as each TUI page build and API
read there does), so a branch cloned, fetched or synced since nothing read it is seen by the
checks a write makes: whether an id is free, who wrote an issue, what it holds. A server's
repositories consume every event, pushed ones included, in the transaction that writes it.

**Removed versus never opened.** `GET …/issues/{id}` answers `not_found` alike for an id
never used and for a removed issue (decision, #12): the API exposes no removed records.
Hub doesn't need it to: removed events keep their ids, so a creation refused as `conflict`
on the form's own (random) id, followed by `not_found`, means the issue was opened and then
removed. Hub says so, keeps the draft, and opens it under a new id only when the user asks.

**Status and removal** need no revision: setting the status an issue already has changes
nothing (so a retry is safe), and removing a removed issue is `not_found`. Hub settles an
unknown outcome by reading the issue (and treats `not_found` after a removal as done).
Hub asks for confirmation before a removal; every Hub form and action holds itself while a
write is pending, and ignores the later clicks of a double click (`detail > 1`) even when the
first one's answer has already arrived, so a double click on Close can't reopen the issue.

The write routes keep the Vite proxy's 10 s timeout (they are single small transactions);
a timeout is an unknown outcome as above. Implemented in `haxy/src/api/issues.zig`,
`haxy/src/api/thread.zig` (`Availability`, `listActions`, `threadActions`, `parseNewId`,
`parseRevision`, `fieldsError`) and `haxy/src/thread_write.zig`; unit tests in
`haxy/src/test/api_issues.zig` and `haxy/src/test/thread_write.zig`. Haxy Hub:
`src/lib/threads.ts` and `src/components/thread/` (`ThreadForm`, `ThreadNew`, `ThreadEdit`,
`ThreadActions`).

## Repository administration: one member's role

From issue [#31](issues/31-admin-recovery-edge-cases.md), adding to Repository
administration above.

| Route | Method | Body | Answer |
| --- | --- | --- | --- |
| `/api/v1/repos/{owner}/{name}/settings/members/{member}` | `GET`/`HEAD` | — | `{"name","role"}` |

- It reads one member's role as the member list holds it, in one request however long the
  list, for the same people as the list (owners; anyone else as for the list). The `PUT` and
  `DELETE` of the same path are unchanged; any other method is `unsupported` with
  `Allow: GET, HEAD, PUT, DELETE`.
- `{member}` is a path segment like any other: percent-encoded byte for byte and decoded
  exactly once (`bobb%2579` names `bobb%79`). The answer's `name` is that name, with U+FFFD
  where it isn't UTF-8.
- `role` is `"owner"` or `"member"`; `"owner"` for the main owner (never listed, always an
  owner); and `null` for anyone the list doesn't hold: no such user, a deleted account, a
  reader, or someone without a grant. A non-member is answered `200` with `role: null`,
  not `not_found`: `not_found` stays the answer for the repository itself (missing, hidden
  from the viewer, or renamed or deleted meanwhile), so a client settling a write tells
  "not a member" from "lost access" without parsing messages.
- The repository and the grant are read from one moment of the owner's records
  (`ui.Repo.Members.readRole`, beside `readWindow`).

Haxy Hub settles a member write whose outcome is unknown, or that was refused as
`conflict`/`not_found`, with this lookup (`memberRole` in `src/lib/repoAdmin.ts`), so
"Check again" settles in one request even past the first thousand members and after a
revoke. A deletion whose answer is lost and whose follow-up probe finds that another tab
signed out or switched user says that the outcome couldn't be checked, never that nothing
was deleted, and offers a reload; the deletion stays disabled.

## Commit diffs

From issue [#08](issues/08-commit-diffs.md). A commit's diff hangs off its route:
`GET`/`HEAD` `…/commits/{id}/diff?path=&cursor=&page_size=` (`…` =
`/api/v1/repos/{owner}/{name}` or `/api/v1/repo`). It resolves and hides the repository
as the commit routes do (see Commit history), and `{id}` is a full commit id as there.
The diff is against the commit's first parent (its `parent`), or against nothing for a
root commit, so every file a root commit holds is added; a merge's diff therefore spans
everything its other parents brought in.

Every window is read through the TUI's diff pane (`ui.Repo.Diff.renderAt`), so what a
window holds, its size, the path filter and the placeholders are the TUI's:

```json
{
  "commit": "<id>", "parent": "<id>" | null, "path": "<encoded path>" | null,
  "items": [{ "path", "name", "status", "kind", "lines": [{ "kind", "old_number", "new_number", "text" }] }],
  "truncated": false,
  "page": { "has_more": true, "next_cursor": "10", "count": { "kind": "unknown" } }
}
```

- An **entry** is a hunk of a changed text file, or a whole file shown only by its path.
  Files come in the order of Haxy's tree diff; a changed file's hunks are consecutive
  entries with the same `path`. `path` is percent-encoded bytes and `name` its last
  segment for display (see Repository paths).
- `status` is `added`, `removed` or `changed`. `kind` says what the entry shows:
  - `hunk`: `lines` of a changed text file, each `context`, `added` or `removed`, with
    1-based `old_number`/`new_number` (null on the side a line isn't on) and its `text`.
    Xit breaks a long change into hunks of at most 500 edits.
  - `file`: an added or removed text file, which shows only its path, as in the TUI.
  - `binary`: a file xit reads as binary: not UTF-8, or past its text limits (50 MB, a
    line of 10,000 bytes or more, a million lines). Such a file is never diffed.
  - `too_large`: a change past xit's limit on a file's edits (a million). The entries
    of that file before the limit stay, and the rest of the file is this one entry.
  The last three carry no `lines`.
- `truncated` is true when the diff passes xit's limit on the lines a diff reads (50
  million across its files). The window ends there, with `has_more` false. Clients must
  not read an empty window then as "no changes": the files it would have held were never
  examined (a path filter's file included). The TUI pane says "the rest of this diff is
  too large to show", and Hub shows "These changes are incomplete" in place of any
  "no changes" state.
- **Windows.** `page_size` counts entries; it defaults to the TUI's window of 10 and is
  capped at 100. A window also stops before an entry that would take it past a million
  cells (lines × widest line, as the TUI lays them out), but always holds at least one.
  The cursor is the next window's first entry, counted from the start of the diff, which
  is how the TUI keys its windows (`start:`); clients treat it as opaque. A cursor past the
  end is an empty window. The count is `unknown`, as the TUI doesn't count a diff.
- **Path filter.** `path` (sent back as a response encoded it, decoded once, as the files
  view reads it) narrows the diff to the file at exactly that path, as the TUI's filter
  does; it isn't a directory prefix. A path the commit doesn't change is an empty window,
  not an error. The answer echoes it as `path`.
- One repository snapshot is read per request: the commit, its parent, and every file.
- Errors: a `{id}` that isn't a full commit id of this repository (a tree, blob or tag
  object too) is `not_found` ("This repository has no commit with this id."). A malformed
  `path`, `cursor` or `page_size` is `validation` on that field.

The shared operation (`Diff.renderAt`) now also serves the TUI: a changed binary file,
which the TUI used to leave out, shows there labelled "binary", and a change past xit's
limits shows "too large to diff" instead of failing the page.

Haxy Hub's route is `<hub repo>/commits/<id>/diff[?ref=<id>][&path=<encoded path>][&cursor=…]`
(`commitDiffRoute`), reached from the commit page's "View changes". `ref` is the history the
commit was opened from, as for the commit page. The path is put in exactly as Haxy encoded
it and read back from the raw `location.search` (`diffParams`), so a path that isn't UTF-8
round-trips through refresh, back/forward and shared links; paths are shown with U+FFFD
replacement. Each file's entries show under its path with "View file" (the files view at
`commit:<id>`, or at `commit:<parent>` for a removed file) and "Only this file" (the
filter). Long lines scroll sideways inside each hunk's own box.

Implemented in `haxy/src/api/diff.zig`, dispatched from `haxy/src/api/commits.zig` (unit
tests in `haxy/src/test/api_diff.zig`, and the shared windows' in `haxy/src/test/ui.zig`).
Haxy Hub: `src/lib/diff.ts` and `src/pages/commits/CommitDiff.tsx`.

## Threads: assignees

From issue [#15](issues/15-assignment.md). An issue's assignees are part of its answers
(`ThreadSummary.assignees`, see "Threads: issues"); each is
`{"id", "name", "email", "search"}`: `name` when an account holds the assigned email (then
`email` is null), else `email` alone, so an account's email is never shown. `id` is the
assignment's event id (`evt.Assignment.idOf` the issue and the email), opaque to clients. In
local mode, which has no accounts, every assignee shows by email. `search` is the
`assignee:` filter that lists what they are assigned (Hub links each assignee to its own
status's list with it, through `threadsRoute`).

| Route | Method | Body | Answer |
| --- | --- | --- | --- |
| `…/issues/{id}/assignees` | `POST` | `{assignee}` | the issue as `…/issues/{id}` reads it, the assignee added |
| `…/issues/{id}/assignees/{assignment}` | `DELETE` | — | the issue, the assignee removed |

Wrong methods are `unsupported` with `Allow` (`POST`, `DELETE`). Like every `/api/` write
they pass the shared write guard first, and Haxy Hub binds each to the viewer its page was
loaded for.

**One set of rules.** Both write through `thread_write.assign` and `thread_write.unassign`,
which the TUI's thread tabs and Haxy's HTML forms (`…/issue:<id>/assign`,
`…/assignee:<email>/unassign`) now use too:

- *Who may write at all* is the issues tab's (`ui.authorizeUser`, as for every issue write:
  `unauthenticated`, or `forbidden` "Your role in this repository doesn't allow writing
  issues."). *Who may change who is assigned* is `ui.RepoSource.canModify` on the issue:
  its author or anyone with the write role; others get `forbidden` ("Only the issue's author
  and the repository's writers can change it."). Issue answers carry
  `actions.assign`, the same decision.
- *Who `assignee` names* is `ui.assigneeEmail`: text with an `@` is an email (trimmed); on a
  server anything else is an account's name, assigned by that account's email. Refusals are
  beside `assignee`: `validation` for a name no account holds, for blank text, and for an
  email an assignment can't hold (whitespace, over 254 bytes); in local mode every name is
  refused ("Enter an email address."). Someone already assigned, by name or by their
  account's email, is `conflict` keyed by `assignee` ("This person is already assigned."),
  the TUI's "already assigned".
- An unknown or removed issue is `not_found` ("There is no issue with this id."), checked
  before the viewer's rights. An `{assignment}` that isn't one of the issue's current
  assignments (never made, already unassigned, or not an id) is `not_found` ("This person
  isn't assigned to this issue."), and nothing changes.
- **Atomic checks.** That the issue is live and whether the assignment is already active
  are checked where the write lands: inside a xit repository's write transaction
  (`evt.consumeGuarded`), or under #12's events lock for a Git repository (local mode), as
  is the author check (so assignments now take that lock, unlike the note under #12's
  "Atomic checks"). Local mode reads its events branch first, as every shared write does.
  The answer is the issue read after the write.

**Settling unknown outcomes.** Neither write is idempotent (the TUI's rules refuse a
repeat), so Haxy Hub settles them: after an unknown outcome it reads the issue. An
assignee shown under the typed name or email, or an unassigned `id` gone from the list,
means done. Otherwise the user is told it couldn't be confirmed and that repeating is
safe: a repeated assignment refused as `conflict` on `assignee`, or a repeated
unassignment answered `not_found`, means the earlier attempt landed, and Hub says so rather
than showing the refusal. (An email that belongs to an account shows as its name, so only
the repeat can settle that case.) Whenever the read that would show the assignees as they
are fails, including after a repeat that settled, the form holds itself until a "Check
again" read succeeds (`useWrite`). The Assign button ignores the later clicks of a double
click, as every Hub form does. An assignee answer updates only the assignees on the issue
page, and a status answer everything else (`useThreadAnswers`), so answers that cross can't
undo each other's change (#15 review). The issue page also reads the issue again in the background (a
comment posted, another comment page). Each answer notes when it arrived and each read when it
started, so an answer stands over any read that started before it and gives way to one that
started after it; and a background read that fails keeps the page, and every draft in it, with a
"Couldn't refresh" alert and a retry (`useKept`). Only the first load may show a failure
(batch-4 merge review, `e2e/thread-refresh.spec.ts`).

Implemented in `haxy/src/api/assignees.zig` (routes) and `haxy/src/thread_write.zig`
(`assign`, `unassign`), with `id` and `actions.assign` in `haxy/src/api/thread.zig`; unit
tests in `haxy/src/test/api_assignees.zig`, `haxy/src/test/api_issues.zig` and
`haxy/src/test/thread_write.zig`. Haxy Hub: `src/lib/assignees.ts` and
`src/components/assignees/ThreadAssignees.tsx`.

## Comments

From issue [#13](issues/13-comments.md). A thread's comments live under the thread's own
route, so every kind shares them (issues now; discussions in #16 and patches in #17 hook
the same module in with their own `Kind`). `<thread>` is `…/issues/{id}`. Like the issue
routes, they resolve the repository as the viewer (one they can't read is `not_found`
with the repository message), answer as the issue routes do when the kind is off, and
answer `not_found` ("There is no issue with this id.") for a thread the id doesn't name or
a removed one.

| Route | Method | Body | Answer |
| --- | --- | --- | --- |
| `<thread>/comments?cursor=&page_size=` | `GET`/`HEAD` | — | `{"items": Comment[], "page", "previous_cursor", "actions": {"create": Availability}}` |
| `<thread>/comments` | `POST` | `{id?, parent_id?, body}` | 201, the new comment as its own route reads it |
| `<thread>/comments/{comment}?cursor=&page_size=` | `GET`/`HEAD` | — | `{"comment": Comment, "thread_cursor", "replies": {"items", "page", "previous_cursor"}}` |
| `<thread>/comments/{comment}` | `PATCH` | `{revision, body}` | the comment, as its own route reads it |
| `<thread>/comments/{comment}` | `DELETE` | — | the comment, removed, as its own route reads it |

Wrong methods are `unsupported` with `Allow` (`GET, HEAD, POST` on the list,
`GET, HEAD, PATCH, DELETE` on a comment). A comment that isn't in the route's thread is
`not_found` ("There is no comment with this id in this thread.").

**Reads are the TUI's.** Both routes read through the TUI's own comment reader
(`ui.Repo.Comment`, which the TUI's thread pages and permalink pages use), from one moment
of the repository's events:

- A thread's comments are every comment in it, replies included, **oldest first** (the
  TUI's order, an exception to "newest first"), in windows of the TUI's 10 by default
  (`page_size` up to 100). A comment's own route has the comment and a window of its
  **immediate** replies, the TUI's permalink page. Counts are `exact`.
- Cursors are opaque (they are the window's offset, as the TUI's `start:` is, but clients
  never build or parse them). `previous_cursor` is the window before this one, null on the
  first; a cursor past the end lists nothing. An unreadable cursor is `validation`.
- `thread_cursor` names the thread's comment window (at the default size) that shows the
  comment, null when that is the first: a link to a comment on a later page carries it.
- A `Comment` is `{"id", "parent_id", "author", "parent_author", "created_at", "removed",
  "body": MarkdownBlock[], "body_text", "revision", "actions": {"reply", "edit",
  "remove"}}`. `parent_id` is null for a comment on the thread and names the parent comment
  of a reply; `parent_author` is that comment's author (the TUI's "replying to"), null for
  a comment on the thread. Authors have the thread `Author` shape. `body` is the body parsed
  by Haxy's Markdown reader.
- **Removed comments stay** in their thread, as in the TUI, so their replies stay
  connected: `removed` is true, `body` is empty and `body_text` is `""` (the removed text
  is never sent), and they can still be replied to, as in the TUI.

**Who may do what** is the TUI's, rechecked when a write runs:

- *Comment or reply*: whoever may write in the kind's tab (`ui.authorizeUser` with the
  kind's thread role, as for opening a thread). Anonymous viewers get `unauthenticated`
  ("Log in to comment on issues."), a role below the tab's `forbidden`.
- *Edit or remove*: the comment's author, or anyone with the repository's write role
  (`ui.RepoSource.canModify`, the TUI's `can_modify`); others get `forbidden` ("Only the
  comment's author and the repository's writers can change it."). The tab's role is checked
  first, so a member whose role was revoked can't change even their own.
- `actions` say so per comment: `reply` (as `create`), and `edit`/`remove`, which are
  unavailable with `conflict` ("This comment has been removed.") once it is removed.
- Local mode writes without logging in, as its repository's owner (`ui.localAuthor`).

**One set of rules.** Every write goes through `haxy/src/thread_write.zig`, which the TUI's
comment forms and Haxy's HTML comment forms (`…/new`, `…/comment:<c>/new`, `…/edit`,
`…/remove`) now use too: `comment` (posting; a reply's parent must be a comment in the
same thread, `evt.threadHolds`), `editComment` and `remove`. A body must not be empty
(`evt.Comment.fieldsValid`; `validation` on `body`, "Write a comment."); CRLF line breaks
become `\n`. Git-backed (local) repositories take the process-wide events lock, and catch
up with their events branch first, as the issue writes do.

- **Posting is idempotent by id**, as creating an issue is (#12's decision): `id`, when
  sent, is the new comment's event id (32 lowercase hex digits, `validation` on `id`
  otherwise); one any event already has is `conflict` keyed by `id`, checked inside the
  write's transaction (or under the lock). `parent_id` is empty for a comment on the
  thread, else a comment's id (`validation` on `parent_id` when malformed; `not_found` when
  it is no comment in this thread). Because removed comments are still readable, a client
  that lost the answer reads `<thread>/comments/{id}`: found means posted (and, if
  `removed`, removed since); `not_found` means not posted, and the same post can be sent
  again.
- **Edits name the revision they replace**, as issue edits do: `revision` is a digest of
  the body (`evt.Comment.contentRevision`), and `PATCH` must send it (`validation` on
  `revision` otherwise). A body changed since is `conflict` keyed by `revision`; a removed
  comment is `conflict` without field errors ("This comment has been removed."). A xit
  repository re-checks both inside the write's transaction. The TUI and the HTML edit form
  still replace the body without a revision.
- **Removing a removed comment changes nothing** and answers as a removal does (no second
  event is written), so a retry is safe.

**Haxy Hub.** A thread's page lists one window of its comments (`?comments=<cursor>` keeps
the page in the URL; first, previous and next page links), each with its author, reply
context (a link to the parent comment's page) and time, which links to the comment's own
page, `<hub repo>/issues/<id>/comments/<comment>` (`?replies=<cursor>` for its reply
windows). That page shows the comment, its reply context and its replies, and links back
into the thread at the window holding the comment, with the comment's fragment
(`…?comments=<thread_cursor>#comment-<id>`): the thread page brings that comment into view
and focuses it once loaded, after a refresh too. A new comment or reply opens the same
way. Reply, edit and remove are offered only when the comment's `actions` say so; removal
asks first; each form holds itself while a write is pending and ignores the later clicks
of a double click. Unknown outcomes are settled by reading the comment: a post by its id
(as above), an edit by comparing the body with what was sent and the revision with the one
edited, a removal by `removed`. Haxy's comment permalinks in Markdown and the events list
open the comment's page.

The write routes keep the Vite proxy's 10 s timeout. Implemented in
`haxy/src/api/comments.zig` (hooked in by `api/issues.zig`), `haxy/src/thread_write.zig`
and `haxy/src/ui/Repo/Comment.zig` (`loadWindowSized`, `initSized`, `threadPosition`);
unit tests in `haxy/src/test/thread_write.zig` and `haxy/src/test/api_issues.zig`. Haxy
Hub: `src/lib/comments.ts` and `src/components/thread/` (`ThreadComments`,
`CommentPermalink`, `CommentCard`, `CommentForms`).

## Undo

From issue [#26](issues/26-undo.md). A server repository's undo history lives under
`/api/v1/repos/{owner}/{name}/undo`. Local mode leaves undo to xit itself: every route,
including `/api/v1/repo/undo…`, answers `unsupported` (405, "Undo is not available in local
mode."), whatever the method; a server answers the local routes `unsupported` too.

| Route | Method | Body | Answer |
| --- | --- | --- | --- |
| `…/undo?cursor=&page_size=` | `GET`/`HEAD` | — | `{"revision", "newest", "items": UndoRecord[], "page"}`, newest first |
| `…/undo/{id}?cursor=&page_size=` | `GET`/`HEAD` | — | the same, from transaction `{id}` down (the TUI's `/undo/<n>`) |
| `…/undo` | `POST` | `{transaction, revision}` | 201 `{"revision", "record": UndoRecord}` |

- **The rules are the TUI's.** Reads come from the TUI's undo tab (`ui.Repo.Undo.initWindow`)
  and undos run through the TUI's own operation (`ui.Repo.Undo.executeAsOwner`). Who sees the
  history is `ui.Repo.hasSection(.undo, …)`: people who may write to the repository (the
  overview lists `undo` in `sections` then). Anyone else who can read it gets `not_found`
  ("Only people who may write to this repository see its undo history.") from every route,
  checked before anything the request names, as for events. Who may undo is
  `RepoHandle.canUndo`: the repository's owners, its main owner and granted owners alike, as
  in the TUI and Haxy's HTML form; a member gets `forbidden` ("Only the repository's owners can
  undo."). What can be undone is `Undo.undoable`: any transaction above the history's floor,
  never the initial state or the history a copied repository carries from its source.
- **Transactions and pages.** A transaction id is its index in the repository's history, as
  in Events and transactions: a decimal string, opaque to clients. `newest` is the history's
  newest transaction when it was read, and `revision` an opaque string (32 hex digits today)
  naming the history as that read saw it (`Undo.Revision`): a digest of the database's
  generation (its file id, which every compaction draws anew), the newest transaction's index,
  its place in the database and its undo record, and the record of the history's first
  transaction. An index alone wouldn't do: clearing the history (the `:refs/haxy/undo` push)
  compacts it to one transaction, so later ones reuse the indices a page read before the clear
  showed; with the generation, even a history cleared and rebuilt the same way within one
  second differs. Pages are the TUI's window of 20 by default (at most
  100); the cursor is opaque (a `cursor` that names no listed transaction is `validation` on
  `cursor`, and takes precedence over `{id}`), and `count` is exact: every transaction from the
  floor up. `{id}` that isn't canonical decimal or isn't listed is `not_found` ("There is no
  transaction with this id in the undo history.").
- `UndoRecord` is `{"transaction", "action", "description", "created_at", "undone", "details",
  "actions": {"undo": Action}}`, what the TUI's row and detail show: `action` is its row text
  (`events (3)`, `undo`, `push`, `commit`…), `description` the text it shows when it has no
  details, `created_at` null when the transaction has no undo record, and `undone` true when a
  later undo discarded it. `details` stand in for the description, each `{"label", "text",
  "target"}` as the TUI's labelled buttons (`what was undone`, `what was redone`, `events`,
  `user`, `added to branch`, `created tag`…); `target` is null or what it opens, built by Haxy
  as a structure: `{"kind": "transaction", "transaction"}` (the history at that transaction),
  `{"kind": "events", "transaction"}` (the events it wrote), `{"kind": "user", "name"}`,
  `{"kind": "commits", "tip", "base"}` (object ids; `base` may be null) or `{"kind": "branch" |
  "tag", "ref", "name"}` (a ref id, see Refs). `actions.undo` says whether this viewer may undo
  it, with the reason otherwise (`forbidden` for members; `unsupported` for the floor).
- **An undo names the history it was chosen from.** `transaction` is undone with every
  transaction after it, and `revision` must be the history's revision as the client read it:
  when the history has moved on (another undo, a push, any change, a clear), nothing is undone
  and the answer is `conflict` keyed by `revision` ("The undo history changed since you loaded
  it. Review it again before undoing."). The check and the undo hold the repository's write
  lock together. So a request repeated after a lost answer can't undo twice: the first one, if
  it landed, moved the history on. Both fields are required (`validation` on each otherwise; no
  id a client sends is ever added to, so ids past any history are refused, not overflowed);
  a transaction that isn't listed or can't be undone is `not_found` ("There is no transaction
  with this id that can be undone.").
- **Authorization is read again when the undo runs.** The undo runs only while its actor still
  owns the repository, under the lock role changes take (`evt.whileOwner`): an owner demoted
  after loading the history undoes nothing and is answered as their authorization now reads
  (`forbidden`, or `not_found` once they can't see the history), and a repository renamed or
  deleted meanwhile is `not_found`. Like every `/api/` write, `POST` honours `X-Haxy-Viewer`.
- The answer's `record` is the undo's own transaction (`action` `undo`, with a `what was
  undone` detail naming the transaction it undid), and its `actions.undo` is the restoration
  action: undoing the undo restores what it discarded (its record then says `what was
  redone`). The record and the answer's `revision` (the history right after the undo, which
  that reversal names) are read under the lock the undo ran in, so a clear landing just after
  can't give the undo's index to another transaction's record.
- Haxy's own undo URLs in Markdown open the Hub's undo pages (`hubPathForUndoPath` in
  `src/lib/undo.ts`): `/<owner>:<name>/undo[/<n>]` → `/repos/<owner>/<name>/undo[/<n>]`.

Haxy Hub shows an **Undo** section where Haxy lists it, at `/repos/<owner>/<name>/undo[/<id>]`
with `?cursor=` (`/repo/undo` in local mode says undo isn't available there). Each row shows
the transaction's action, time, description or linked details, and whether a later undo
discarded it; owners get "Undo this" (the newest) or "Undo this and all after it", which asks
for confirmation first. A completed undo shows its record and "Reverse this undo", even when
reading the history again fails; once Haxy refuses that reversal for lost ownership, it is shown
unavailable. A write refused because someone else is signed in now (another tab) keeps the
confirmation open with the session-change message and its Reload button. A lost
answer reads the history again and says what its newest transaction is now ("may or may not be
from this attempt"); the list then names the new history, so nothing chosen from the old one
can land. When that read fails too, no undo is offered until "Check again" gets an answer.
The routes keep the Vite proxy's 10 s timeout (an undo is one small transaction). Implemented
in `haxy/src/api/undo.zig` (unit tests in `haxy/src/test/api_undo.zig`), the shared operations
in `haxy/src/ui/Repo/Undo.zig` (tests in `haxy/src/test/undo.zig`), and Haxy Hub's
`src/lib/undo.ts` and `src/pages/undo/UndoSection.tsx`.

## Local mode: event sync

From issue [#27](issues/27-local-mode-sync.md). Local mode syncs its repository's events (the
`haxy/events` branch) with the configured remote, as the TUI's events tab does. One route,
`/api/v1/repo/sync`; a server answers it `unsupported` (405), since a server's repositories
take pushes instead. Other methods are `unsupported` with `Allow: GET, HEAD, POST`. Like every
`/api/` write the POST passes the shared write guard first. Both methods answer the same body:

```json
{
  "remote": "origin",
  "state": "in_sync",
  "running": false,
  "last": { "id": "9f2c41d07a3be815-3", "outcome": "failed", "finished_at": "2026-11-05T10:00:00Z",
            "failure": { "stage": "fetch", "message": "Couldn't fetch the remote's events (…). Nothing changed here, and your local changes are kept.", "remote_message": null } },
  "conflicts": { "issues": { "count": Count, "items": ThreadSummary[] }, "patches": { "count": Count } }
}
```

- `remote` is the remote a sync reaches (the first with fetched events, else the first
  configured; the TUI's choice), or null when none is configured. It is a display name:
  bytes that aren't UTF-8 become U+FFFD, as for repository paths (`api/path.zig` `display`).
  Sync takes no remote, so no encoded form is sent. (xit's config reader refuses a config
  that isn't UTF-8 today, so this is defensive.)
- `state` compares the events branch with the remote's **as last fetched**: `no_remote`,
  `not_fetched` (Haxy holds no copy of the remote's events: never fetched, or the remote has
  none), `in_sync`, or `sync_needed` (they differ). It says nothing about events the remote got since; only a sync fetches.
  The TUI's "sync needed!" is `sync_needed` with local events; everything else is its
  "nothing to sync".
- `running` says a sync is running in this Haxy process now (from Hub or the TUI). It and
  `last` are read together (`Events.syncSnapshot`): a sync that just finished is either still
  `running` or already `last`, never neither.
- `last` is the last sync this process finished (null since it started; a restart forgets
  it). `id` is opaque: a different id is a different sync, and no id is reused, by this
  process or a restarted one (a random per-process part plus a counter). `outcome` is `synced` or
  `failed`; a failure names the `stage` it stopped at, which says what it left behind, and
  `message` (Haxy's, user-facing, holding Haxy's error name but no paths) says so:
  `remote` (no remote or URL: nothing done), `fetch` (nothing changed here), `merge`
  (fetched but not merged: nothing pushed), `push` (the remote's events are merged here,
  ours aren't sent), `confirm` (pushed, but the remote couldn't be read again, so `state`
  may be stale). `remote_message` is what the remote itself reported, when it said why
  (cut to 1024 bytes; dropped if it isn't UTF-8). **Local events are never discarded.**
- `conflicts` counts the unresolved metadata conflicts the TUI's issues and patches tabs
  list (`ui.Repo.Issues.init`/`ui.Repo.Patches.init`, conflicts view), after this sync and
  any earlier ones, and names the first 20 conflicted issues (`ThreadSummary`, newest
  first). Hub links each to its issue page; patches have no Hub pages yet. #25 resolves
  them; until then a conflicted field keeps this repository's value. `conflicts` is null when
  Haxy can't read them, e.g. after a sync fetched events that can't be consumed (that sync's
  `last` is a `merge` failure); the rest of the answer still stands.
- **A status read never waits on a sync.** It reads refs, which no sync step holds, and
  brings the event db up to date first only when nothing holds the repository's database: a
  xit repository's fetch keeps the database locked for its whole network exchange, so while
  one runs the conflicts come from what is already committed.

**Running a sync.** `POST /api/v1/repo/sync` (no body) runs `ui.Repo.Events.runSync`, the
TUI's own sync: fetch `+refs/heads/haxy/events:refs/remotes/<remote>/haxy/events` (over the
repository's `core.sshCommand` or `ssh`, in batch mode, as the TUI does), merge with
`evt.mergeEvents` (the shared field-by-field merge rules), consume, push `haxy/events`, and
fetch again. Only the events branch and its remote ref move, so the code HEAD, its branch
and the work tree stay as they are. It answers **200 once the sync has finished**, with the
body above and `last` being this sync, whether it synced or failed: a failed sync is a
completed operation with an explicit failure, not an HTTP error. Errors keep their usual
meaning: `conflict` (409) when another sync is running in this process (one at a time, the
TUI's included; nothing ran), `internal` when Haxy itself failed (the repository couldn't be
opened). A git repository's merge holds the same in-process lock as #12's shared event
writes, so a concurrent issue write can't land between the merge's read and its write.

**Histories that began apart.** A repository whose events were written locally and on the
server before they ever synced has two event histories with no common ancestor. Haxy's
merge commit for them was written, but consuming it failed (`NoCommonAncestor`), which left
the events branch unreadable for every later read, on both sides once pushed. The shared
consume now merges such parents with no baseline, the case `mergeFields` already defines:
a record only one side has arrives whole, and a field the two sides set differently is a
conflict (this side's value stands). The fix is in `evt.consume`/`evt.merge`, so the TUI's
sync and a server consuming the pushed merge get it too.

**Why one request, not start-and-poll.** A sync is one bounded operation that Haxy runs to
completion whether or not anyone is waiting, so the request simply lasts as long as the sync,
with no client timeout (`timeouts.write` is null) and no proxy timeout: `vite.config.ts`
lists `^/api/v1/repo/sync` before the catch-all, beside `/api/v1/repos` (Timeouts). The
status read covers what an operation resource would: `running` and `last` (with its `id`)
settle a lost answer, without new storage or ids to keep. The remote's own transport bounds
the wait (ssh in batch mode fails rather than prompts; a remote that accepts the connection
and never answers holds the sync until it hangs up, as in the TUI).

**Unknown outcomes.** When the POST's answer is lost (timeout, `unreachable`, `internal`,
unreadable), Hub reads the status before offering another sync: `running` means it is still
going (Hub offers "Check again"); a `last.id` other than the one Hub saw before the click
means a sync finished since, and Hub shows that result; otherwise no sync finished (it may
never have reached Haxy, or Haxy restarted) and Hub offers a new sync. A sync is safe to
repeat: it fetches, merges and pushes whatever stands. A sync refused with `conflict`
because another one runs (another tab, the TUI) is waited for the same way: Hub says one is
running, and "Check again" shows the other sync's result once `last.id` changes and reads
the events again.

Implemented in `haxy/src/api/sync.zig` and `haxy/src/ui/Repo/Events.zig` (`runSync`,
`syncStatus`, `lastSync`, `syncRunning`; the TUI's `sync` and `Header.local` now use them);
unit tests in `haxy/src/test/sync.zig`. Haxy Hub: `src/lib/sync.ts` and
`src/pages/sync/SyncPanel.tsx`, shown above the events list in local mode.

## Attachments

From issue [#14](issues/14-attachments.md). A thread's attachments live under the thread's own
route, so every kind shares them (issues now; discussions in #16 and patches in #17 hook the same
module in with their own `Kind`, as for comments). `<thread>` is `…/issues/{id}`. The routes
resolve the repository as the viewer (one they can't read is `not_found` with the repository
message, whatever else the request names), answer as the issue routes do when the kind is off,
and answer `not_found` ("There is no issue with this id.") for a thread the id doesn't name or a
removed one.

| Route | Method | Body | Answer |
| --- | --- | --- | --- |
| `<thread>/attachments?name=&id=` | `POST` | the file's bytes | 201, the thread as `<thread>` reads it, the attachment listed |
| `<thread>/attachments/{attachment}` | `GET`/`HEAD` | — | the file's bytes (see Downloads) |
| `<thread>/attachments/{attachment}` | `DELETE` | — | the thread, without it |

Wrong methods are `unsupported` with `Allow` (`POST` on the list, `GET, HEAD, DELETE` on one).
Like every `/api/` write they pass the shared write guard first, and Haxy Hub binds each to the
viewer its page was loaded for.

**What a thread lists.** A thread's answer (`<thread>`, and every write's answer) carries
`"attachments": Attachment[]`, every live attachment oldest first (the TUI's list, which reads
the same records, `ui.Repo.Attachment.load`), and `"attachment_limits": {"max_bytes":
10485760, "max_name_bytes": 255}`. An `Attachment` is `{"id", "name", "content_type", "inline",
"actions": {"remove": Availability}}`: `name` is for display (bytes that aren't UTF-8 become
U+FFFD, as for paths; the stored name may come from a pushed event), `content_type` and `inline`
say how its download is served. `actions.attach` on the thread says whether the viewer may
upload. Removed attachments aren't listed, as in the TUI.

**Which threads take attachments.** Threads only, as in the TUI and Haxy's own upload route:
`evt.Attachment` hangs off a thread event and `evt.threadHolds` refuses anything else, so comments
have none (decision, #14; the spec's "threads and comments" reads as "supported threads and
comments", and Haxy supports none on comments). Haxy's TUI offers "add attachment" on a thread's
own page, not on drafts (patches, #17).

**One set of rules** (`haxy/src/attachment.zig`, used by the TUI's pages, Haxy's HTML upload and
download routes and these routes alike):

- *Uploads* (`attachment.checkUpload`): one file, the whole request body, with a declared
  `Content-Length` of 1 to 10 MiB (`evt.Attachment.max_size`) and a `name` that
  `evt.Attachment.nameValid` accepts (1–255 bytes, no `/`, `\` or control characters, not `.` or
  `..`). `name` is a query parameter, percent-encoded and decoded once (so any bytes travel),
  because the body is the file itself. The checks run before the body is read and before the
  repository is opened; refusals are `validation` beside `name` or `file` ("Name the file.", "The
  file is empty.", "Files can be up to 10 MB." with HTTP 413, a name refused, or no
  `Content-Length`).
- *Who may attach* is the thread's: `ui.authorizeUser` with the kind's tab role (`unauthenticated`,
  or `forbidden` for the role), then `ui.RepoSource.canModify` on the thread, its author or anyone
  with the write role (`forbidden`, "Only the issue's author and the repository's writers can
  attach files to it."), as Haxy's upload form has always required. `actions.attach` is the same
  decision.
- *Who may remove one* is the attachment's: the tab role, then `canModify` on the attachment, so
  its author or a writer (`forbidden`, "Only the attachment's author and the repository's writers
  can remove it."); each attachment's `actions.remove` says so. The TUI asks before removing, and
  so does Hub. Removing a removed (or unknown, or another thread's) attachment is `not_found`
  ("There is no attachment with this id on this issue."), whoever asks: that is checked before
  the viewer's rights to it, and nothing is written.
- Both writes go through `thread_write.attach` and `thread_write.remove`, which Haxy's HTML routes
  (`…/issue:<id>/attach`, `…/attachment:<id>/remove`) and the TUI's removal now use too. The
  thread being live and the id being free are checked where the write lands: inside a xit
  repository's write transaction (`evt.consumeGuarded`), under #12's events lock for a Git
  repository (local mode, which also catches up with its events branch first).

**Uploads are streamed and idempotent by id.** The body streams from the socket into the object
store as the event commit is written (`evt.Blob`); nothing buffers the file. `id`, when sent, is
the new attachment's event id (32 lowercase hex digits, `validation` on `id` otherwise); one any
event already has is `conflict` keyed by `id`, and nothing is attached. Haxy Hub chooses one per
chosen file and keeps it across retries, so after an unknown outcome it reads the thread: the
attachment listed means uploaded; otherwise the same upload can be sent again, and a `conflict` on
its own id means an earlier attempt landed. (A removal after an unknown outcome is settled by the
same read: gone means removed.) Removed attachments keep their ids, so a repeat refused on its id
may name one removed since: Hub reads the thread before saying it is attached, and otherwise says
it was removed and gives the file a new id. When an upload is refused before it is stored, Haxy
reads and drops a body whose declared length is at most 40 MiB so the client gets the answer
rather than a connection reset, and closes the connection for anything larger, for any chunked
body (whatever `Content-Length` it also claims, since the body reader follows the chunks), or for a
client waiting on `Expect: 100-continue`. A chunked upload is refused as having no length
(`attachment.declaredLength`), so the size an upload is stored with is always the one it declared. Neither the
client nor the Vite proxy puts a timeout on uploads or downloads (see Timeouts): the proxy lists
`^/api/v1/(repos/<owner>/<name>|repo)/(issues|discussions|patches)/<id>/attachments[/<id>]`
before its catch-all.

**Downloads** (`attachment.send`, which Haxy's own `/<owner>:<name>/attachment:<id>` URLs use
too):

- *Read check* (`attachment.readServable`): the viewer may read the repository (else
  `not_found` with the repository message, so a private repository's attachment answers a direct
  URL exactly as a missing repository does), the attachment exists, isn't removed, and hangs off a
  live thread (the route's own thread for the API; any live thread for Haxy's URL). Anything else
  is `not_found`, the same for an unknown id, a removed attachment and one whose thread was
  removed. Haxy's own URL now applies the thread check too, so a removed issue's files are no
  longer served there.
- The bytes stream from the object store with `Content-Length`; `HEAD` sends the headers only.
- `Content-Disposition` names the file (RFC 6266): `filename*=UTF-8''<percent-encoded bytes>`,
  with a `filename="…"` fallback in which every byte that isn't printable ASCII, and `"`, `\` and
  `;`, becomes `_`.
- *Content handling* (`attachment.handling`, by extension, case-insensitive): only the images on a
  safe list open in place (`inline`): PNG, JPEG, GIF and WebP, with their own types. A few other
  known types download (`attachment`) with their own type: PDF, plain text and logs, Markdown,
  CSV, JSON, ZIP, gzip, tar, MP4, WebM, MP3. Everything else, and on purpose anything a browser
  could run as script on this origin (HTML, SVG, JS, XML, …), downloads as
  `application/octet-stream`.
- Every download carries `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src
  'none'; style-src 'unsafe-inline'; sandbox` (even a document rendered from the bytes runs and
  loads nothing), and `Cache-Control: private, no-store` (who may read it can change).

**Haxy Hub.** A thread's page shows an Attachments section under the description when anything is
attached or the viewer may attach: each attachment links to its download route (images open in a
new tab, other files download under their own name; the bytes never pass through page state),
with a remove button when its `actions` allow, which asks first. The upload form (shown when
`actions.attach` allows) takes one file, checks it against `attachment_limits` before sending (an
empty file, a file over the size, a name over the bytes) and shows those and Haxy's own refusals
beside the file input; Haxy's check is the authority. An upload or removal answer updates only the
attachments on the page (`useThreadAnswers`; where no attachment or assignee answer applies, those
fields come from the latest read, never from a status answer that may predate them), and every
answer to a change on the issue page then reads the issue again in the background (the spec's
revalidation after successful mutations), so what another client changed meanwhile shows too;
the answer clock orders that read after the answer, and an outcome Haxy couldn't confirm holds the
controls until a read of the thread settles it ("Check again" when that read fails too).

Implemented in `haxy/src/api/attachments.zig` (hooked in by `api/issues.zig`), the shared rules in
`haxy/src/attachment.zig` and `haxy/src/thread_write.zig` (`attach`, `remove`); unit tests in
`haxy/src/test/attachment.zig`, `haxy/src/test/api_attachments.zig` and
`haxy/src/test/thread_write.zig`. Haxy Hub: `src/lib/attachments.ts` and
`src/components/attachments/ThreadAttachments.tsx`.
