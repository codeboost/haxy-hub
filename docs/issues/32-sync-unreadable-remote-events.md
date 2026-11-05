# #32 Sync: don't advance to events Haxy can't read

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 84, 85, 86

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md) · follow-up from the [#27](27-local-mode-sync.md) review (merged with this open, by user decision)

## What to build

When a local-mode sync fetches an events branch holding a commit Haxy can't read as events (for example, invalid event JSON), the sync now reports a `merge` failure honestly. By then, though, it has already advanced the local events branch to the merge with that commit. Every later local read of the events (the issue list, an issue, the events view) then fails, and the next sync pushes the unreadable history on. The TUI's sync (`Events.runSync`, which the API shares) does the same.

Validate what was fetched before the local events branch moves: if the fetched history can't be consumed, leave the local branch where it was, report the failure with the step and a reason a user can act on, and keep local changes. The status endpoint's `conflicts: null` fallback (#27) should then only be needed for a database that was already broken.

## Acceptance criteria

- [ ] A sync from a remote whose events branch holds an unreadable commit fails at `merge`, and the local events branch, local issues and the events view stay as they were before the sync
- [ ] Nothing unreadable is pushed to the remote
- [ ] The TUI's sync behaves the same (shared operation, no duplicated rule)
- [ ] A Zig test reproduces the advance before the fix; Playwright covers the API and the sync panel's message
- [ ] Existing Zig suites pass; frontend typecheck, build and e2e pass; compatible `haxy-hub-impl` commit recorded

## Blocked by

- [#27 Local mode: offline metadata edits and remote sync](27-local-mode-sync.md)
