# #12 Issues: create, edit, close/reopen, and remove

**Type:** AFK · **Status:** done · **User stories:** 45, 46, 47, 48

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Authorized contributors create issues with title, description and labels, edit supported fields, close and reopen, and remove with confirmation. All writes go through the existing event operations so the TUI sees the same result. Respect per-kind creation thresholds, authorship rules and role checks; works with local-mode event editing.

## Acceptance criteria

- [x] Created/edited/closed/removed issues persist across refresh and backend restart and are visible in the TUI
- [x] Readers and anonymous users cannot write (hidden controls and rejected direct API calls)
- [x] A writer whose role is revoked after page load gets a forbidden error, not a false success
- [x] Removal requires confirmation; double-submit is prevented
- [x] Local mode issue edits work without login
- [x] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [x] Existing Zig suites pass; frontend typecheck and build pass
- [x] Compatible `haxy-hub-impl` backend commit recorded (`6d04793` on `issue-12-issues-write`)

## Blocked by

- [#03 Session: login, logout, persistent session, and CSRF protection for writes](03-session-login-logout-csrf.md)
- [#11 Issues: lists, counts, filters, labels, and issue detail](11-issues-read.md)

## Implementation notes

**Backend (`haxy`).**

- `src/thread_write.zig` holds the thread writes the TUI, Haxy's HTML forms and the JSON API
  now share: `checkFields` (the kind's `fieldsValid`, reported as `required_title` or
  `invalid_labels`), `create` (an issue or discussion under a given id, refused with
  `IdTaken` inside the write's transaction when any event has the id), `setStatus`,
  `editIssue` (with an optional revision) and `remove` (a thread, or a comment, attachment
  or assignment under it). Each change checks `ui.RepoSource.canModify` (writer, or the
  event's author) itself. `web.zig`'s new/close/open/edit/remove handlers and the TUI
  thread widget's create/close/edit/remove paths call them instead of their own copies;
  patch drafts and branch patches keep their own paths.
- `evt.Issue.updateAt` is `update` with an optional revision, `evt.Issue.contentRevision`:
  the first 16 bytes of a SHA-256 over the length-prefixed title, labels and description,
  sent as 32 hex digits. Stale is `error.Stale`, re-checked inside a xit repository's
  transaction through `evt.consumeGuarded`. (A first version used the record's
  `updated_order`, which a merge can leave unchanged while it changes the fields; Codex
  review.)
- `updateAt` rebuilds the event inside a xit transaction from the issue as it is there
  (`Rebase` guard), so an edit never writes back a stale status and a status change never
  writes back stale fields; a git repository's `thread_write` operations hold one in-process
  lock across read, check and write (Codex review, round 2). Tests interleave a status change
  between an edit's read and write (`Issue.testing.after_read`), and race two threads'
  edits from one revision on a git repository.
- In local mode every shared write first consumes the events branch (`catchUp`), so a
  cloned or fetched branch nothing has read yet is seen by the id, author and revision
  checks (Codex review).
- `src/api/issues.zig` routes `POST …/issues`, `PATCH`/`DELETE …/issues/{id}` and
  `PUT …/issues/{id}/status`; it authorizes with `ui.authorizeUser` against the admin db as
  it is when the write runs (local mode: owner, `ui.localAuthor`). `src/api/thread.zig`
  adds the `/status` route, `actions` (`Availability`, `listActions`, `threadActions`),
  `revision` and `description_text` on a thread's answer, and the id/revision parsers.
- Unit tests: `src/test/thread_write.zig` (id taken, stale revision, author/writer rules,
  removal) and `src/test/api_issues.zig` (routes, actions, parsing, field errors).

**Haxy Hub.** `src/lib/threads.ts` gains the writes (`createThread`, `editThread`,
`setThreadStatus`, `removeThread`, `newThreadId`, `findThread`, `holdsFields`) and the
`new`/`<id>/edit` routes (Haxy's own `…/issues/new` and `…/issue:<id>/edit` links now open
them). `src/components/thread/` gains `ThreadForm` (shared fields), `ThreadNew`,
`ThreadEdit` and `ThreadActions` (edit, close/reopen, remove with an inline confirmation);
`ThreadList` shows "New issue" when `actions.create` is available. All are generic over the
thread kind (`ThreadConfig.statusChanges` names the status buttons). No change to
`RepoPage.tsx` was needed: the `issues/*` route already delegates.

**Decisions** (see "Threads: writing issues" in `api-conventions.md`):

- Creation is idempotent by a client-chosen event id rather than an idempotency-key store;
  an unknown outcome is settled by reading the issue by that id.
- Edits must name the revision (a digest of the editable fields) they replace; a stale one is `conflict` on `revision`, and
  Hub shows the current version before letting the user save over it. The TUI and HTML
  edit form keep last-writer-wins, as before.
- Status changes and removals carry no revision (setting a status is idempotent; removing a
  removed issue is `not_found`).
- Removing an already-removed thread through the shared `remove` is now `not_found` in
  every client (it used to re-emit the removal).
- Reads don't tell a removed issue from one never opened; Hub infers "opened, then removed"
  from a `conflict` on its own id followed by `not_found`, keeps the draft, and opens it
  under a new id only when asked.
- Hub ignores the later clicks of a double click on every action and submit button, so a
  status change answered between the two clicks can't be undone by the second.
- Write routes keep Vite's 10 s proxy timeout.

**Tests.** `e2e/issues-write-api.spec.ts` (HTTP contract, persistence after restart in
Haxy's own pages, permissions, revoked roles through the members form, stale edits through
Haxy's edit form, ids, methods, local mode) and `e2e/issues-write.spec.ts` (browser: create,
edit, close/reopen, confirmed removal, double clicks, hidden controls, revoked role, stale
edit, lost answers, local mode).
