# #08 Commit diffs with pagination and path filtering

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 39, 40

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

From a commit, the user can open its resulting tree (links into the files view at that commit) and a paginated diff showing added, removed and changed content with supported path filtering. Long lines and wide diffs scroll horizontally without overflowing the page layout.

## Acceptance criteria

- [ ] Diff windows paginate across multiple files/commits matching existing UI test behaviour
- [ ] Path filter narrows the diff and is preserved in the URL
- [ ] Binary and very large changes show placeholders rather than failing
- [ ] Narrow-screen diff scrolls within its container
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#07 Commit history, full commit messages, and commit search](07-commit-history-and-search.md)
