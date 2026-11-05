# #31 Repository administration: remaining recovery edge cases

**Type:** AFK · **Status:** done · **User stories:** 93, 94, 97

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md) · follow-up from the [#23](23-repo-administration.md) review (merged with these open, by user decision)

## What to build

Two narrow gaps that the eighth Codex pass on #23 found in the settings pages' lost-answer recovery:

1. **Deletion probe after a viewer change.** A deletion lands but its answer is lost, and another tab signs out (or switches user) before the follow-up probe. `repoExistsFor` throws `ViewerChangedError`, and `DeleteRepo.tsx` shows it through `failureOf`, which says the change "wasn't made". The repository may in fact be gone. Instead, say that the viewer changed and the outcome couldn't be checked.
2. **Member reconciliation past 1,000 members.** `roleNow` in `MembersSettings.tsx` scans at most ten pages. If the member is beyond that, or absent after a successful revoke, every "Check again" repeats the capped scan, and the form stays disabled. Fix it with a targeted lookup, for example `GET …/settings/members/{name}` answering the member's role or `not_found`, rather than a scan.

## Acceptance criteria

- [x] A lost deletion answer followed by a sign-out in another tab reports that the outcome is unknown, never that nothing was deleted
- [x] Member recovery settles in one request, whatever the member count, including after a successful revoke
- [x] Tests reproduce both cases (a route intercept for the lost answer; a fixture or API stub with more than 1,000 members)
- [x] Existing Zig suites pass; frontend typecheck, build and e2e pass; compatible `haxy-hub-impl` commit recorded (`8526083` on `issue-31-admin-recovery`)

## Implementation notes

- **Deletion probe after a viewer change.** `DeleteRepo.tsx` no longer shows the
  `ViewerChangedError`'s own message (which says the change "wasn't made") for the probe. It
  says Haxy couldn't confirm the request, that the viewer is signed out (or signed in as
  someone else) now, and so Haxy couldn't check whether `owner/name` was deleted; it keeps
  the Reload button, and the deletion stays disabled.
- **One member's role.** New `GET`/`HEAD` `/api/v1/repos/{owner}/{name}/settings/members/{member}`
  answers `{"name","role"}` for the same people as the member list. `role` is
  `"owner"`/`"member"` as the list holds it, `"owner"` for the main owner, and `null` for
  anyone the list doesn't hold (no such user, a deleted account, a reader, no grant). The
  member name is percent-decoded exactly once, and echoed with U+FFFD where it isn't UTF-8.
  The shared operation is `ui.Repo.Members.readRole` (beside `readWindow`), which reads the
  repository and the grant from one moment of the owner's user repo, and is `NotFound` once
  the repository was renamed or deleted. The handler is `readMember` in
  `haxy/src/api/repo_admin.zig`.
- **Decision:** a non-member is `200` with `role: null`, not `not_found`. The settings pages
  treat `not_found` as lost access (the repository gone or hidden), so a `404` for "not a
  member" would be ambiguous. This matches the `DELETE` answer `{"name","role":null}`.
- Hub: `memberRole` in `src/lib/repoAdmin.ts` replaces `currentRole`'s capped ten-page scan
  in `roleNow` (`MembersSettings.tsx`), so settling a lost add, promote, demote or revoke,
  and "Check again", takes one request whatever the member count.
- Tests: Zig unit test "one member's role is read as the members list holds it, from the
  repository authorized" (`haxy/src/test/api_repo_admin.zig`); API tests against a real Haxy
  in `e2e/repo-admin-api.spec.ts` (roles, main owner, revoke, deleted account, encoding,
  `forbidden`/`unauthenticated`/`not_found`, `405` with `Allow`); browser tests in
  `e2e/repo-admin.spec.ts`: a deletion that lands with its answer lost while another tab
  signs out, and a members list stubbed to 1,101 members with bob last, where a lost promote
  and a lost revoke each settle with one lookup and no other list pages are read.

## Blocked by

- [#23 Repository administration](23-repo-administration.md)
