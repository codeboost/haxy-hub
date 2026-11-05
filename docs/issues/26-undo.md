# #26 Undo history and execution

**Type:** AFK · **Status:** done · **User stories:** 87, 88, 89

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Eligible server users browse paginated undo history with descriptions, timestamps and related details. The current main owner confirms and executes an available undo and sees the resulting undo record and any supported restoration action. Authorization is rechecked at execution. Local mode shows undo as unavailable.

## Acceptance criteria

- [x] History visible to eligible roles and hidden from others
- [x] Only a current owner can execute (any owner, as in the TUI: user decision, which amends "main owner"); ownership change after page load is enforced
- [x] Executing undo shows the resulting record and restoration action where allowed
- [x] Local mode rejects undo in UI and API
- [x] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [x] Existing Zig suites pass; frontend typecheck and build pass
- [x] Compatible `haxy-hub-impl` backend commit recorded (`8aa0992` on `issue-26-undo`)

## Blocked by

- [#24 Event browsing and transaction views](24-events-browsing.md)

## Implementation notes

Backend: `haxy/src/api/undo.zig` (one-line hook in `routeApiRequest`); unit tests in
`src/test/api_undo.zig`. Routes and shapes are in [the conventions](../api-conventions.md#undo):
`GET …/undo[/{id}]?cursor=&page_size=` and `POST …/undo` with `{transaction, revision}`,
under `/api/v1/repos/{owner}/{name}`; local mode answers `unsupported` everywhere.

Shared with the TUI (`haxy/src/ui/Repo/Undo.zig`), so Haxy and Hub follow one set of rules:

- **Who sees the history:** `ui.Repo.hasSection(.undo, …)` (xit repositories on a server,
  viewers who may write), checked before anything the request names.
- **Who may undo:** `RepoHandle.canUndo` (the repository's owners), and at execution
  `Undo.executeAsOwner`, which runs the undo inside `evt.whileOwner`, so ownership is read
  again under the lock role changes take. The TUI's own undo (`Undo.perform`) now runs
  through it too.
- **What can be undone:** `Undo.undoable(index, floor)`: above the history's floor (the
  initial state, or the history a copy carries). The TUI's detail button uses it too, so it
  no longer offers an undo of a copy's floor that execution would refuse.
- **What an undo record is:** `Undo.initWindow` (the TUI's reader, now with a window size and
  the floor in its result). Its detail buttons gained a structured `Target` (transaction,
  events, user, commits, branch or tag) beside the TUI's link, which the API sends instead
  of a Haxy URL.
- **What an undo does:** `Undo.execute(…, index, latest)` appends xit's undo record (as
  `Repo.undo` does) after checking, under the repository's write lock, that the history's
  `Undo.Revision` is still `latest` (`HistoryChanged` otherwise), and returns the undo's own
  index and the revision right after it. The TUI and Haxy's HTML form pass `null` (no check),
  as before. A revision is a digest of the database's generation (its file id, drawn anew by
  each compaction), the newest transaction (index, database slot, undo record) and the first
  transaction's record, so a history cleared by the `:refs/haxy/undo` push, whose new
  transactions reuse old indices, never matches a revision read before the clear, even when
  rebuilt the same way within one second (Codex review, rounds 1 and 2). Given a `RecordRead`,
  `execute` also returns the undo's own record, read under its lock (`initWindow` of one),
  which the API answers with instead of reading the history again by a reusable index.

Haxy Hub: `src/lib/undo.ts` (types, fetcher, the write, absolute routes, target routes and
`hubPathForUndoPath`, hooked into `hubPathForHaxyPath`) and `src/pages/undo/UndoSection.tsx`
(one `section === "undo"` branch and two routes in `RepoPage.tsx`). The history pages with
`?cursor=`; an undo asks for confirmation, sends the revision of the history it was chosen
from (bound to the viewer the page was loaded for), and shows the resulting record with
"Reverse this undo" where the viewer may. Refusals read the history again: a stale history
(`conflict`) and a lost ownership (`forbidden`/`not_found`) show the history as it is now. A
lost answer re-reads the history and says what its newest transaction is now; if that read
fails as well, nothing is offered until "Check again" succeeds (`useWrite`).

Tests: `e2e/undo-api.spec.ts` (HTTP: pages, record shape, visibility for owner, member,
reader and anonymous, the undo and its reversal verified by reading the issues again, a stale
revision, an owner demoted between loading and undoing in two sessions, a push's record and
its structured targets after real SSH pushes, validation, methods, local mode) and `e2e/undo.spec.ts` (browser: paging and refresh, confirm and cancel, the
result and its reversal, issues after refresh, Haxy undo links in Markdown, a member, a
granted owner demoted after the page loaded, a lost answer with and without a readable
history, local mode). Zig: `src/test/undo.zig` (the guarded undo, ownership at execution
including a demotion and a rename) and `src/test/api_undo.zig`.

Decisions (conservative where the spec is silent; the first two are for the user):

- **Granted owners may undo.** The spec says "main owner", but the TUI and Haxy's HTML form
  let any owner undo (`canUndo` is `role == .owner`), and this slice shares that rule rather
  than diverging from it. Haxy has no ownership transfer, so "ownership change after page
  load" is a granted owner's demotion or removal, which is enforced. Restricting execution to
  the main owner would be a change to the TUI's rule as well.
- **An undo names the history's revision** (a digest, not an index; the response also
  carries `newest`) and is refused when it moved on or was cleared. This is stricter than the TUI (which undoes whatever is newest), and makes a
  repeated request after a lost answer harmless, beyond Hub re-reading before a retry.
- Members see the history with every undo unavailable (`forbidden` reason), shown once as a
  notice; viewers without write access get `not_found`, as for events.
- Push details that name a commit range link to Hub's history from the range's tip (Hub has
  no base-bounded history yet); the API sends both ends.
- Haxy's HTML undo form (`web.zig` `handleUndo`) still authorizes and then undoes without the
  ownership re-check inside the lock; it is unchanged apart from the new `execute` signature.
