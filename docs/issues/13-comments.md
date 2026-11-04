# #13 Comments: pagination, replies, permalinks, edit and remove

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 53, 54, 55, 56

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Thread readers see paginated comments with author and reply context. Contributors comment or reply to a specific comment, edit, and remove with confirmation, within Haxy's rules. Comment permalinks show the selected comment and supported reply context. Implemented as shared components usable for issues, discussions and patches.

## Acceptance criteria

- [ ] Comment and reply persist and appear in the TUI
- [ ] Permalink to a comment on a later page opens to that comment after refresh
- [ ] Non-authors without moderation rights cannot edit/remove (API enforced)
- [ ] Pagination state is preserved in the URL
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#12 Issues: create, edit, close/reopen, and remove](12-issues-write.md)
