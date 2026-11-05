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
  catch-all, which have no proxy timeout: so far `/api/v1/repos` (repository creation,
  #10). A slow write route lands in that list along with its endpoint.

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
`/api/v1/repo/<kind>` in local mode. All are `GET`/`HEAD`. They resolve the repository
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
  | `<repo>/issue:<id>[/search:<s>][/start:<n>]`, `…/description`, `…/comment:<c>[/start:<n>]` | `<hub repo>/issues/<id>` |

  Forms (`…/new`, `…/edit`, `…/remove`, `…/resolve`) and `…/issues/conflicts` have no Hub
  page yet and stay as written. In local mode, `/` is the repository (`/repo`), and the
  home, about and user paths, which local Haxy doesn't have, stay as written. A comment permalink opens its issue until #13 adds
  comment pages.
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
  thread. Hub opens an issue's page for both shapes (a comment opens its issue until #13
  adds comment pages); discussions, patches and comments on them have no Hub page yet and
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

## Known follow-up

- Vite's 10s `proxyTimeout` is now scoped per route (see Timeouts); only repository
  creation is exempt so far. Long-running endpoints (merge, sync, uploads) must be added to
  the exempt list as they land.
