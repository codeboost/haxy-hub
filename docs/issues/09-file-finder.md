# #09 Indexed file finder

**Type:** AFK · **Status:** done · **User stories:** 34

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Where Haxy has a file index for the selected ref, users can find files by name and jump to them. When the index is missing or the ref is unsupported, the UI says so rather than showing empty results.

## Acceptance criteria

- [x] Finding a file on an indexed ref navigates to it at the same ref
- [x] Missing index is reported distinctly from no matches
- [x] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [x] Existing Zig suites pass; frontend typecheck and build pass
- [x] Compatible `haxy-hub-impl` backend commit recorded (`6c16031` on `issue-09-finder`)

## Blocked by

- [#06 Branch/tag selection and viewing files at any ref, commit, or revision](06-ref-selection.md)

## Implementation notes

Backend: `haxy/src/api/find.zig` (unit tests in `src/test/api_find.zig`), hooked into
`src/api/repo.zig`'s routes and handler as the `find` resource, so a repository and its
`ref` resolve, and hide, exactly as for the files view. Shared with the TUI, extracted from
the files tab's `Files.init` (which now calls them too):

- `ui.Repo.Files.indexable`: only an xit repository's branches can have a file index
  (`repository` for a git repository, `ref` for a tag, commit or patch revision).
- `ui.Repo.Files.fileIndex`: the view's index (`find.lookup`, the entry covering the
  branch's tip), `missing`, or `unsupported` with that reason.
- `ui.Repo.Files.findFiles`: `find.search` with the TUI's cap of 1000 (`max_list_entries`).

| Route | Response |
| --- | --- |
| `GET …/find?ref=<id>&search=<s>&cursor=&page_size=` (`…` = `/api/v1/repos/{owner}/{name}` or `/api/v1/repo`) | `{"ref", "kind": "indexed", "items": [{"name", "path"}], "page"}`, or `{"ref", "kind": "no_index", "reason": null}`, or `{"ref", "kind": "unsupported", "reason": "ref"\|"repository"}` |

- When an index exists: Haxy indexes every branch of an xit repository in the transaction
  of each push, patch merge or fork (`find.refreshInTransaction`), keyed by the tip it
  covers. A branch whose tip no entry covers has `no_index` (in practice `haxy/events`,
  which pushes skip, or a local xit repository Haxy never indexed). Git repositories (local
  mode) and tags, commits and revisions are never indexed.
- Matching is the TUI's: names starting with `search` byte for byte, ASCII case ignored,
  ordered by lowercased name then path, never trimmed. An empty search lists nothing and
  only reports the kind. Results stop at 1000 (`at_least` count, as the TUI's "(list
  truncated)"); the cursor pages within them; `page_size` defaults to 1000 and is capped
  at 100.

Frontend: `src/lib/finder.ts` (API client, `findRoute`, `hubPathForFindPath`) and
`src/components/finder/FileFinder.tsx`, routed as `/repos/<owner>/<name>/find` and
`/repo/find` (`section="find"` in `RepoPage`, under the Files tab). The ref bar has a
**Find a file** link at every ref. Ref, search and cursor live in the URL (the ref read
raw, never through `URLSearchParams`); results link with `repoRoute(repo, path, ref)`.
"No files match", "This branch has no file index", "Files can't be found by name at a
tag/commit/patch revision" and "This repository can't be searched by file name" are
separate states; none is an empty list. `SearchForm` gained an optional `base`, so a
search keeps the route's own `ref` (with `exact`, the term is sent as typed). Haxy's
`find:` URLs are translated in both modes (see the conventions doc).

Fixtures: the server repository is filled by a real SSH push (`e2e/support/push.ts`,
shared with #07, `launch.server({ ssh: true })`), which indexes it. Local mode is tested
both on a git repository (`unsupported`) and by serving a pushed server repository
directory in local mode (`serveLocally` in `e2e/support/finder.ts`), which carries the
index.

Decisions:
- The TUI shows the finder's search box only in server mode, but answers `find:` routes in
  local mode too; Hub offers the finder in both modes, as the issue asks.
- The ref bar's **Find a file** link shows at every ref (the finder page then says why a
  view isn't indexed), rather than hiding it where the TUI hides its search box, so the
  states are reported rather than silently absent.
- A Haxy `find:` URL naming a selected result (`…/path:<p>`) opens that file at the ref,
  not the result list.
- An empty search is allowed and lists nothing, so the page can learn whether the view is
  indexed before anyone types.

