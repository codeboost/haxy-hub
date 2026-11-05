# #24 Event browsing and transaction views

**Type:** AFK · **Status:** done · **User stories:** 82, 83

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Repository users browse active and removed events with kind, author and available detail links, and eligible users view the events associated with a supported transaction. Works in both modes.

## Acceptance criteria

- [x] Active and removed event lists paginate and are distinct
- [x] Event detail links go to the affected thread/comment
- [x] Transaction view lists its events for eligible users and is denied otherwise
- [x] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [x] Existing Zig suites pass; frontend typecheck and build pass
- [x] Compatible `haxy-hub-impl` backend commit recorded (`e97d5fa` on `issue-24-events`)

## Blocked by

- [#11 Issues: lists, counts, filters, labels, and issue detail](11-issues-read.md)

## Implementation notes

Backend: `haxy/src/api/events.zig` (one-line hook in `routeApiRequest`); unit tests in
`src/test/api_events.zig`. Routes and shapes are in
[the conventions](../api-conventions.md#events-and-transactions):
`…/events?view=active|removed&cursor=&page_size=` and
`…/transactions/{id}/events?…`, where `…` is `/api/v1/repos/{owner}/{name}` or
`/api/v1/repo`.

Every answer comes from the TUI's own reader, `ui.Repo.Events.init`, so the two lists,
their order, exact counts, windows, the transaction view (read from the transaction's own
state, with the TUI's undo-floor and git-repository rules) and who may see events
(`ui.Repo.hasSection(.events, …)`, write access) are the TUI's by construction. To serve
it, the shared reader gained:

- `Events.Target` (`thread` or `comment`, with the thread kind and hex ids), built by the
  rule the TUI used for its links (active events only, in a thread kind the repository has
  turned on; attachments open their thread). The TUI now derives its `view_url` from it
  (`Target.url`), so Haxy and Hub link by one rule.
- `Item.created_timestamp`, read for the kinds whose records keep it (discussions,
  issues, comments, patches).
- `Events.init` takes `WindowSizes` (`shown`, `others`), as `Issues.init` does: the TUI
  passes the defaults (20 each); the API reads its page into the requested view and only
  counts the other. Its cursor is the TUI's own window root, `<kind>:<id>` of the next
  window's first event (opaque to clients).

The API answers `not_found` for viewers without write access ("Only people who may write
to this repository see its events."), checked before the transaction id, cursor or view
are looked at, and the TUI's own not-found rules for transactions ("There is no
transaction with this id whose events can be shown."). Local mode consumes the events
branch before reading, as each TUI page build does.

Haxy Hub: `src/lib/events.ts` (types, fetcher, absolute route helpers, the event-target
mapping, and `hubPathForEventsPath`, hooked into `hubPathForHaxyPath`) and
`src/pages/events/EventsSection.tsx`. Routes are `/repos/<owner>/<name>/events[/removed]`
and `…/events/transactions/<id>[/removed]` (and `/repo/events…` locally), with
`?cursor=`; Events is linked in the repository sections when Haxy lists it. Each row shows
the event's kind, author (linked to the account), creation time when known, and its
detail link: issues and comments on issues open the issue page (Hub has no comment pages
until #13); discussions and patches say Hub has no page for them yet.

Tests: `e2e/events-api.spec.ts` (HTTP; both lists, counts, windows and a transaction's
lists are compared with the TUI's server-rendered events tab, with more than one page of
events and removed events) and `e2e/events.spec.ts` (browser: paging, refresh, removed
list, detail links, transaction pages, Haxy event links in Markdown, ineligible viewers,
local mode), seeded through Haxy's own HTML forms (`e2e/support/issues.ts` and
`e2e/support/events.ts`: removing issues, commenting, opening a discussion; transaction ids
are read from the TUI's undo tab).

Decisions (conservative where the spec is silent):

- Viewers without write access get `not_found`, not `forbidden`: the TUI answers these
  pages not found, and the answer is the same whatever transaction is named, so it reveals
  nothing. Story 82 says "repository users"; the TUI limits the tab to writers, and the API
  shares that rule rather than widening it.
- Detail targets Hub can't render yet (discussions, patches and comments on them) are
  shown as unavailable rather than linked to Haxy, so they light up without a server
  change when #16/#17 add those pages.
- Transaction ids are history indices sent as decimal strings; the transaction view lives
  under Events in Hub (`…/events/transactions/<id>`), and the API under
  `…/transactions/{id}/events`, leaving `…/transactions` free for undo (#26).
- Haxy `event:<id>/kind:<kind>` window URLs open the first page of the active list (or of
  the transaction), as `start:` windows are dropped elsewhere.

Not done here: syncing events with a remote (#27; the TUI's sync header is not served),
undo (#26).

