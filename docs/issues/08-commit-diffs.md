# #08 Commit diffs with pagination and path filtering

**Type:** AFK · **Status:** done · **User stories:** 39, 40

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

From a commit, the user can open its resulting tree (links into the files view at that commit) and a paginated diff showing added, removed and changed content with supported path filtering. Long lines and wide diffs scroll horizontally without overflowing the page layout.

## Acceptance criteria

- [x] Diff windows paginate across multiple files/commits matching existing UI test behaviour
- [x] Path filter narrows the diff and is preserved in the URL
- [x] Binary and very large changes show placeholders rather than failing
- [x] Narrow-screen diff scrolls within its container
- [x] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [x] Existing Zig suites pass; frontend typecheck and build pass
- [x] Compatible `haxy-hub-impl` backend commit recorded (`16d6a18` on `issue-08-diffs`)

## Implementation notes

Backend: `haxy/src/api/diff.zig` (unit tests in `src/test/api_diff.zig`), dispatched from
`api/commits.zig`'s route (`…/commits/{id}/diff` is a third resource beside the list and
the commit, so the repository is opened and hidden exactly as for the commit). See
"Commit diffs" in `docs/api-conventions.md` for the route and shape.

| Route | Response |
| --- | --- |
| `GET …/commits/{id}/diff?path=&cursor=&page_size=` | `{commit, parent, path, items, truncated, page}`: a window of the commit's diff against its first parent |

Shared with the TUI's diff pane (`src/ui/Repo/Diff.zig`), so the TUI and the API read
through the same code:
- `Diff.renderAt` is the pane's `render` read at a caller's snapshot, with `Options`
  (`start`, `path`, `limit`). `render` now opens the latest moment and calls it, and the
  TUI calls it with its window of 10. The window's entries (one per hunk of a changed text
  file, one per added or removed file), the exact-path filter, the entry-index cursor and
  the million-cell bound are the pane's.
- A window entry (`Diff.Hunk`) now holds structured `lines` (prefix, old and new numbers,
  text) and a `kind` (`hunk`, `file`, `binary`, `too_large`); the TUI lays its text out
  from them as before (`hunkText`), with the same width rule.
- Placeholders, new in the shared operation and so in the TUI too: a changed file xit
  reads as binary was silently left out of the pane, and is now an entry labelled
  "binary"; a file past xit's `max_edit_count` failed the whole page with `DiffTooLarge`,
  and is now a "too large to diff" entry at a fixed index; a diff past
  `max_total_line_count` ends the window with `truncated` instead of failing, and the pane
  (terminal and web) shows an "incomplete" row saying the rest is too large to show
  (Codex review round 1). Hub likewise never shows "No changes" for a truncated empty
  window; it says "These changes are incomplete".
- Tests mirror the pane's own (`test/ui.zig` "diff windows span the net changes across
  commits": 11 added files make a window of 10 with more, then one; the filter gives one;
  a root commit adds what it starts with), plus new ones for binary and too-large
  placeholders and truncation (with lowered xit limits).

Decisions:
- **The diff is against the first parent**, which #07's `parent` already promised; a
  merge's diff spans what its other parents brought in, as the TUI's "view diff" does.
- **Added and removed files show only their path**, as in the TUI, with "View file"
  leading to their content (a removed file at the parent). The API doesn't send their
  lines.
- **The path filter is the TUI's: one exact file path**, not a directory prefix. Hub
  offers it through "Only this file" on each file and "Show all files"; it has no free-text
  filter box, since a typed name can't name a path that isn't UTF-8.
- **Cursor** is the next window's first entry index (the TUI's `start:`), sent as an
  opaque string. A cursor past the end is an empty window ("No more changes" in Hub).
- **"Very large"** follows xit's own limits: a file past its text limits (including a line
  of 10,000 bytes or more, such as minified JavaScript) is `binary`, which Hub explains;
  only edit-count and whole-diff limits are `too_large`/`truncated`. Those are tested in
  Zig with lowered limits only: an e2e fixture past a million edits would be too slow.
- **Line text** is valid UTF-8 (xit diffs only that) but still goes through the U+FFFD
  display rule, like every other byte string.

Haxy Hub:
- `src/lib/diff.ts`: the types, `getCommitDiff`, `commitDiffRoute`, `diffParams` (path
  and cursor from the raw `location.search`), `displayPath` and `entryFileRoute`.
- `src/pages/commits/CommitDiff.tsx`: the diff page (back to the commit, parent link,
  "Browse files at this commit", path filter status, each file's entries under its path
  with its status, "View file" and "Only this file", hunks as tables of numbered lines
  that scroll sideways in their own box, placeholders, truncation notice, pager).
- `src/lib/commits.ts`: `commitsView` recognises `<id>/diff`; `CommitsSection.tsx`
  renders it and the commit page links to it ("View changes"). No `RepoPage.tsx` change:
  `commits/*` already routes there.

e2e: `e2e/diff-api.spec.ts` (HTTP contract) and `e2e/diff.spec.ts` (browser, including a
360 px viewport where a long line scrolls inside its hunk and the page doesn't widen).
`e2e/support/history.ts`'s `addCommits` now takes binary file contents.

## Blocked by

- [#07 Commit history, full commit messages, and commit search](07-commit-history-and-search.md)
