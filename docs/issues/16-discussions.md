# #16 Discussions: list, search, create, edit, and remove

**Type:** AFK · **Status:** done · **User stories:** 49, 50, 51

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Using the shared thread components, readers browse, search and paginate recent discussions; authorized contributors create and edit discussions with descriptions and labels and remove them with confirmation. Comments, replies and permalinks work as for issues.

## Acceptance criteria

- [x] Discussion list/search/pagination works and lives in the URL
- [x] Create/edit/remove persist and show in the TUI
- [x] Disabled discussions and creation thresholds are enforced in UI and API
- [x] Comments on discussions work end to end
- [x] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [x] Existing Zig suites pass; frontend typecheck and build pass
- [x] Compatible `haxy-hub-impl` backend commit recorded (`0611b62` on `haxy-hub-impl`)

## Blocked by

- [#13 Comments: pagination, replies, permalinks, edit and remove](13-comments.md)

## Implementation notes

**Backend (`haxy`).**

- `src/api/discussions.zig` serves `…/discussions` (the recent list, `?search=&cursor=&page_size=`),
  `…/discussions/labels`, `…/discussions/{id}` and the writes `POST …/discussions`,
  `PATCH`/`DELETE …/discussions/{id}`, hooked into `routeApiRequest` with one line. Reads go
  through the TUI's discussions tab (`ui.Repo.Discussions.init`, which now takes the window
  size, as `Issues.init` does); comments are the shared comment routes with a `.discuss`
  `Kind`. Shapes: see "Threads: discussions" in `docs/api-conventions.md`.
- `thread_write.editIssue` became `thread_write.edit`, generic over issues and discussions.
  `evt.Discussion.update` (no lock, no revision) is replaced by `evt.Discussion.updateAt` with
  `contentRevision`, re-checked inside a xit repository's write transaction (a
  `consumeGuarded` guard) or under the Git events lock; the TUI's thread widget and
  `web.zig`'s HTML edit form now edit discussions through `thread_write.edit`, so they take
  the lock, catch up with a local events branch and check `canModify` like issue edits.
- `src/api/thread.zig` gained what the issue and discussion routes share: `authorize` (by
  kind), `bodyFields`, `searchParam`, `invalidField`, `unsupported`, `id_taken`,
  `stale_cursor`; `api/issues.zig` now uses them instead of its private copies.
  `listActions` says "Log in to open a discussion" (it said "an" for every kind).
- Unit tests in `src/test/thread_write.zig` (discussion edit with a stale revision,
  author/writer rules, removal, kind mismatch; concurrent edits of a Git repository's
  discussion) and `src/test/api_issues.zig` (discussion routes and messages).

**Haxy Hub.** `src/lib/discussions.ts` (the discussion shapes, `asThreadList`/`asThreadDetail`
adapters, `discussionPaths`), `src/pages/discussions/DiscussionsSection.tsx` (the
`discussionThreads` config). Hooks in shared files: `ThreadKind` gains `"discussions"`;
`listThreads`/`getThread`/`createThread`/`editThread` read discussion answers through the
adapters (and send no `status`); `hubPathForIssuePath` is now `hubPathForThreadPath` with a
`ThreadPaths` descriptor (issues keep their wrapper) and `hubPathForHaxyPath` has one more
line; `RepoPage` gets a section route, two routes and one branch; `ThreadDetail` hides the
status badge for a kind with one list; `ThreadNew` says "a"/"an" by noun; the events list
links discussion events (`eventTargetRoute`, "View discussion").

**Decisions.**

- Discussions keep the TUI's model: one list, "recent", most recently active first (a
  comment moves a discussion up); no status, assignees or conflicts, so their API shapes
  leave those out rather than sending fixed values, and the list has no `status` parameter
  or `counts`. Hub's shared pieces read the TUI's one list as the kind's only "status".
- An `assignee:` search term lists nothing for discussions (the TUI's behaviour), and
  `assignee_not_found` stays false.
- `…/discussions/{id}/status` answers `not_found` (there is no such route), not
  `unsupported`.
- The TUI and the HTML edit form keep editing discussions without a revision (as for
  issues), but now through the shared operation, under the lock.

**Tests.** `e2e/discussions-api.spec.ts` (6 tests, one for stale search cursors; list/search/labels/pages against the
TUI's tab, create/edit/remove with revisions and rights after a restart, thresholds and
turned off on every route, comments, local mode) and `e2e/discussions.spec.ts` (6 tests:
browse/search/page in the URL, open/edit/remove with confirmation, stale edit, thresholds
and turned off in the UI, comments/replies/permalinks, local mode and Haxy links);
`e2e/events.spec.ts` now expects discussion events to link to their page.

**Review fixes (Codex round 1).** A list cursor whose discussion no longer matches the
search's words (retitled between pages, or reused with another search) was answered with a
short or skipping page: `Discussions.init` checks only label membership, so the list now also
requires the cursor's own discussion in the window, as the issue list does (`stale_cursor`
otherwise; e2e "a cursor naming a discussion the search no longer lists…"). The discussions
search box no longer suggests `assignee:` (`ThreadConfig.searchPlaceholder`).

**Left for the merge.** Attachments (#14) and notifications (#22) on the shared thread page
reach discussions once their `config.kind`-keyed hooks are merged; their Zig handlers need a
`.discuss` `Kind` hooked in `api/discussions.zig` as the comments are.
