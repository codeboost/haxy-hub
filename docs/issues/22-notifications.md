# #22 Notifications: inbox, read state, subscribe and mute

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 90, 91, 92

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Registered users see a paginated inbox with unread indicators and links to threads. Read state and the unread count update when the user actually views the thread (an explicit acknowledgement, not prefetch). Users subscribe to or mute supported threads and see any subscription-capacity error. Server mode only.

## Acceptance criteria

- [ ] Activity by another user produces an inbox entry and unread count
- [ ] Opening the thread marks it read; hovering/prefetching does not
- [ ] Subscribe/mute persist; capacity limit error is shown
- [ ] Notifications for repos the user lost access to are not exposed
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#13 Comments: pagination, replies, permalinks, edit and remove](13-comments.md)
