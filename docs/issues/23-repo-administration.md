# #23 Repository administration: settings, members, branches, and deletion

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 93, 94, 95, 96, 97, 98, 99

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Owners manage a repository from the browser, reusing the existing settings operations:

- Description, public/private visibility, and supported thread-creation role settings; hash format shown read-only.
- Paginated member listing with grant, revoke, promote and demote as supported, preserving the main-owner vs granted-owner distinction.
- Default branch selection; protect/unprotect branches.
- Delete the repository (main owner only) with password and typed-confirmation checks.

Permission changes take effect on the next request for affected users. Server mode only.

## Acceptance criteria

- [ ] Visibility, settings and thread-role changes apply to subsequent reads/writes by other users
- [ ] Member grant/revoke/promote/demote persist; a revoked writer's next write is rejected
- [ ] Default branch change affects the repo landing view; protected branch rejects force-push over SSH
- [ ] Only the main owner can delete; deletion requires password + typed name and the repo is gone after restart
- [ ] Granted owners cannot perform main-owner-only actions via direct API
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#10 Create a repository or copy an existing one](10-repo-create-and-copy.md)
