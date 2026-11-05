# #27 Local mode: offline metadata edits and remote sync

**Type:** AFK · **Status:** done · **User stories:** 84, 85, 86

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

In local mode, users browse and edit supported metadata while disconnected from a remote, then synchronize events with the configured remote through Zig using existing merge rules. Failures (transport or conflicts) are reported accurately while retaining locally applied changes; the code HEAD is preserved. Sync is a long-running operation with explicit completion/failure results.

## Acceptance criteria

- [x] Local edits made with no remote reachable persist across restart
- [x] Sync against a fixture remote pushes and pulls events; results visible on both sides
- [x] Transport failure reports honestly and keeps local changes
- [x] Sync preserves the code HEAD and surfaces resulting metadata conflicts
- [x] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [x] Existing Zig suites pass; frontend typecheck and build pass
- [x] Compatible `haxy-hub-impl` backend commit recorded (`2d62950` on `issue-27-local-sync`)

## Blocked by

- [#12 Issues: create, edit, close/reopen, and remove](12-issues-write.md)
- [#24 Event browsing and transaction views](24-events-browsing.md)

## Implementation notes

**Backend (`haxy`).**

- The TUI's sync (`ui.Repo.Events.sync`) is now `Events.runSync`, which reports the step a
  failure stopped at (`remote`, `fetch`, `merge`, `push`, `confirm`), the error and the
  remote's own message, instead of a bare error or string. The fetch/merge/push/fetch
  sequence, refspecs, ssh command handling and merge rules (`evt.mergeEvents`) are
  unchanged; `Events.sync` keeps the TUI's old answer on top of it. Around it: one sync per
  process (`error.SyncInProgress`, TUI included), `syncRunning`, and `lastSync` (the last
  finished sync with an id, kept in memory). A git repository's merge and consume now hold
  #12's process-wide events lock (`thread_write.lockEvents`, made public), so an issue write
  can't land between the merge's read of the events branch and its write.
- `Events.syncStatus` is the TUI header's comparison of the events branch with the remote's
  fetched ref, as an enum (`no_remote`, `not_fetched`, `in_sync`, `sync_needed`);
  `Header.local` maps it to the same "sync needed!"/"nothing to sync" text as before.
- `src/api/sync.zig` serves `GET`/`HEAD`/`POST /api/v1/repo/sync` (hooked into
  `routeApiRequest`): the status, `running`, `last`, and the unresolved conflicts read by the
  TUI's issues and patches tabs (`Issues.init`/`Patches.init`, conflicts view).
- **Shared merge fix.** Event histories with no common ancestor (events written locally and
  on the server before the first sync) produced a merge commit that `evt.consume` couldn't
  read (`NoCommonAncestor`), leaving the events branch unreadable. `consume` now merges such
  parents with no baseline (`evt.merge` takes an optional baseline moment), which
  `mergeFields` already defines: one-sided records arrive whole, differing fields conflict.
- Unit tests: `src/test/sync.zig` (fetch failure keeps local events, no remote, status
  transitions, sync ids, unrelated histories, the route). The TUI's existing "sync creates
  missing event branches and preserves head" test still passes.

**Haxy Hub.** `src/lib/sync.ts` (`readSync`, `runSync`) and `src/pages/sync/SyncPanel.tsx`,
rendered above the events list in local mode (`EventsSection`, one branch; each finished
sync reads the events list again). The panel shows where the events stand, runs a sync
(held while it runs, double clicks ignored), shows the outcome in Haxy's words with the
remote's own message, and lists conflicted issues with links (patches by count). A lost
answer reads the status first: still running → "Check again"; a new `last.id` → that
result; none → a new sync is offered. `vite.config.ts` lists `^/api/v1/repo/sync` before the
catch-all, so the proxy has no timeout for it.

**Harness.** `launch.local()` takes `config` (git config entries such as
`remote.origin.url` and `core.sshCommand`) and can `restart()`; `sshUser` exposes its
`sshCommand` (options in ssh's space form, since xit's git config reader spaces out an `=`
inside a value), and its `ssh-keygen` has a timeout. `e2e/support/sync.ts` builds the
fixture: a real `launch.server({ ssh: true })` with `alice:shared`, local mode whose
`origin` is it over SSH, `main` pushed to it.

**Tests.** `e2e/sync-api.spec.ts`: offline edits persist across a restart with the remote
unreachable; a sync pushes and pulls (checked on the server through its API and pages, and
locally after a refresh) and leaves HEAD, its branch and the work tree alone; a stopped
server is a `fetch` failure that keeps local changes (also across a local restart), and a
later sync sends them; a push the remote refuses is a `push` failure with the remote's
words, after the remote's events were merged here; edits on both sides are reported as a
conflict; one sync at a time (409, `running`); the route's methods and modes; the proxy waits
past 10 s. `e2e/sync.spec.ts`: the same in the browser, plus a lost answer settled by a
status read.

**Codex review, round 1.**
- A sync that fetched events which can't be consumed records its `merge` failure, but the
  status read's own consume failed the same way, so POST and every GET answered `internal`.
  The conflicts are now read separately and are `null` when they can't be; the outcome
  stands (Zig test).
- A xit repository's fetch holds the database lock through the network exchange, and the
  status read's consume waited on it (indefinitely for a silent remote). The read now
  consumes only when `tryLock` gets the database (held across the consume), and otherwise
  reads what is committed (Zig test holding the lock on a xit repo with events).
- `running` and `last` were read apart, so a read overlapping a sync's end could say neither.
  Both now live under one mutex (`Events.syncSnapshot`); a sync stops running in the same
  step that records it.
- Hub after a 409: the panel now waits for the other sync like for a lost answer ("Check
  again"), then clears the warning, shows that sync's result and reads the events again
  (e2e test with a sync from another client held by a silent remote).

**Codex review, round 2.**
- `remote` goes through `api/path.zig` `display`, so a name that isn't UTF-8 can't make the
  JSON invalid (unit test on `remoteDisplay`; xit refuses such a config at open today).
- A sync's id is a random per-process incarnation plus the counter, so a restarted Haxy
  never reuses one and Hub's lost-answer check can't mistake a new sync for the old one
  (e2e test across `restart()`).
- The silent-remote tests wait (bounded, 15 s) for the sync's connection before dropping it
  (`silentRemote` in `e2e/support/sync.ts`), since `running` turns true before ssh connects.

**Decisions.**
- One request per sync rather than start-and-poll: Haxy runs a sync to completion either
  way, and `running`/`last` settle a lost answer without new storage (see the conventions
  doc).
- A failed sync answers 200 with `outcome: "failed"` and the step, not an error code: the
  operation completed with an explicit failure, the conventions have no code for a remote
  transport failure, and `internal` would hide the reason.
- `last` lives in memory; a restart forgets it, and Hub then says it has no record.
- Conflict counts are all unresolved conflicts after the sync, not only this sync's.
