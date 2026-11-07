# #21 Fork browsing, a user's forks, deleted targets, and fork deletion

**Type:** AFK · **Status:** done · **User stories:** 14, 68, 77, 78

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Fork owners and authorized readers browse a fork's files, commits, diff and associated patch, and see a user's visible forks. When a fork's target repository has been deleted, explain which operations remain. Fork owners delete a fork with the existing password and typed-confirmation checks.

## Acceptance criteria

- [x] Fork files/commits/diff/patch links work
- [x] User's fork list respects visibility
- [x] A fork whose target was deleted shows the explanatory state
- [x] Fork deletion requires password + typed name and only the owner may do it
- [x] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [x] Existing Zig suites pass; frontend typecheck and build pass
- [x] Compatible `haxy-hub-impl` backend commit recorded (`4ddccd1` on `issue-21-fork-browsing`, cut from `haxy-hub-impl` at `a40ecdf`; not yet merged into `haxy-hub-impl`)

## Blocked by

- [#20 Fork-backed drafts: start a fork, manage drafts, and publish](20-fork-drafts-and-publish.md)

## Implementation notes

Routes, shapes and rules: "Forks" under "Threads: patches" in
[api-conventions.md](../api-conventions.md).

**Backend (`haxy`).**

- `ui.Fork` (the TUI's fork page) is split into `resolve` (the fork a route names, as the viewer
  may see it), `roleIn` (who sees a fork: its target's readers while the target uses patches, its
  forker alone once the target is gone) and `readContents` (the fork's patch-branch tip, its base,
  commit count and patch as the fork page shows it). `Fork.init` and the JSON API call them.
- `ui.User.readForks` (new) is the user page's forks window, with the repos window's `entries`
  bounds for the TUI and `readable` bounds for the API; it applies `ui.Fork.roleIn`.
- `src/api/forks.zig` (new, hooked into `routeApiRequest` before the repository routes):
  `GET/DELETE /api/v1/forks/{forker}/{name}/{id}`, and `…/files`, `…/branches`, `…/tags`,
  `…/find`, `…/commits[/{oid}[/diff]]` and `…/diff`, which run the repository routes' writers on
  the fork (`api_repo.writeFiles` is public). Deletion is `ui.Delete.perform` with a fork target,
  after the forker check. `api_commits.Context.base_oid` stops a fork's history at its base;
  `api_diff.writeRangeDiff` writes the fork's whole diff. `api_discovery` gains
  `GET /api/v1/users/{name}/forks`.
- A fork-backed patch's review reason now says its commits are reviewed in its fork.
- Unit tests: `src/test/api_forks.zig` (route parsing).

**Haxy Hub.** `src/lib/forks.ts` (API calls, routes, `hubPathForForkPath`); `src/pages/forks/`
(`ForkPage` with its routes, `ForkAbout`, `ForkDiff`, `DeleteFork`). `RepoLocator` gains a
`ForkLocator` sibling (`SourceLocator` in `src/lib/repo.ts`), which the files, refs, finder and
commits views and their libs now take, so a fork's files, commits and commit diffs are the
repository views. `UserPage` lists the user's forks; `PatchDetail` links a fork-backed patch's
source and review to its fork, and `DraftDetail` its draft's fork. `DeleteRepo`'s
`UnknownOutcome` is shared with the fork deletion.

**Tests.** `e2e/forks-api.spec.ts` (the forker's summary, files, commits, commit diff and fork
diff; visibility by target access for readers, anonymous viewers and the forker; the user's
forks paged; a deleted target; deletion's refusals and its result after a restart; a published
patch's fork; local mode) and `e2e/forks.spec.ts` (browsing from the draft page, the user page's
forks, the deleted-target explanation, deletion with the typed name and password and a reader's
refusal, a published patch's review link, Haxy's own fork links). The fixture
(`e2e/support/forks.ts`) pushes to a fork over SSH.

**Decisions** (conservative, for review):

- Fork visibility follows the TUI: readers of the target read a draft's fork (its files,
  commits and diff), but only the forker is linked to the draft, whose own routes stay private.
- Fork deletion needs `forker:name` typed, as Haxy's delete form asks, not the id.
- A fork's files and refs are the fork's own (`branch:patch` by default), so the ref picker and
  `…/branches` show the branches it was copied with, as the files of any repository would.
