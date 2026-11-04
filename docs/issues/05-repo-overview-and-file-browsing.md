# #05 Repository overview and file browsing at the default branch

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 27, 28, 29, 31, 32, 33

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

A reader opens a repository and sees its identity, description, available sections, and backend-provided clone/contribution commands (using the server's public transport config, not the frontend port). They browse directories at the default branch, navigate to parent paths, and view files with line numbers, linkable lines and content windows for large files. README and supported Markdown render safely (no unsafe HTML or URL schemes). Empty file, binary file, truncated content, and empty repository have distinct states. Works in local mode against the repository Zig opened.

## Acceptance criteria

- [ ] Directory and file views at the default branch work for server and local mode fixtures
- [ ] Line links (`#L…` or equivalent) and content windows survive refresh
- [ ] README renders; a fixture with `<script>` / `javascript:` links does not execute
- [ ] Empty repo, empty file, binary file and truncated file each show their specific state
- [ ] Clone commands match the server's transport configuration and copy to clipboard
- [ ] Private repo returns not-found for unauthorized viewers without disclosing existence
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#02 Discovery: about page, user directory, and an owner's repositories](02-discovery-about-users-repos.md)
