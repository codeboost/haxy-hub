# #21 Fork browsing, a user's forks, deleted targets, and fork deletion

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 14, 68, 77, 78

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Fork owners and authorized readers browse a fork's files, commits, diff and associated patch, and see a user's visible forks. When a fork's target repository has been deleted, explain which operations remain. Fork owners delete a fork with the existing password and typed-confirmation checks.

## Acceptance criteria

- [ ] Fork files/commits/diff/patch links work
- [ ] User's fork list respects visibility
- [ ] A fork whose target was deleted shows the explanatory state
- [ ] Fork deletion requires password + typed name and only the owner may do it
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#20 Fork-backed drafts: start a fork, manage drafts, and publish](20-fork-drafts-and-publish.md)
