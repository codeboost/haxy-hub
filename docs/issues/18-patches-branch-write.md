# #18 Branch-backed patches: create, edit, close/reopen, and remove

**Type:** AFK · **Status:** done · **User stories:** 64, 72, 73

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Authorized contributors create a patch from an existing source branch to a target branch, edit its metadata, close/reopen it, and remove it with its existing removal semantics. Available in both server and local mode.

## Acceptance criteria

- [x] Creating a patch from two branches persists and appears in the TUI
- [x] Edit, close/reopen and remove persist with correct confirmation
- [x] Unauthorized users are rejected at the API
- [x] Local mode can create and edit branch-backed patches
- [x] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [x] Existing Zig suites pass; frontend typecheck and build pass
- [x] Compatible `haxy-hub-impl` backend commit recorded (`8554ee6` on `haxy-hub-impl`)

## Blocked by

- [#12 Issues: create, edit, close/reopen, and remove](12-issues-write.md)
- [#17 Patches: lists, detail, and revision review](17-patches-read.md)

## Implementation notes

**Backend (`haxy`).**

- `src/thread_write.zig` now holds every branch-patch write the TUI, Haxy's HTML forms and the
  JSON API make:
  - `createBranchPatch` (new): opens a branch-backed patch under a given id, catching the local
    events branch up and holding the git events lock first, refusing a taken id
    (`error.IdTaken`), then `pch.writeBranchPatch`'s branch checks (`InvalidSourceBranch`,
    `InvalidTargetBranch`, `SameBranch`, `UnrelatedBranches`). The TUI's `Patches.create` (branch
    case) and `web.zig`'s `handleThreadNew` call it instead of `writeBranchPatch` directly.
  - `edit` takes `.patch` (with `Fields.target_branch`): the TUI's thread widget and
    `handleThreadEdit` call it instead of their own `canModify` + `evt.Patch.update` copies, so a
    patch edit now takes the git lock, catches up and checks `canModify` in one place.
  - `setStatus(evt.Patch)` and `remove` already served patches; both now reach
    `evt.Patch.updateAt`.
- `evt.Patch.contentRevision` (title, labels, description, target) and `evt.Patch.updateAt`
  (`update` with an optional revision; `update` is now `updateAt(null)`): a change that captures a
  revision (a new target, reopening a branch patch) goes through `writeBranchPatch` with the
  patch as read (`PatchOutOfDate` inside the transaction, reported as `Stale`); any other is
  rebuilt inside a xit transaction from the live patch (`Rebase`, as `evt.Issue.updateAt`). A
  merged patch's status or target is `PatchAlreadyMerged` up front.
- `pch.writeBranchPatchInTransaction` refuses a taken id for every new patch (its
  `expected_patch` is null only on creation), inside the transaction.
- `src/api/patches.zig`: `POST …/patches`, `PATCH`/`DELETE …/patches/{id}`,
  `PUT …/patches/{id}/status`; list `actions.create` from `api_thread.listActions`; patch answers
  gain `edit_revision` and `actions: {edit, set_status, remove, attach}` (`actions`, which makes a
  merged patch's `set_status` unavailable). Branches arrive as ref ids (`branchName`), refusals
  are typed field errors (`branchesError`). No routing change was needed: `web.zig` already
  sends every patch route to `api/patches.zig`.
- Unit tests: `src/test/thread_write.zig` (creation's branch checks and id, edits against stale
  revisions, status kept under edits and revision kept under status, retargeting, reopening,
  author/writer rules, removal; git and xit) and `src/test/api_patches.zig` (`branchName`,
  `edit_revision`, a merged patch's actions).

**Haxy Hub.** `src/lib/patchThread.ts` (`asPatchThread`, `patchOf`) reads a patch answer in the
shared thread shape; `src/lib/threads.ts` applies it in `detailOf` (now also for
`setThreadStatus`), gains optional `source`/`target` on `ThreadFields` and `target` on
`ThreadDetail`, and `holdsFields` compares the target. `src/lib/patches.ts` adds `edit_revision`
and the actions to `PatchDetail`, `getBranchChoices`, and Haxy's `patches/new` and
`patch:<id>/edit` links. `ThreadConfig.branches` turns on `BranchFields`
(`src/components/thread/BranchFields.tsx`) in `ThreadForm`/`ThreadNew`/`ThreadEdit`. The patch
config gains its status changes and branches; `PatchesSection` lets `new`/`<id>/edit` through to
the shared forms; `PatchDetail` shows `ThreadActions`, its answers ordered by the new
`useChangeAnswers` (in `useThreadAnswers.ts`) beside `useAttachmentAnswers`.

**Decisions** (see "Writing patches" in `api-conventions.md`):

- Branches are sent as ref ids (`branch:<encoded>`), not raw names, as the Refs rule requires for
  names that may not be UTF-8.
- A patch's edit revision is answered as `edit_revision` (its `revision` is the proposed patch
  revision, from #17); the `PATCH` body still names it `revision`, so the shared edit protocol
  and conflict field stay the issues'.
- A branch with nothing to propose is accepted (`no_changes`), as Haxy's own form accepts it.
- An edit's revision covers the target too; a retarget re-captures the revision, as in the TUI.
- A merged patch can't be closed, reopened or retargeted (`conflict`); its title, labels and
  description can be edited, and it can be removed, as in the TUI.
- Every new branch patch (TUI and HTML included) now refuses an id an event already has.
- Removal is Haxy's existing removal: the record is marked removed; branches, revisions,
  comments and attachments stay.

**Review round 1 (Codex).**

- A fork-backed patch's retarget was refused as `PatchOutOfDate` inside the xit transaction's
  rebuild: `Rebase` now applies a fork-backed patch's new target and clears its revision, as
  `updateAt` does outside it (test: `thread_write` "a fork-backed patch is retargeted…").
- Reopening a branch patch that changed between read and write passed `PatchOutOfDate` up as a
  500: `thread_write.setStatus` reports it as `error.Stale`, and the API answers `conflict`
  without a field (`statusWriteError`; tests: `evt.Patch.testing.after_read` interleaving, and
  the mapping in `api_patches`).
- The new-patch form picked its default target by display name, so a look-alike non-UTF-8
  branch could be chosen: it now picks one only by an exact, unique name (`defaultTargetOf`).
- Branch refusals with no field on screen (reopening after the source was deleted, or
  retargeting then) showed only "Check the highlighted fields.": `FailureMessage` lists the
  errors of fields not shown (`shown`, `labels`), in `ThreadActions` and `ThreadForm`.

**Tests.** `e2e/patches-write-api.spec.ts` (local-mode contract: create, idempotent id, edits,
stale revision, retarget, close/reopen, restart, removal, each checked in Haxy's own patches tab;
field errors and methods; server permissions by role and authorship, revoked role, restart;
the demo's merged patch) and `e2e/patches-write.spec.ts` (browser: open with branch pickers and
field errors, double clicks, edit and retarget, close/reopen, confirmed removal, Haxy's form
links, stale edit with the current version, lost answers for creation and status, readers and
anonymous viewers without controls, revoked role, the merged patch's actions).
