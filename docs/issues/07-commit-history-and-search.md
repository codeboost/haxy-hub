# #07 Commit history, full commit messages, and commit search

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 36, 37, 38

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Paginated commit history for the selected ref showing author, committer when different, timestamp, message summary, merge indication and available statistics (marked unavailable when not computed). A commit's full message opens within existing size limits. Indexed commit search is offered where Haxy supports it and clearly unavailable otherwise.

## Acceptance criteria

- [ ] History paginates without loading the whole log; page state is in the URL
- [ ] Committer appears only when different from author; merges are marked
- [ ] Full message view respects existing limits and indicates truncation
- [ ] Commit search works on indexed refs and is shown as unavailable on unindexed ones
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#06 Branch/tag selection and viewing files at any ref, commit, or revision](06-ref-selection.md)
