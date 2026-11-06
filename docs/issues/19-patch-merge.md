# #19 Merge and squash-merge patches

**Type:** AFK · **Status:** done · **User stories:** 74, 75, 76

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Authorized maintainers merge an eligible patch using its source revision, or squash-merge it. The backend rechecks revision and target state at execution time; stale revisions, conflicts, and changed eligibility are reported without a false success. Merge is a long-running operation distinguishable from connectivity failure and never auto-retried. Server mode only.

## Acceptance criteria

- [x] Merge and squash-merge update the target branch and patch status, visible after refresh and in the TUI
- [x] A target branch that moved after page load produces a stale/conflict error and no success state
- [x] Non-maintainers cannot merge via direct API
- [x] Local mode shows merge as unavailable
- [x] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [x] Existing Zig suites pass; frontend typecheck and build pass
- [x] Compatible `haxy-hub-impl` backend commit recorded (`2731845` on `haxy-hub-impl`)

## Blocked by

- [#18 Branch-backed patches: create, edit, close/reopen, and remove](18-patches-branch-write.md)

## Implementation notes

- **Route.** `POST …/patches/{id}/merge` with `{method, revision, target_commit}`: the merge
  method and what the client reviewed. The answer is the merged patch; a refusal is `conflict`
  keyed by `revision` (the patch proposes another revision, or changed while merging),
  `target_commit` (the target moved or is gone) or `method` (the method conflicts, or Haxy hasn't
  checked it against the target's current tip); a patch Haxy no longer offers to merge answers with
  the reason its `mergeability` gives (`unsupported`: local mode, not open, nothing pushed, fork
  gone; `conflict`: fields awaiting resolution); anonymous viewers `unauthenticated`, readers
  `forbidden`. A patch's answer gains `target.commit` and `actions.merge`. See "Merging patches"
  in the conventions doc.
- **One merge operation.** `haxy/src/patch_merge.zig` `merge` is now what the TUI's merge
  button, Haxy's HTML merge form and the API call. It takes the method and what the client was
  shown, and answers with the merge done or a typed `Refusal`; who may merge is its `min_role`
  (writers and the owner, in a patches tab they may write to) for all three. The revision and the
  target's tip are checked inside the merge's own write transaction under the target's lock
  (`pch.MergeInput.reviewed`), before anything is merged. The TUI sends its loaded patch; Haxy's
  merge page posts its patch in the form's query and shows a refusal on the merge page
  (`refusalText`, through the form flash).
- **The squash form that "sometimes silently does nothing".** Haxy's merge form handler answered
  `MergeCheckUnavailable`, `PatchOutOfDate` and `PatchDataUnavailable` exactly as a merge: a 303
  to the patch's page, the patch still open and no message (the TUI likewise went back to the
  list without a word). Any merge that was refused for an unchecked target tip (a push to the
  target lands before its mergeability is checked again), a patch or source branch that changed
  between the page and the click, or an unreadable fork looked like a click that did nothing.
  Squash merges weren't otherwise broken: the reproductions tried (ahead and diverged targets,
  net-empty changes, merges of `main` into the source, comments and edits, a second patch merged
  first, and the browser's click and keyboard paths) all squash-merged. The shared operation now
  reports each of these as a refusal, and no client turns one into a success
  (`haxy/src/test/patch_merge.zig`; `e2e/patch-merge-api.spec.ts`'s form test).
- **Long-running.** The route is listed in `vite.config.ts` among the routes without a proxy
  timeout; Hub sends it with no client timeout and settles a lost answer by reading the patch
  again, never by retrying.
- **Hub.** `src/components/patches/PatchMerge.tsx` (Merge, Squash and merge, each confirmed
  inline) and `src/lib/patchMerge.ts`, hooked into `PatchDetail.tsx`. A confirmation sends what
  it was opened on, not what a background read brought since. A refusal shows with the patch read
  again; after a refusal or an unknown outcome, nothing but "Check the patch again" is offered
  until a read succeeds.
- **Decisions.** Ineligible merges answer with the availability reason's own code (`unsupported`,
  HTTP 405, for a patch closed or merged meanwhile), so the merge and the patch's `mergeability`
  never disagree. A merge Haxy hasn't checked against the target's current tip is refused
  (`conflict` on `method`) rather than run unchecked, as the TUI requires a clean check. Haxy's
  merge form now refuses a post without the page's revision and tip (an old page) rather than
  merging whatever the patch is by then.
- **Tests.** Zig: `haxy/src/test/patch_merge.zig`. e2e: `e2e/patch-merge-api.spec.ts`,
  `e2e/patch-merge.spec.ts` (helpers in `e2e/support/patchMerge.ts`).

