# #24 Event browsing and transaction views

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 82, 83

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Repository users browse active and removed events with kind, author and available detail links, and eligible users view the events associated with a supported transaction. Works in both modes.

## Acceptance criteria

- [ ] Active and removed event lists paginate and are distinct
- [ ] Event detail links go to the affected thread/comment
- [ ] Transaction view lists its events for eligible users and is denied otherwise
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#11 Issues: lists, counts, filters, labels, and issue detail](11-issues-read.md)
