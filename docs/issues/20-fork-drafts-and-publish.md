# #20 Fork-backed drafts: start a fork, manage drafts, and publish

**Type:** AFK · **Status:** done · **User stories:** 65, 66, 67, 69

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Authorized server contributors start a patch using a new fork, list/open/edit/remove their drafts, and publish a draft under existing preconditions. Show the fork's push, clone and fetch/merge commands. Draft privacy follows existing rules. Server mode only.

## Acceptance criteria

- [x] Starting a fork creates a draft visible only to its owner (other users get not-found)
- [x] Draft edit/remove persist; publishing produces a repository patch
- [x] Publishing with unmet preconditions shows the backend reason
- [x] Fork Git commands match server transport configuration; pushing via SSH updates the draft
- [x] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [x] Existing Zig suites pass; frontend typecheck and build pass
- [x] Compatible `haxy-hub-impl` backend commit recorded (`9eec588` on `haxy-hub-impl`)

## Blocked by

- [#18 Branch-backed patches: create, edit, close/reopen, and remove](18-patches-branch-write.md)

## Implementation notes

Routes, shapes and rules: "Fork-backed drafts" under "Threads: patches" in
[api-conventions.md](../api-conventions.md).

**Backend (`haxy`).**

- `src/draft.zig` (new) holds every draft write the TUI, Haxy's HTML forms and the JSON API make:
  `start` (target must be a branch; an id the viewer's forks or the repository's events already
  have is `IdTaken`; then `fork.create`), `edit` (the viewer's own draft only, target must be a
  branch, optional revision), `remove` (the viewer's own live draft of this repository only, then
  `fork.remove`), `publish` (`pch.publish`, its `InvalidPatchDraft`/`InvalidPatch` named
  `NotFound`/`PatchIdTaken`), `read` (the viewer's draft through `Patches.loadDraftEntry`) and
  `ownsFork`. The TUI's `Patches.create` (fork case), `editDraft`, `removeDraft` and
  `publishDraft`, and `web.zig`'s `handleThreadNew` (fork case), `handleThreadEdit`,
  `handleRemove` and `handlePatchPublish` call them instead of their own copies. The TUI's draft
  removal now checks the draft is the viewer's live draft of this repository, as the HTML form
  did; the HTML edit form's target check moved into `draft.edit` (drafts) and
  `thread_write.edit` (published patches), whose refusals it already reported.
- `pch.editDraft` takes an optional `revision` (`evt.Patch.contentRevision`, `error.Stale` when
  it differs) and writes through `evt.consumeGuarded`, only while the draft is still as read; a
  push landing between the read and the write is read again (up to 3 times), never overwritten.
- `fork.create` refuses an id any event in the forker's user repo has (not only a fork's), as
  `error.IdTaken` (was `InvalidPatchDraft` for a fork's), up front and again inside the write that
  records the fork (`evt.consumeGuarded` with `thread_write.IdFree`, now public); the fork's
  directory is removed when that write refuses.
- `Patches.loadDraftWindow` names as `next_id` only a draft it could load, and the API checks a
  cursor names one of the viewer's drafts (`draft.isDraft`) rather than the window's first item,
  so the pages go on past a draft whose fork can't be read.
- `ui.widget.forkCommands` builds a fork's push, clone and merge commands from the host's SSH
  URL and prefix; the TUI's patch detail (`Patches.appendDetails`) now uses it.
- `Patches.loadDraftWindow` is public with a window size; `loadDraftEntry` reads the fork's
  branch and events from one snapshot. `thread_write.idUsedIn` is public.
- `src/api/patch_drafts.zig` (new, hooked into `routeApiRequest` before the patch routes):
  `GET/POST …/patches/drafts`, `GET/PATCH/DELETE …/patches/drafts/{id}`,
  `POST …/patches/drafts/{id}/publish`. `api_patches.readDetail` is public (the publish answer);
  patch answers gain `commands` for a fork-backed patch's fork. `api_thread.openRepo` sets the
  server's SSH URL and prefix on the session.
- Unit tests: `src/test/api_patch_drafts.zig` (fork commands, routes) and
  `src/test/event/admin.zig` (a fork can't take the id of another event of its forker's).

**Haxy Hub.** `src/lib/drafts.ts` (API calls, `draftHolds`, routes, `draftView`);
`src/pages/patches/drafts/` (`DraftsSection` with the list and `DraftsLink`, `DraftNew`,
`DraftDetail`, `DraftActions`, `DraftEdit`, `ForkCommands`, `StartForkLink`). Hooks:
`PatchesSection` routes `drafts/…` and shows "Your drafts" on list views;
`ThreadConfig.newAlternative` (rendered by `ThreadNew` beside the branch pickers) offers "Start
with a new fork"; `PatchDetail` shows a fork-backed patch's commands; `hubPathForPatchPath` maps
`<repo>/patches/drafts`; `vite.config.ts` exempts `…/patches/drafts` from the proxy timeout.

**Tests.** `e2e/patch-drafts-api.spec.ts` (privacy by every route, start/edit/remove/publish,
idempotent start and publish, the role refusal, exact commands against the overview's SSH URL,
an SSH push to the fork updating the draft and the published patch, paging past a draft whose
fork was deleted, local mode) and `e2e/patch-drafts.spec.ts` (the new patch page's fork path,
draft page commands, edit, publish, the list and removal, someone else's draft by URL, the role
refusal shown, lost answers on start and publish, a lost answer whose settling reads fail too
holding every write until "Check again", a stale edit reviewed in place, a lost start published
meanwhile). Seeds go through Haxy's own forms (`e2e/support/drafts.ts`).

**Decisions** (conservative, for review):

- Draft routes live under `…/patches/drafts`; a draft's `labels` are plain names (a draft is in no
  list a label search would filter).
- Every route on a draft answers `not_found` for anyone but its author before checking roles, so
  a draft's existence never leaks; the list for an anonymous viewer is `unauthenticated`.
- Edits, removal and publication need the patches tab's role at write time, as the TUI and HTML
  forms already did; a draft whose author lost the role stays readable and listed but can't be
  changed or published (actions say why).
- Publishing is idempotent (Haxy's `pch.publish` already was): a retry answers the patch.
- Published fork-backed patches show the fork's commands to every reader, as the TUI does.

