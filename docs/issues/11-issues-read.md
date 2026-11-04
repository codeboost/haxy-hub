# #11 Issues: lists, counts, filters, labels, and issue detail

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 42, 43, 44, 52

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Separate open and closed issue lists with counts (exact vs lower bound) and pagination; search using Haxy's supported text, label and assignee filters; a label listing linking into filtered lists; and an issue detail route showing the full description independently of the list. Build the shared thread list/detail components that discussions and patches will reuse. Works in local mode.

## Acceptance criteria

- [ ] Open/closed lists, counts and pagination match the TUI for the fixture
- [ ] Text, label and assignee filters work and live in the URL
- [ ] Label list links into the filtered issue list
- [ ] Issue detail is deep-linkable and survives refresh
- [ ] Disabled issue feature on a repo is reflected as unavailable
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#05 Repository overview and file browsing at the default branch](05-repo-overview-and-file-browsing.md)
