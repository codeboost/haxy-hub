# #26 Undo history and execution

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 87, 88, 89

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Eligible server users browse paginated undo history with descriptions, timestamps and related details. The current main owner confirms and executes an available undo and sees the resulting undo record and any supported restoration action. Authorization is rechecked at execution. Local mode shows undo as unavailable.

## Acceptance criteria

- [ ] History visible to eligible roles and hidden from others
- [ ] Only the current main owner can execute; ownership change after page load is enforced
- [ ] Executing undo shows the resulting record and restoration action where allowed
- [ ] Local mode rejects undo in UI and API
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#24 Event browsing and transaction views](24-events-browsing.md)
