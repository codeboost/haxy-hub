# #07 Commit history, full commit messages, and commit search

**Type:** AFK · **Status:** done · **User stories:** 36, 37, 38

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Paginated commit history for the selected ref showing author, committer when different, timestamp, message summary, merge indication and available statistics (marked unavailable when not computed). A commit's full message opens within existing size limits. Indexed commit search is offered where Haxy supports it and clearly unavailable otherwise.

## Acceptance criteria

- [x] History paginates without loading the whole log; page state is in the URL
- [x] Committer appears only when different from author; merges are marked
- [x] Full message view respects existing limits and indicates truncation
- [x] Commit search works on indexed refs and is shown as unavailable on unindexed ones
- [x] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [x] Existing Zig suites pass; frontend typecheck and build pass
- [x] Compatible `haxy-hub-impl` backend commit recorded (`182e468` on `issue-07-history`)

## Implementation notes

Backend: `haxy/src/api/commits.zig` (unit tests in `src/test/api_commits.zig`), hooked into
`routeApiRequest` in `src/web.zig` with one line. The repository is opened and hidden
through `api/thread.zig`'s `openRepo` (`ui.Repo.resolve`), and refs resolve through
`api/refs.zig`. See "Commit history" in `docs/api-conventions.md` for the routes and shapes.

| Route | Response |
| --- | --- |
| `GET …/commits?ref=&search=&cursor=&page_size=` | `{ref, search, query, items, page}`: a page of the history at the ref, or of search results |
| `GET …/commits/{id}` | one commit with its whole message (up to 100 KiB) and `message_truncated` |

Shared with the TUI's commits tab (`src/ui/Repo/Commits.zig`), so the TUI and the API
read through the same code:
- `Commits.initWindow`: the tab's `init` with a page size; `init` now calls it with the
  tab's own 20. The log window, the keyed paging (`from`), the search and the counting
  are the tab's.
- `Commits.searchScope`, extracted from `init`: whether a commit index covers a log and
  where its search runs (the ref itself, or the default branch for an object view or a
  base-bounded list). `init` uses it too.
- `Commits.commitEntry` (now public) reads a commit's row: the message preview or the
  whole message up to `max_message_size`, the committer-differs rule, merge and stats.
  `Commits.firstLine`, `page_size` and `max_message_size` are public too.

Decisions:
- **Cursor.** It is the next page's first commit id, which is how the tab keys its pages.
  A cursor naming no commit of the repository is `validation`. A cursor whose commit has
  left the ref (after a force push) still pages from that commit, as the TUI does.
- **List items carry only the first line of the message.** The whole message is the
  commit route's. This keeps a page of 100 small, where 100 previews could be up to 10 MB.
- **Search** is offered only on a server, where the ref's tip has an index (built on
  push and patch merge for every branch and tag tip). Local mode reports `unsupported`,
  following the TUI, which has no search box there, even for a local xit repository that
  happens to have an index. For a `commit:` or `revision:` ref, `search.ref` names the
  default branch, where the TUI searches. A `search` sent where the history isn't
  searchable answers `unsupported` (405), never an empty page, so "unavailable" and
  "no matches" stay distinct.
- **Revision refs** list the source commit back to its base, the TUI's patch commits list.
  Their search runs on the default branch.
- **Statistics** are xit's per-commit stats, which xit writes when commits arrive by push.
  Elsewhere they are null (git repositories, and commits made in place), and Hub shows
  "Statistics unavailable". The count is `exact` (xit's first-parent depth) where xit has
  it, otherwise `unknown`.
- **One snapshot per request.** `writeList` takes one repository moment, and everything
  reads through it:
  - ref resolution (`api_refs.resolveAt`, `ui.ResolvedRefOrOid.initAt`);
  - the revision record (`api_refs.readPatchRevAt`) and the existence check of its
    source commit;
  - the log, statistics, count and search index (`Commits.Pinned` carries the moment and
    the resolved commit into `initWindow`).
  `resolve` and `init` now delegate to their `…At` forms. The TUI's commits tab reads one
  moment too.
- **Section tabs keep the ref.** The Files and Commits tabs keep the URL's `?ref=`
  (through `Header`/`Sections` in `RepoPage.tsx`), as the TUI's tabs share one ref, and
  as the ref bar's "History" link already did. #06 didn't specify the tabs; its ref bar
  still has "Default branch" for going back. A commit page's id is read from the router's
  splat, so `%61lice` or `COMMITS` spellings still open it.
- **Squash-merged revisions.** When a fork is squash-merged, the revision is kept
  without its source commit. Its history then answers `history.available: false`
  ("unsupported", with a reason), and Hub shows "This history is unavailable"; it is
  never presented as an empty history. Its files still read (the squashed commit's
  tree). The Zig test is Haxy's own squash merge (`pch.mergeAndRemoveFork` in
  `test/event/patch.zig`'s "patch lifecycle"), which checks both merge kinds. I couldn't
  reach it in e2e: the demo's fork patches either have no cached merge check or
  conflict when squashed, so the browser state isn't tested end to end.
- Haxy's SSH push refuses ref names that aren't UTF-8 ("InvalidUtf8"), and git refuses
  spaces. On a server, awkward names are therefore tested with `/`, Unicode and `%`.
  Spaces, a literal `%41`/`%2F` and non-UTF-8 bytes are tested in local mode, where
  refs are written directly.

Haxy Hub:
- `src/lib/commits.ts`: the types, `listCommits`/`getCommit`, the routes
  `commitsRoute`/`commitRoute`/`commitsView`, and `hubPathForCommitPath`, hooked into
  `hubPathForHaxyPath` with one line.
- `src/pages/commits/CommitsSection.tsx`: the history (ref bar, search or "unavailable"
  status, count, rows with author, committer when different, date, merge badge and
  statistics or "Statistics unavailable", pager) and the commit page (metadata, parent,
  statistics, "Browse files at this commit", truncation notice, whole message).
- `RepoPage.tsx`: the Commits section link, one `section === "commits"` branch, and two
  routes (`repo/commits/*`, `repos/:owner/:name/commits/*`).
- The files view's ref bar (`RepoRefs.tsx`) has a "History" link that keeps the ref.
- The ref and every path are read from the raw `location`. Links are built absolute by
  the helpers, and refs round-trip through refresh and back/forward (tested with `/`,
  spaces, Unicode, literal `%41`/`%2F` and a Latin-1 byte).

e2e: `e2e/history-api.spec.ts` (HTTP contract) and `e2e/history.spec.ts` (browser).
- Fixtures: `launch.server({ ssh: true })`, `pushRepo` in `e2e/support/push.ts` (shared
  with #09), and `buildRepo`, extracted from `startLocal` in `e2e/support/backend.ts`.
  `e2e/support/history.ts` adds commits with chosen authors, committers, dates and merges.
- The indexed fixture is seeded by pushing over SSH, Haxy's own operation.
- `refs.spec.ts`: Haxy's `/commits` link now has a Hub page.

## Blocked by

- [#06 Branch/tag selection and viewing files at any ref, commit, or revision](06-ref-selection.md)
