# #06 Branch/tag selection and viewing files at any ref, commit, or revision

**Type:** AFK · **Status:** done · **User stories:** 6, 30, 35

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Add a ref picker with search and pagination over branches and tags, and route support for viewing the tree at a branch, tag, commit ID, or supported patch revision. Refs and paths are encoded correctly in URLs (slashes, spaces, Unicode, punctuation) and round-trip through refresh and back/forward. Existing Haxy link shapes map to equivalent routes; document the mapping.

## Acceptance criteria

- [x] Branch/tag search and pagination work on a fixture with many refs
- [x] Files view at branch, tag and commit ID; refs containing `/`, spaces and Unicode round-trip through the URL
- [x] Back/forward/refresh preserve selected ref and path
- [x] Route mapping from existing Haxy URLs is documented
- [x] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh (this slice only reads)
- [x] Existing Zig suites pass; frontend typecheck and build pass
- [x] Compatible `haxy-hub-impl` backend commit recorded (`88fa5aa` on `issue-06-refs`)

## Blocked by

- [#05 Repository overview and file browsing at the default branch](05-repo-overview-and-file-browsing.md)

## Implementation notes

Backend: `haxy/src/api/refs.zig` (unit tests in `src/test/api_refs.zig`), hooked into
`src/api/repo.zig`'s routes and handler, so a repo is resolved and hidden exactly as for
the overview and files. Shared with the TUI:

- `ui.Repo.Refs.readWindow`, extracted from the refs tab's `Refs.init`: one window of a
  kind's names from a prefix (the tab's search) and a start name (its window root), and
  the name the next window starts from. The tab now calls it too.
- `ui.ResolvedRefOrOid`, the files tab's resolution of a route's branch, tag or object
  (and of the default branch).
- `ui.Repo.Files.readPatchRev`, extracted from `Files.initPatchRev`: the patch revision
  an id names (none for a malformed, unknown or removed one); a revision is read at its
  head tree, as the TUI's `patchrev:` files route reads it.
- `api/query.zig`'s `Page.size`, extracted from `Page.parse`, reads `page_size` for a list
  whose cursor isn't an offset.

| Route | Response |
| --- | --- |
| `GET …/branches`, `GET …/tags` (`…` = `/api/v1/repos/{owner}/{name}` or `/api/v1/repo`) | a page of `{"name", "id"}` in byte order; `search` is a name prefix (the refs tab's search); default page 50 (the refs tab's window), `page_size` up to 100; count `unknown` (the TUI doesn't count refs) |
| `GET …/files?ref=<id>&…` | as in #05, read at the ref; `ref` is now `{"kind": "branch"\|"tag"\|"commit"\|"revision", "name", "id", "commit"}` |

- Ref ids (`branch:<name>`, `tag:<name>`, `commit:<oid>`, `revision:<id>`) follow the new
  "Refs" rule in `docs/api-conventions.md`: names percent-encoded byte for byte like paths,
  a separate U+FFFD display `name`, one `ref` parameter decoded exactly once. Without
  `ref` a view is at the default branch (so #05's URLs keep their meaning), and its `id`
  names that branch explicitly.
- `commit` is the commit shown: a tag is peeled to its commit (annotated tags included),
  a revision gives its source commit. A `commit:` id must be a full lowercase hex id of a
  commit object itself (not a tree, blob or annotated tag object, which the TUI's
  `object:` route reads through); only `tag:` reads through an annotated tag.
- The overview's `empty` and the default view's "no commits yet" describe the default
  branch only: when HEAD names an unborn branch, explicit refs, the branch and tag lists
  and Hub's views of them still work (Hub shows the empty state only without `?ref=`).
- Unknown branches, tags, commits and revisions (and an object that isn't a commit) are
  `not_found`; a `ref` that isn't `<kind>:<value>` is `validation` (`ref`). A private
  repo's refs are `not_found` for viewers who can't see it, like the repo itself.
- The list cursor is the hex of the name the next page starts from (the refs tab windows
  from a name, not an offset), so pages are stable under new refs and the cursor reads
  the same however a client escapes it; a cursor that isn't hex is `validation`.
- Every ref is readable once the repo is, so pages are counted in listed refs only, as
  the conventions require. In server mode Haxy's own `haxy/events` branch is listed, as
  the TUI's refs tab lists it.

Haxy Hub: `src/components/RepoRefs.tsx` (the ref bar and the branch/tag lists),
`src/lib/repo.ts` (`listRefs`, `RefId`, `canonicalRef`, `routeRef`, `refsRoute`, and a
`ref` argument to `getFiles` and `repoRoute`), `src/lib/haxyPaths.ts` (Haxy URLs), with
small hooks in `src/pages/RepoPage.tsx` (routes and the now-linked Refs section),
`src/components/RepoFiles.tsx` (every link keeps the URL's ref) and the shared `Pager`
(a base with its own query). Routes:

- `/repos/<owner>/<name>/branches` and `/tags` (`/repo/branches`, `/repo/tags` in local
  mode), with `?search=` and `?cursor=`, are the picker: the Refs section, mirroring the
  TUI's refs tab, each name leading to the files at that ref's root. The files view's
  ref bar names the ref (and the commit it shows) and links to the picker and, away from
  the default branch, back to it at the same path.
- `/repos/<owner>/<name>[/files/<path>]?ref=<id>[&line=<n>|&cursor=<c>]` views files at a
  ref. The id goes into the URL unchanged and is read back from the raw query string
  (`routeRef`), never from `URLSearchParams`, so names with `/`, spaces, Unicode, a
  literal `%41`/`%2F` and bytes that aren't UTF-8 round-trip through refresh and
  back/forward. Links are built as absolute routes by `repoRoute`.
- Haxy's own URLs in Markdown map to these routes (`hubPathForHaxyPath`; the full table
  is in `src/lib/haxyPaths.ts`): `/<owner>:<name>` and `…/files[/branch:|tag:|object:|patchrev:<v>][/line:<n>][/path:<p>]`
  become `/repos/<owner>/<name>[/files/<p>]?ref=…[&line=<n>]` (`object:` → `commit:`,
  `patchrev:` → `revision:`, names and paths re-encoded canonically), and
  `…/refs[/branch:|tag:<from>][/search:<s>]` becomes `…/branches` or `…/tags?search=<s>`
  (windows are dropped, as `start:` is). `find:` routes and other tabs have no Hub
  equivalent yet and stay unchanged. Local mode's identity-less routes (`/files/…`,
  `/refs/…`) correspond to the same shapes under `/repo` but aren't translated, since
  only the server's about page renders site links today.

Fixtures: `launch.local({ refs })` (`e2e/support/backend.ts`) adds branches and tags to
the git fixture, each optionally with its own commit or as an annotated tag, written into
`packed-refs` (raw bytes and all) or as loose ref files for names with spaces, which git's
own commands reject. Tests: `e2e/refs-api.spec.ts` (HTTP) and `e2e/refs.spec.ts`
(browser); a revision id is taken from Haxy's own patches page, since the API has no
patches yet (#17).

Decisions: one `ref` parameter of `<kind>:<value>` rather than separate `branch`/`tag`
parameters (one selection by construction; branch and tag names may coincide); the
picker is a page (the Refs section) rather than a dropdown, so its search and page live
in the URL like every list; choosing a ref opens its root, as the TUI's refs tab does.
