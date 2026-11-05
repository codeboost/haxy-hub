# #15 Assigning and unassigning people

**Type:** AFK · **Status:** done · **User stories:** 60, 61, 62

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Show assignees by account name when resolved, otherwise by email (both modes). Authorized contributors assign and unassign using existing identity-resolution rules. Assignee links open the issue list filtered by that assignee.

## Acceptance criteria

- [x] Assign/unassign persists and is visible in the TUI
- [x] Unresolved identities display by email; local mode works
- [x] Assignee link lands on the filtered issue list
- [x] Unauthorized users cannot assign via direct API
- [x] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [x] Existing Zig suites pass; frontend typecheck and build pass
- [x] Compatible `haxy-hub-impl` backend commit recorded (`015799a` on `issue-15-assignment`)

## Blocked by

- [#12 Issues: create, edit, close/reopen, and remove](12-issues-write.md)

## Implementation notes

**Backend (`haxy`).**

- The TUI's assign and unassign (`ui/widget/thread.zig`) and Haxy's HTML handlers
  (`web.zig` `handleAssign`/`handleUnassign`) each opened the repository and called
  `evt.Assignment.create` / `evt.removeInThread` themselves. Both now call two shared
  operations in `src/thread_write.zig`, which the JSON API calls too:
  - `assign(…, actor, admin_moment, thread_kind, thread_id, text)`: `canModify` on the thread
    (its author or a writer, else `error.Forbidden`), then `ui.assigneeEmail` (an email as
    itself; on a server, an account name as that account's email), then
    `evt.Assignment.emailValid`. It answers the assignment id, or the TUI's own refusal
    (`not_found`, `not_an_email`, `already_assigned`).
  - `unassign(…, actor, thread_kind, thread_id, assignment_id)`: the same rights check;
    `error.NotAssigned` when the thread has no such active assignment.
  - Both check that the thread is live and whether the assignment is active where the write
    lands: inside a xit repository's transaction (`evt.consumeGuarded` with an
    `AssignmentGuard`), or under #12's git events lock. They catch up local mode's events
    branch first. `evt.Assignment.create` is gone; `threadLive` now shares `threadLiveAt`
    with the guard.
- `src/api/assignees.zig`: `POST …/issues/{id}/assignees` (`{assignee}`) and
  `DELETE …/issues/{id}/assignees/{assignment}`, answering the issue as its own route reads
  it. It reuses `api/issues.zig`'s repository/issue checks, `authorize` and
  `respondDetail`, which are now `pub`. It is hooked with one line in `routeApiRequest`.
- `src/api/thread.zig`: each assignee carries `id` (its assignment's event id), and a
  thread's `actions` gain `assign` (the same `can_modify` decision as edit, with its own
  forbidden message).
- Unit tests: `src/test/thread_write.zig` (assigning by email, refusals, rights, unassigning
  twice, removed or wrong-kind threads), `src/test/api_assignees.zig` (routes) and
  `src/test/api_issues.zig` (assignee ids, `assign` action).

**Haxy Hub.** `src/lib/assignees.ts` (`assignThread`, `unassignThread`, `alreadyAssigned`,
`assigneeNamed`) and `src/components/assignees/ThreadAssignees.tsx`, which replaces the
read-only assignee row on the issue page (a one-line hook in `ThreadDetail.tsx`). It shows
each assignee by name, or else by email, linking through `threadsRoute` to the list of the
issue's status filtered by `assignee:`. When `actions.assign` is available it adds an
"Assign someone" form and an "Unassign <name>" button per assignee, using `useWrite`. A lost
answer is settled by reading the issue; a repeat refused as already assigned (or answered
`not_found` on unassign) counts as done; when the read fails too, the form waits for "Check
again", and a read that fails after a settling repeat holds the same way. Assign ignores the
later clicks of a double click. `useThreadAnswers` (the hook in `ThreadDetail.tsx`) lets an
assignee answer set only the assignees and a status answer everything else, so crossing
answers can't undo each other (Codex review, round 1). `src/lib/threads.ts` exports `apiBase`, and its types gain `ThreadAssignee.id` and
`actions.assign`.

**Tests.** `e2e/assignees-api.spec.ts` covers:

- assigning by name and email, and Haxy's own page and the filter list after each change;
- refusals beside `assignee`, and unassigning twice;
- a restart;
- assignees added through the HTML form, and display by email once an account's email
  changes;
- anonymous, reader and role-restricted refusals through the raw API, with a private
  repository hidden;
- wrong methods;
- local mode.

`e2e/assignees.spec.ts` covers the browser flow:

- assign, refuse, follow an assignee link to the filtered list, and unassign, checked after
  refresh and in Haxy's own page;
- a reader sees no controls;
- lost answers for assign, unassign, and a repeat that settles as already assigned;
- crossing assignment and status answers, a failed read after a settling repeat, and a
  double click on Assign;
- local mode with unresolved emails and their links.

**Decisions.**

- Unassigning goes by the assignment's opaque event id rather than the email, so an
  account's email never reaches the client. The id is a hash of the issue and the email. The
  email itself is readable by anyone who can clone the repository's events branch, so the id
  reveals nothing new.
- Repeating an assignment stays a `conflict`, the TUI's "already assigned", rather than an
  idempotent success. Hub settles it after an unknown outcome instead.
- An assignee link opens the list of the issue's own status, as the list rows' links already
  did (#11).
