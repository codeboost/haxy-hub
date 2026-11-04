# #11 Issues: lists, counts, filters, labels, and issue detail

**Type:** AFK · **Status:** done · **User stories:** 42, 43, 44, 52

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Separate open and closed issue lists with counts (exact vs lower bound) and pagination; search using Haxy's supported text, label and assignee filters; a label listing linking into filtered lists; and an issue detail route showing the full description independently of the list. Build the shared thread list/detail components that discussions and patches will reuse. Works in local mode.

## Acceptance criteria

- [x] Open/closed lists, counts and pagination match the TUI for the fixture
- [x] Text, label and assignee filters work and live in the URL
- [x] Label list links into the filtered issue list
- [x] Issue detail is deep-linkable and survives refresh
- [x] Disabled issue feature on a repo is reflected as unavailable
- [x] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [x] Existing Zig suites pass; frontend typecheck and build pass
- [x] Compatible `haxy-hub-impl` backend commit recorded (`2b79b3a` on `issue-11-issues-read`)

## Blocked by

- [#05 Repository overview and file browsing at the default branch](05-repo-overview-and-file-browsing.md)

## Implementation notes

Backend: `haxy/src/api/issues.zig` (the issue routes) on top of `haxy/src/api/thread.zig`
(what every thread kind will share: route parsing, repository access through
`ui.Repo.resolve`, and the JSON shapes); unit tests in `src/test/api_issues.zig`. Routes and
shapes are in [the conventions](../api-conventions.md#threads-issues).

Every answer comes from the TUI's own reader, `ui.Repo.Issues.init`, so lists, order,
counts (exact, or "1000+" when a search hits the cap), windows, the search syntax
(`search_thread.parseFilters`), assignee resolution and labels (`thread.loadLabels`) are
the TUI's by construction. To serve it, the shared code gained:

- `thread.loadWindow` takes the window size at run time (the TUI tabs pass their
  `page_size`), so `page_size` is honoured up to 100; a size of 0 reads only the count.
- `Issues.init` takes `WindowSizes` (`shown`, `others`): the TUI passes the defaults
  (20 each); the API reads its page into the listed status's window and only counts the
  other. Its cursor is the TUI's own window root: the next window's first issue id.
- `ui.Repo.tabViewer` is public, so the API reads as the same viewer the tab does.
- `api.Instant` (RFC 3339 UTC), `query.pageSize` (page size alone, for non-offset cursors),
  and `api_repo.not_found_repo` is public so hidden repos read exactly like missing ones.
- Label and assignee links carry the search they lead to, built by
  `search_thread.withFilter` as the TUI's links are, so Hub never parses a search.
- Local mode consumes the events branch before reading, as each TUI page build does.

Haxy Hub: `src/lib/threads.ts` (types, fetchers and absolute route helpers),
`src/components/thread/` (shared `ThreadSection`, `ThreadListView`, `ThreadLabelsView`,
`ThreadDetailView`, tabs, search form, filter summary, label/assignee links; a kind is a
`ThreadConfig`), and `src/pages/issues/IssuesSection.tsx`. Routes are
`/repos/<owner>/<name>/issues[/closed|/labels|/<id>]` and `/repo/issues[…]`, with
`?search=&cursor=`; the repository page shows them under its header, with Issues linked in
the sections. Descriptions render with the safe `Markdown` component.

Tests: `e2e/issues-api.spec.ts` (HTTP; lists, both counts, windows and filtered lists are
compared with the TUI's server-rendered issues tab for the demo fixture) and
`e2e/issues.spec.ts` (browser), seeded through Haxy's own HTML forms
(`e2e/support/issues.ts`) or the `zig build try` demo.

Review fixes (Codex):

- Haxy's issue URLs in Markdown map to the Hub issue pages (`hubPathForIssuePath`,
  one-line hook in `hubPathForHaxyPath`; `linkTarget`/`hubPathForHaxyPath` take a `local`
  flag, which issue pages pass in local mode; there `/` maps to `/repo`, and home, about
  and user paths, which local Haxy lacks, stay as written). Shapes are in the conventions.
- Issue routes no longer trust a cached sections list: they always ask Haxy, and show
  "turned off" when Haxy answers not found while the repository's sections (now read
  again on every navigation through `useResource`'s `revalidate` argument, keeping the
  shown data meanwhile) lack issues. `useResource` now also drops a superseded read that
  finishes late, which a same-key revalidation could otherwise be overwritten by.
- The labels view states its count, and says the listing is incomplete when Haxy
  stopped counting (`at_least`). Status tabs already show `at_least` counts as "N+".

Decisions (conservative where the spec is silent):

- A repository with issues turned off answers `not_found` on the issue routes, like the
  TUI's missing tab, with its own message (the repository is already visible). Hub shows
  "Issues are turned off for this repository." at its issue URLs and no Issues section.
- An assignee's email is sent only when no account holds it (it is then all there is to
  show); account-holding assignees are named, never emailed. Writers may need emails for
  unassignment in #15.
- A thread's own page ignores any list search (it is independent of the list), so its
  label and assignee links start new searches; the list's search survives via back.
- The labels list includes labels only closed issues use, as the TUI's does.

Not done here: comments (#13; `comment_count` only), action availability for writes
(#12), assignee-filter links beyond the detail and rows (#15). `api/repo.zig` still has
its own copy of the session/resolve glue that `thread.openRepo` now offers; switching it
over is left to avoid conflicting with #06.
