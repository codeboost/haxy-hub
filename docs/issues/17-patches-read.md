# #17 Patches: lists, detail, and revision review

**Type:** AFK · **Status:** done · **User stories:** 41, 63, 70, 71

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Separate open, closed and merged patch lists with search, labels, counts and pagination. Patch detail shows source, target, current revision, commit count, no-change state, and available mergeability. Links take the reviewer to that revision's files, commits and diff, using the backend's base-bounded revision semantics so unrelated history is excluded.

## Acceptance criteria

- [x] Open/closed/merged lists and filters match the TUI
- [x] Patch detail fields are correct for a branch-backed fixture, including a no-change patch
- [x] Revision commit list and diff exclude commits already on the target (base-bounded)
- [x] Revision links are deep-linkable and survive refresh
- [x] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [x] Existing Zig suites pass; frontend typecheck and build pass
- [x] Compatible `haxy-hub-impl` backend commit recorded (`a4242e6` on `haxy-hub-impl`)

## Blocked by

- [#08 Commit diffs with pagination and path filtering](08-commit-diffs.md)
- [#11 Issues: lists, counts, filters, labels, and issue detail](11-issues-read.md)

## Implementation notes

**Backend (`haxy`).**

- `src/ui/Repo/Patches.zig` (the TUI's patches tab) is the one reader of patches:
  - `init` takes `ReadOptions`: the window sizes (the shown status's, and the others', read
    only for their counts, as `Issues.init` does since #11), whether to read the viewer's
    drafts, and the snapshot to read from. It now reads the patch records, their revisions,
    the target branches' tips (`no_changes`) and the cached mergeability from **one**
    `latestMoment()`; before, the events, the target refs and the mergeability were each
    read at their own latest state. The TUI passes `.{}` (full windows, drafts, latest).
  - `review(entry)` is where a patch's code is reviewed: its revision (files and commits)
    and the revision whose diff to show (what landed, for a merged patch), its fork, or
    nothing. The TUI's `diffRoute` and `commitsRoute` now follow it, so the TUI and the API
    can't disagree about which revision a patch is reviewed at.
  - `mergeBlock(entry, host_kind)` says why the TUI offers no merge button (local mode, not
    open, a draft, fork gone, nothing pushed, a metadata conflict); `canMerge` is now
    `mergeBlock == null`.
- `src/ui/Repo/Diff.zig`: `renderRevisionAt` reads a patch revision and renders its diff
  (its base tree against its source tree) in one snapshot. The TUI's `diff/patchrev:<id>`
  page uses it (it used to read the revision and the files at two moments), and so does the
  API. `Files.readPatchRevAt` (moved from `api/refs.zig`, which re-exports it) reads a
  revision in a snapshot.
- `src/api/patches.zig` serves the lists, labels and patch detail through `Patches.init`,
  hooks the shared comment routes (`api/comments.zig`) in with the patch `Kind`, and
  dispatches `…/revisions/{id}/diff` to `api/diff.zig`'s new `writeRevisionDiff`, which
  shares the window parsing and JSON of the commit diff. In local mode each read first
  catches up the events and the branch patches (`evt.consume` + `pch.refreshBranches`, under
  the git events lock), as each TUI page build does. One line in `web.zig` routes it.
- Unit tests in `src/test/api_patches.zig`: the routes; a branch patch's detail and
  revision diff leave out the target's own later commit (git and xit); a no-change patch;
  one snapshot (a branch pushed after the snapshot doesn't show); `mergeBlock` and
  `review` over the TUI's cases.

**Haxy Hub.** `src/lib/patches.ts` has the patch types, `getPatch`, `getRevisionDiff`, the
review routes (`revisionFilesRoute`, `revisionCommitsRoute` at `?ref=revision:<id>`,
`revisionDiffRoute`) and `hubPathForPatchPath`. `src/pages/patches/` has `PatchesSection`
(lists, labels and comment pages through the shared `ThreadSection`, with `config.kind`
"patches"), `PatchDetail` (its own body from the shared parts: proposal, review links,
description, `ThreadComments`) and `RevisionDiff`. Shared files change only by hooks:
`ThreadKind` gains "patches"; `RepoPage` one `sectionRoutes` entry, two routes and one
section branch; `haxyPaths.ts` one line; `CommitDiff.tsx` exports its file rendering as
`DiffFiles`, which both diffs use.

**Decisions.**

- Read-only: the list's `actions.create` is `unsupported` until #18, every write method on
  the patch routes is `unsupported`, and Hub offers no "New patch". Comments on patches are
  read and written through the shared comment routes, as the TUI allows them.
- A patch's files and commits are reviewed at its submitted revision (`revision:<id>`),
  also once merged; its diff is that revision's, except for a merged patch, whose diff is
  what landed (the merge's own revision), as the TUI's "view diff" shows. For a
  squash-merged patch the TUI's "view commits (1)" lists the squashed commit; Hub lists
  the revision's own commits and says it landed as one squashed commit (`commit_count` is
  the revision's).
- `mergeability` is information only, offered exactly when the TUI shows its merge button;
  who may merge, and merging, are #19's.
- An open or closed fork-backed patch's revision lives in its fork, which Hub can't browse
  until #21, so its `review` is unavailable with that reason (the TUI links its fork
  pages). Drafts are left out of every list and answer `not_found` until #20.
- A local-mode read catches up branch patches with their branches, as the TUI's page
  builds do, so it may write a new revision event (under the events lock); without it Hub
  would show a revision the TUI had already replaced.
- The revision diff hangs off the repository (`…/revisions/{id}/diff`), like the
  `revision:` refs of the files and commits routes, and is readable by anyone who may read
  the repository; Hub's page for it lives in the patches section,
  `<hub repo>/patches/revisions/<id>/diff`, with `?patch=` for its way back.

**Tests.** `e2e/patches-api.spec.ts` (contract: detail fields of a branch-backed patch and a
no-change patch, base-bounded commits, files and diff windows, a moved branch's new
revision, lists/counts/search/labels/cursors against Haxy's own patches page, validation and
not-found, a pushed branch's commit count and mergeability on a server, the demo's
fork-backed and merged patches and their comments) and `e2e/patches.spec.ts` (browser:
list → patch → diff/commits/files, each reloaded; the no-change state; search, labels and
closed list; a comment posted and read back after a refresh and in Haxy's own page; Haxy
links translated; the demo's merged patch reviewed at what landed).
