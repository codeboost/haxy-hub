# #16 Discussions: list, search, create, edit, and remove

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 49, 50, 51

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Using the shared thread components, readers browse, search and paginate recent discussions; authorized contributors create and edit discussions with descriptions and labels and remove them with confirmation. Comments, replies and permalinks work as for issues.

## Acceptance criteria

- [ ] Discussion list/search/pagination works and lives in the URL
- [ ] Create/edit/remove persist and show in the TUI
- [ ] Disabled discussions and creation thresholds are enforced in UI and API
- [ ] Comments on discussions work end to end
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#13 Comments: pagination, replies, permalinks, edit and remove](13-comments.md)
