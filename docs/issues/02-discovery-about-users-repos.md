# #02 Discovery: about page, user directory, and an owner's repositories

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 11, 12, 13, 100

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Anonymous visitors can read the forge's existing about information, search and paginate the user directory, open a user, and browse/search that owner's visible repositories. JSON endpoints reuse the existing queries behind the TUI's Home and User screens, honouring the same visibility rules (private repos never appear or leak via counts to unauthorized viewers). In local mode these server-only views are reported as unavailable rather than empty.

## Acceptance criteria

- [ ] About content matches what the TUI shows
- [ ] User directory search and pagination work and survive refresh/back/forward (filters and page in the URL)
- [ ] Owner page lists only repositories the viewer may read; a private repo is absent for anonymous and unrelated users (browser test + direct API check)
- [ ] Empty directory / no-match / no-repos states are distinct from load failures
- [ ] Local mode shows these views as unavailable
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#01 Foundation: acceptance harness, routed app shell, and API conventions](01-foundation-harness-and-app-shell.md)
