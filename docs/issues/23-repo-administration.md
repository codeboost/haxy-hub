# #23 Repository administration: settings, members, branches, and deletion

**Type:** AFK · **Status:** done · **User stories:** 93, 94, 95, 96, 97, 98, 99

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

- [x] Visibility, settings and thread-role changes apply to subsequent reads/writes by other users
- [x] Member grant/revoke/promote/demote persist; a revoked writer's next write is rejected
- [x] Default branch change affects the repo landing view; protected branch rejects force-push over SSH
- [x] Only the main owner can delete; deletion requires password + typed name and the repo is gone after restart
- [x] Granted owners cannot perform main-owner-only actions via direct API
- [x] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [x] Existing Zig suites pass; frontend typecheck and build pass
- [x] Compatible `haxy-hub-impl` backend commit recorded (`ec7e00d` on `issue-23-repo-admin`)

## Blocked by

- [#10 Create a repository or copy an existing one](10-repo-create-and-copy.md)

## Implementation notes

Haxy: `src/api/repo_admin.zig`, routed in `routeApiRequest` (after the CSRF and viewer
guard, before the issue and repository routes, which keep every method but `DELETE` on the
repository itself). Contract in [API conventions](../api-conventions.md), Repository
administration. Unit tests: `src/test/api_repo_admin.zig` (routes, request shapes, refusals)
and `src/test/event/repo_admin.zig` (the transaction checks below).

Shared operations: the TUI's settings tabs already exposed theirs, and the TUI, Haxy's web
forms (`handleRepoSettings`, `handleMembers`, `handleBranches`, `handleDelete` in
`web.zig`) and the API now all call the same ones:

- `ui.Repo.Settings.update` / `labelRole` / `roleLabel` (description, visibility, thread
  roles; the API keeps the name, so it never renames) and `ui.NewRepo.parseAccess`;
- `ui.Repo.Members.perform` (grant, revoke, promote, demote) and the new
  `Members.readWindow` (the members tab's window, now with a caller's page size; `init`
  uses it with the TUI's 20);
- `ui.Repo.Branches.perform` (default branch through HEAD, protect, unprotect);
- `ui.Delete.perform` with `.repo` (typed `owner:name`, then the password; anyone but the
  main owner finds nothing) and `api/account.zig`'s `deletionError`.

Write-time checks, in `src/event.zig`, all through `evt.consumeGuarded` so the check runs
inside the user repo's write transaction under its exclusive lock:

- `evt.changeRole` replaces `grantRole`/`revokeRole`: it sets a grant from the role the
  caller read to a new one (null adds or revokes) and lands only if the grant is still what
  was read (`RoleChanged`), the actor still owns the repo (`NotOwner`; the creator always
  does) and the repo exists. So a promote never re-adds someone revoked meanwhile, an add
  never demotes someone promoted meanwhile, two revokes don't both succeed, and an owner
  demoted while their request ran changes nothing. The main owner holds no grant and is
  refused (`MainOwner`).
- `evt.writeRepoChange` writes a repo event only if the repo is still exactly what was read
  (`RepoChanged`), its name is still free and the actor still owns it. `evt.changeRepo`
  reads the repo by id, applies a change to it and writes it with `writeRepoChange`,
  retrying on `RepoChanged` (up to 5 times) against the same id, never another repo that
  took its name. `evt.updateRepo` resolves the name to an id once, and its change
  (`evt.SettingsChange`) refuses a repo renamed meanwhile (`NotFound`), so a retry after a
  rename and a reuse of the old name changes neither repo. `evt.protectBranch` applies its
  branch to the list as it is then. Both now take the actor, and a settings change and a
  protection made at once both stay instead of one overwriting the other.
- `evt.whileOwner` covers the one change that isn't an event, moving HEAD for the default
  branch (`Branches.perform`): it takes the exclusive lock every write to the owner's user
  repo takes, checks there that the actor still owns the repo, and only then moves HEAD, so
  an owner demoted while their request was being read moves nothing.

The web handlers map the new errors: `NotOwner` is the 403 a failed authorization gives,
`RoleChanged` redirects back to the list (a stale row), and `MainOwner` stays the 404 it was.
The TUI treats them the same way.

Haxy Hub: `src/lib/repoAdmin.ts` and `src/pages/settings/` (`SettingsSection`, `General`,
`Members`, `Branches`, `DeleteRepo` settings pages, plus `shared.ts`), hooked into
`RepoPage.tsx` with one `sectionRoutes` entry, one `section === "settings"` branch and two
routes (`/repos/<owner>/<name>/settings/*`, and `/repo/settings/*`, which says local mode has
no settings). The Settings tab appears only when the overview lists the `settings` section
(owners only, server only). `RadioGroup` is now exported from `NewRepoPage.tsx` and reused.
The repository overview now also revalidates on a navigation to the same URL
(`location.key`), so the header and sections follow a settings change at once.

Settings changes carry the settings' `revision` (decision, in #12's pattern): `GET …/settings`
sends it, `PUT` must name it, and a stale one is `conflict` on `revision` with nothing written
(`evt.Repo.settingsRevision`, checked by `evt.SettingsChange.apply` inside the write's
transaction; protected branches don't move it). Hub's General page refreshes an untouched form
when fresh settings arrive and, when a save is refused as stale, offers "Load the current
settings". This was chosen over sending only the changed fields, which would still let two
owners' edits of one field race and needs a partial-update shape the conventions don't have.

Branches are chosen with a picker over the first 100 branches (`GET …/branches`), sent by
Haxy's ids, so a name whose display differs from its id is sent exactly; typing a name is
the fallback for one the picker doesn't list. The default-branch picker follows a default
changed elsewhere while untouched. (Haxy's SSH server refuses ref names that aren't UTF-8,
`InvalidUtf8`, so a server repository can't be given one to test; the e2e uses a branch
literally named `a%2Fb`, beside `a/b`.) A deletion whose outcome is unknown is settled by
`repoExistsFor`, which counts the probe only while the same viewer is signed in; otherwise
the page says who is signed in now, offers a reload, and keeps the retry closed.

The API resolves and authorizes one repository record per request (`resolveTarget` in
`api/repo_admin.zig`, one read of the record and the viewer's role in it) and carries its id
into every read (`evt.readNamedRepo`: the record by id while it still has the requested name)
and write (`Settings.update`, `Members.perform` and `Branches.perform` take the authorized id;
the TUI and web forms pass null and resolve the name as before). So a rename plus a new
repository taking the old name between authorization and the read or write answers
`not_found` instead of reaching the replacement (Zig test in `src/test/api_repo_admin.zig`).
Deletion is bound the same way: `ui.Delete.perform` takes the authorized id (the TUI, the web
form and account deletion pass null and resolve the name as before), and `evt.deleteRepo`
writes the tombstone through `evt.consumeGuarded` only while that repo still exists with the
name it was deleted by, so a rename or deletion plus a reuse of the name between
authorization and the password check deletes nothing (`not_found`), and never the
replacement; the typed `owner:name` must still match (Zig tests in
`src/test/api_repo_admin.zig`). The General page disables its fields while a save is
pending, and refreshes the repository's header and sections after a lost answer it confirms
as saved, as after a normal save.

Branch and member writes are bound to the name too: `evt.protectBranch` (each attempt's
apply), `evt.whileOwner` (under the lock) and `evt.changeRole` (its guard) take the name the
change was asked for and refuse a repo renamed meanwhile (`NotFound`) before changing
anything. Every guard the admin API's writes use now checks it: `writeRepoChange` (the repo
must equal what the change read, name included), `changeRole`, `deleteRepo` and
`whileOwner`.

A read that settles a write and is answered `forbidden`, `not_found` or `unauthenticated` is
itself the answer (the viewer no longer manages the repository, perhaps by their own change,
or it's gone): the page re-reads the repository and its settings, which then say so, rather
than offering "Check again" (`lostAccess`, `useLeaveSettings`). The default-branch picker
takes its baseline from every read of the branches a change gets back (its answer, or the
read that settles a lost one, directly or through "Check again"), in one place (`adopt`),
before the form unlocks, so the refresh that follows never replaces a branch picked since.

Every settings form and row runs its writes through one hook, `useWrite` in
`src/pages/settings/shared.ts`: it owns the busy state (cleared on every completion path,
success included, unless the form is gone), the generation guard, and the unresolved outcome
that blocks another write until a check settles it. Fields take no edits while a write or
check runs or a write is unresolved, so no completion overwrites an edit, and pickers keep
what they would send as an option. Audited per form and row (General, add member, member row,
default branch, protect, protected row, delete) for success, refusal, unknown, both-failed,
check again, unmount, a second click and another owner's concurrent change.

When a change's outcome is unknown and the read that would settle it fails too, the change
stays unresolved: the General form, the add-member form, a member row, the branch forms and a
protected row offer no further attempt until "Check again" gets an answer (`Unresolved.tsx`);
the delete form already waits for a successful check. The branch pickers keep the chosen
branch as an option even when the branch list can't be read again, so what they show is what
they send.

Every write is bound to the viewer the page was loaded for, guarded against a second
submission while pending, and its async continuations are dropped once the form unmounts
or a newer operation started (`useLatest`, the generation counter of #10's form). After an
unknown outcome the page reads authoritative state and says only what holds now: the
settings (saved or not, compared with what was submitted), a member's role, the branches,
or whether the repository still exists (a retry of a deletion is offered only once Haxy
says it exists). Demoting and removing members ask for confirmation; giving up your own
ownership returns you to the repository. Deletion lists what goes before the form, keeps the
typed name but never the password, and lands on the owner's page.

e2e: `e2e/repo-admin-api.spec.ts` (HTTP contract, every main-owner-only route called by a
granted owner, permission changes reaching other users' next requests, an owner demoted
meanwhile, including while a default-branch change's body is still being sent, protection
on a real SSH force-push) and `e2e/repo-admin.spec.ts` (the browser flows, refresh and
restart, unknown outcomes, the double-submit guard, rows usable again after a refused
change, a late completion not pulling the user back, canonical ids for a branch with a
`/`, a form loaded before another owner's change, branches chosen by id, and a deletion probe
after another tab signed out). SSH: the harness can push over SSH. It carries #09's shared harness byte for byte
(`launch.server({ ssh: true })` and `buildRepo` in `e2e/support/backend.ts`, `pushRepo` in
`e2e/support/push.ts`). `e2e/support/ssh.ts`'s `sshUser` adds what these tests need on top:
an ed25519 key of the user's own, added through `POST /api/v1/account/keys` and kept across
steps, and the system `git`/`ssh` run with only that key (no agent, so a developer's loaded
keys can't stand in for a push that must be refused), for pushes that may fail, `ls-remote`
and work trees with several commits; it reads the SSH URL from the overview's clone
commands. A revoked
member's next push and issue creation are refused; a force-push to a protected branch is
refused and the branch keeps its commit; unprotected, the same push lands.

Decisions: renaming isn't offered (the issue lists description, visibility and thread roles;
a rename moves the repository's URL). The members list doesn't count (`unknown`, like the
TUI), and a granted owner may manage members and settings but never delete or change the main
owner (`forbidden`). Unprotecting a branch that isn't protected succeeds without change (the
TUI's rule), so a retry is harmless. Deletion keeps Vite's 10s proxy timeout (it tombstones
the repository and removes its directory, which is fast).

