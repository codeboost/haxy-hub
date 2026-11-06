# #32 Sync: don't advance to events Haxy can't read

**Type:** AFK · **Status:** done · **User stories:** 84, 85, 86

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md) · follow-up from the [#27](27-local-mode-sync.md) review (merged with this open, by user decision)

## What to build

When a local-mode sync fetches an events branch holding a commit Haxy can't read as events (for example, invalid event JSON), the sync now reports a `merge` failure honestly. By then, though, it has already advanced the local events branch to the merge with that commit. Every later local read of the events (the issue list, an issue, the events view) then fails, and the next sync pushes the unreadable history on. The TUI's sync (`Events.runSync`, which the API shares) does the same.

Validate what was fetched before the local events branch moves: if the fetched history can't be consumed, leave the local branch where it was, report the failure with the step and a reason a user can act on, and keep local changes. The status endpoint's `conflicts: null` fallback (#27) should then only be needed for a database that was already broken.

## Acceptance criteria

- [x] A sync from a remote whose events branch holds an unreadable commit fails at `merge`, and the local events branch, local issues and the events view stay as they were before the sync
- [x] Nothing unreadable is pushed to the remote
- [x] The TUI's sync behaves the same (shared operation, no duplicated rule)
- [x] A Zig test reproduces the advance before the fix; Playwright covers the API and the sync panel's message
- [x] Existing Zig suites pass; frontend typecheck, build and e2e pass; compatible `haxy-hub-impl` commit recorded (`21c959b` on `haxy-hub-impl`)

## Blocked by

- [#27 Local mode: offline metadata edits and remote sync](27-local-mode-sync.md)

## Implementation notes

**Backend (`haxy`).**

- `evt.mergeAndConsumeEvents` (`src/event.zig`) merges the fetched events ref into
  `haxy/events` and consumes the result as one step. A xit repository does both in one
  transaction, so a failed consume leaves the branch and the event db as they were. A git
  repository's branch is a file beside its standalone event db: the db's exclusive lock (which
  every read of the db waits on) is held from before the branch moves until the merge is
  consumed, or the branch is moved back (removed, when there was none).
- `Events.runSync` (the TUI's sync and the API's) uses it instead of `evt.mergeEvents` and a
  separate consume. It reads the remote-tracking ref before fetching, and when the merge fails it
  puts that ref back (`evt.restoreFetchedRef`). Otherwise a repository with no events of its own
  would consume the fetched ones in their place (`evt.consume` falls back to the remote's ref),
  and `state` would describe events that were never merged. The sync stops at `merge`, before
  the push, so nothing unreadable is sent.
- The `merge` failure message now says what was left and what to do: nothing changed here,
  nothing was pushed, local changes are kept, and the remote's `haxy/events` branch may hold a
  commit Haxy can't read (not written by Haxy, or by a newer Haxy), to fix there before syncing
  again. Its buffer grew from 256 to 512 bytes.
- In a xit repository the merge's undo record (`haxy/merge-events`) now covers the events
  that the same transaction consumed. The undo view links them (`Undo.zig`), as it does for a push.
  Putting the remote's ref back writes a `haxy/restore-fetched-events` record, shown as
  "restore fetch".
- Unit tests in `src/test/sync.zig`:
  - A git repository's sync leaves the events branch, keeps reads and local changes, and pushes
    nothing (reproduced the advance before the fix).
  - The same for a xit repository (also red before the fix).
  - A first sync with no local events leaves none, and the conflicts still read.
  - `conflicts: null` still answers for an events branch that was already unreadable.
  - #27's test that expected `conflicts: null` after such a sync became the first-sync test.

**Haxy Hub.** No UI change: the sync panel shows Haxy's message. `e2e/support/sync.ts` gains
`gitRemoteFixture` and `commitOnRemoteEvents`. They set up local mode whose `origin` is a plain
git repository beside it in the sandbox, and commit to its `haxy/events` with git
(`commit-tree` + `update-ref`). A Haxy server can't stand in, since it refuses a push of events
it can't read.

**Tests.**
- `e2e/sync-api.spec.ts`: the sync fails at `merge` with the message. The status is as before
  (`sync_needed`, conflicts readable). The events branch, the issues, an issue, the events API
  and the TUI's issue list are unchanged. The remote still ends at the unreadable commit. Later
  syncs, including one after a restart, fail the same way.
- `e2e/sync.spec.ts`: the panel's alert names the failure and the fix, the conflicts are still
  read, the events list is read again unchanged, and both issues stay listed after a reload.

**Decisions.**
- A failed merge also puts the remote-tracking ref back where it was before the fetch. A
  `merge` failure then changes nothing here, like a `fetch` failure. The alternative left
  `state` and the fallback read pointing at events Haxy never merged.
- The message keeps Haxy's error name (for example `SyntaxError`) and doesn't try to classify
  the cause. A failure to write the merge is still reported at `merge`, with the same advice.
- The e2e remote is a plain git repository reached by path, not the SSH Haxy server, since a
  server can't hold such events.
