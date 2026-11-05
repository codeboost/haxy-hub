# #31 Repository administration: remaining recovery edge cases

**Type:** AFK · **Status:** ready-for-agent · **User stories:** 93, 94, 97

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md) · follow-up from the [#23](23-repo-administration.md) review (merged with these open, by user decision)

## What to build

Two narrow gaps that the eighth Codex pass on #23 found in the settings pages' lost-answer recovery:

1. **Deletion probe after a viewer change.** A deletion lands but its answer is lost, and another tab signs out (or switches user) before the follow-up probe. `repoExistsFor` throws `ViewerChangedError`, and `DeleteRepo.tsx` shows it through `failureOf`, which says the change "wasn't made". The repository may in fact be gone. Instead, say that the viewer changed and the outcome couldn't be checked.
2. **Member reconciliation past 1,000 members.** `roleNow` in `MembersSettings.tsx` scans at most ten pages. If the member is beyond that, or absent after a successful revoke, every "Check again" repeats the capped scan, and the form stays disabled. Fix it with a targeted lookup, for example `GET …/settings/members/{name}` answering the member's role or `not_found`, rather than a scan.

## Acceptance criteria

- [ ] A lost deletion answer followed by a sign-out in another tab reports that the outcome is unknown, never that nothing was deleted
- [ ] Member recovery settles in one request, whatever the member count, including after a successful revoke
- [ ] Tests reproduce both cases (a route intercept for the lost answer; a fixture or API stub with more than 1,000 members)
- [ ] Existing Zig suites pass; frontend typecheck, build and e2e pass; compatible `haxy-hub-impl` commit recorded

## Blocked by

- [#23 Repository administration](23-repo-administration.md)
