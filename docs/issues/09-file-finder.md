# #09 Indexed file finder

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 34

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Where Haxy has a file index for the selected ref, users can find files by name and jump to them. When the index is missing or the ref is unsupported, the UI says so rather than showing empty results.

## Acceptance criteria

- [ ] Finding a file on an indexed ref navigates to it at the same ref
- [ ] Missing index is reported distinctly from no matches
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#06 Branch/tag selection and viewing files at any ref, commit, or revision](06-ref-selection.md)
