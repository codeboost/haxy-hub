# #10 Create a repository or copy an existing one

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 25, 26

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Registered users create a repository with name, description, visibility and supported hash format, or create one by copying an accessible existing repository using Haxy's existing copy option. On success they land on the new repository.

## Acceptance criteria

- [ ] Creating a repo with each supported hash format succeeds and is browseable after refresh and restart
- [ ] Name/validation errors appear by field with input preserved
- [ ] Copying an accessible repo produces a repo with its content; copying an inaccessible one is rejected
- [ ] Anonymous users and local mode cannot create repos (UI and API)
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#03 Session: login, logout, persistent session, and CSRF protection for writes](03-session-login-logout-csrf.md)
- [#05 Repository overview and file browsing at the default branch](05-repo-overview-and-file-browsing.md)
