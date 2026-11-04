# Haxy JSON API conventions

> **Status: Reviewed on 2026-11-04.** Decisions are listed at the end; change them only by
> updating this document.
> These rules, from issue [#01](issues/01-foundation-harness-and-app-shell.md), fix the
> shape of every later endpoint.

These conventions apply to every route under `/api/` served by Haxy (Zig) and consumed
by Haxy Hub (React) through Vite's proxy. They are implemented by:

- `haxy/src/api.zig` — `writeError`/`respondError`, `writePage`, `Count`, `writeStatus`,
  `respondJson`; unit tests in `haxy/src/test/api.zig`.
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
  path are encoded when they are part of one segment); JSON bodies carry them raw.
- Optional fields: an absent field and `null` mean the same thing ("no value"). Required
  fields are always present. Discriminated variants use a `kind` string field.

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
- **Open:** the Vite proxy's 10s `proxyTimeout` currently applies to every `/api/` request
  and must be raised or scoped per route before long-running endpoints land.

## Security notes

- State-changing routes (`POST`, `PUT`, `PATCH`, `DELETE`) will require a same-origin
  check and an explicit CSRF token; the strategy is decided with the login slice.
- Sessions stay in Haxy's HttpOnly cookie. Tokens, password hashes, local paths, signing
  configuration and SSH private material are never serialized.

## Decided in review (2026-11-04)

- `unsupported` is 405 both for wrong methods (with `Allow`) and for operations a host
  mode doesn't offer.
- `validation` is 400 for both malformed requests and invalid values; there is no
  separate 422.
- Timestamps are RFC 3339 UTC strings (see Timestamps), not integer Unix seconds.
- `field_errors` is an object keyed by field name, not an array.
- Pagination uses `cursor` and an optional client `page_size`.

## Known follow-up

- Vite's 10s `proxyTimeout` applies to every `/api/` request (see Timeouts). It must be
  raised or scoped per route before long-running endpoints (merge, sync, uploads) land.
