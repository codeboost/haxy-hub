# #25 Metadata conflicts: find, inspect, and resolve

**Type:** AFK · **Status:** done · **User stories:** 79, 80, 81

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Collaborators find issues and patches with unresolved metadata conflicts, inspect both sides and their authors for conflicting fields and description chunks, and submit supported per-field and description resolutions recorded as events. Metadata conflicts are presented separately from code mergeability and never as a source-code conflict editor.

## Acceptance criteria

- [x] A fixture with divergent metadata edits lists the conflicted thread
- [x] Both sides and authors are displayed per field and description chunk
- [x] Resolution persists through normal event processing and clears the conflict after refresh
- [x] Patch code merge conflicts are not shown in this UI
- [x] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [x] Existing Zig suites pass; frontend typecheck and build pass
- [x] Compatible `haxy-hub-impl` backend commit recorded (`72abc69` on `haxy-hub-impl`)

## Blocked by

- [#18 Branch-backed patches: create, edit, close/reopen, and remove](18-patches-branch-write.md)

## Implementation notes

**Backend (`haxy`).**

- `src/thread_write.zig` `resolve` (new) is the one resolution operation: the TUI's resolve form
  (`ui.widget.thread` `submitResolution`) and Haxy's HTML resolve route (`web.zig`
  `handleThreadResolve`, whose private `updateThread` is gone) now call it instead of
  `evt.Issue.update`/`evt.Patch.update` directly. It refuses anyone below the write role
  (`error.Forbidden`), takes #12's git events lock, catches a local events branch up, and writes
  one event through `updateAt(.resolve)`, so it syncs like any other and settles the conflict
  wherever it is consumed.
- `evt.Issue.Resolve` and `evt.Patch.Resolve` gain an optional `revision`
  (`evt.ConflictRevision`, a digest of the conflicted fields, the live record, their record and
  the base, `evt.conflictRevision`). With one, `resolveFields` refuses a conflict that isn't at it
  any more, or is gone (`error.Stale`), and a xit repository checks again inside the write's
  transaction (`evt.ConflictCheck` through `consumeGuarded`). Without one (the TUI and HTML
  forms) nothing changes. `evt.conflictRevisionAt`/`readConflictRevision` read it by id.
- `ui.widget.thread.readConflict` stores the revision in the TUI's `Conflict` data
  (`conflict_revision`), and the patches' `Conflict` keeps both whole patches (`events`), so the
  API answers the TUI's own read, from one snapshot.
- `src/api/conflicts.zig` (routes, one hook in `routeApiRequest`) and
  `src/api/conflict_shapes.zig` (answer shapes, request parsing and checking against what the
  conflict offers). `api/patches.zig`'s `readDetail` and `catchUp` are now `pub`.
- Unit tests: `src/test/conflicts.zig` (real conflicts from a merge of event histories:
  resolution, stale and settled revisions, a conflict settled between the read and the write,
  writers only, no revision) and `src/test/api_conflicts.zig` (request parsing, what a
  resolution may settle, routes).

**Haxy Hub.** `src/lib/conflicts.ts` (API calls, routes, `conflictView`,
`hubPathForConflictPath` hooked into `hubPathForHaxyPath`, and the pure `initialChoices` /
`resolutionOf`); `src/pages/conflicts/` (`ConflictsSection`, `ConflictPage`, `ResolveForm`,
`ConflictFields`, `ConflictBanner`). Hooks: `IssuesSection` and `PatchesSection` hand
`…/conflicts` and `…/<id>/conflict` to `ConflictsSection`; `ThreadConfig.conflicts` adds the
Conflicts tab in `ThreadTabs`; `ThreadDetail` and `PatchDetail` render `ConflictBanner`, which
links to the resolution.

e2e: `e2e/conflicts-api.spec.ts` and `e2e/conflicts.spec.ts`, with conflicts from real syncs
between local mode and a server (`e2e/support/conflicts.ts`: `divergedIssue`, `divergedPatch`),
checked after a reload, through the API and, after the next sync, on the other host; a patch
whose code conflicts with its target is shown not to be listed.

Decisions:

- Only writers (write role, plus the kind's tab role) may resolve, as the TUI's form asks; a
  thread's author who is only a reader can't, unlike edits.
- The resolution request is checked against the conflict: only conflicted fields, exactly one
  text per conflicting chunk, and `theirs` only for conflicted choice fields; omitted fields keep
  this host's value (the TUI's prefill).
- The TUI and HTML resolve forms still send no revision (like their edit forms, #12).
- The Conflicts tab is always shown on issues and patches (the TUI shows it only while there are
  conflicts): the list answers carry no conflict count, and adding one would change their
  `counts`, which existing tests compare whole with the TUI's.
- An issue's status conflict (possible only between histories that began apart) isn't offered,
  as in the TUI; a resolution keeps this host's status.
- A patch resolution that takes their target captures a revision through
  `pch.writeBranchPatchGuarded` (new; `writeBranchPatch` is it without a guard), which checks
  the conflict revision inside the capture's transaction (in a git repository, under the lock).
  Its branch refusals (a deleted source, a target gone or unrelated) answer as the patch API's
  `branchesError` field errors on `source`/`target`, which Hub lists by label.
