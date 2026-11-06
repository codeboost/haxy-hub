# #33 Patch branch pickers beyond 1,000 branches

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 64, 72

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md) · follow-up from the [#18](18-patches-branch-write.md) review (merged with this open, by user decision)

## What to build

The New patch and patch edit forms choose source and target branches from pickers that list at most 1,000 branches, with no way to name a branch that isn't listed. In a repository with more branches, the rest can't be chosen from Hub, though Haxy itself accepts them. Let a contributor find any branch: a searchable picker over Haxy's branch list, a typed name checked against the repository, or both. Names that aren't valid UTF-8 must still travel as byte-exact ref ids.

## Acceptance criteria

- [ ] In a repository with more than 1,000 branches, any branch can be chosen as source or target, and the patch persists and shows in the TUI
- [ ] A typed or searched name that names no branch is refused with a field error before or by Haxy
- [ ] Branches whose names aren't valid UTF-8 remain selectable without ambiguity
- [ ] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [ ] Existing Zig suites pass; frontend typecheck, build and e2e pass; compatible `haxy-hub-impl` commit recorded

## Blocked by

- [#18 Branch-backed patches: create, edit, close/reopen, and remove](18-patches-branch-write.md)
