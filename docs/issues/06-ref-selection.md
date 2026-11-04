# #06 Branch/tag selection and viewing files at any ref, commit, or revision

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 6, 30, 35

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Add a ref picker with search and pagination over branches and tags, and route support for viewing the tree at a branch, tag, commit ID, or supported patch revision. Refs and paths are encoded correctly in URLs (slashes, spaces, Unicode, punctuation) and round-trip through refresh and back/forward. Existing Haxy link shapes map to equivalent routes; document the mapping.

## Acceptance criteria

- [ ] Branch/tag search and pagination work on a fixture with many refs
- [ ] Files view at branch, tag and commit ID; refs containing `/`, spaces and Unicode round-trip through the URL
- [ ] Back/forward/refresh preserve selected ref and path
- [ ] Route mapping from existing Haxy URLs is documented
- [ ] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck and build pass
- [ ] Compatible `haxy-hub-impl` backend commit recorded

## Blocked by

- [#05 Repository overview and file browsing at the default branch](05-repo-overview-and-file-browsing.md)
