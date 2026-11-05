# #13 Comments: pagination, replies, permalinks, edit and remove

**Type:** AFK · **Status:** done · **User stories:** 53, 54, 55, 56

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Thread readers see paginated comments with author and reply context. Contributors comment or reply to a specific comment, edit, and remove with confirmation, within Haxy's rules. Comment permalinks show the selected comment and supported reply context. Implemented as shared components usable for issues, discussions and patches.

## Acceptance criteria

- [x] Comment and reply persist and appear in the TUI
- [x] Permalink to a comment on a later page opens to that comment after refresh
- [x] Non-authors without moderation rights cannot edit/remove (API enforced)
- [x] Pagination state is preserved in the URL
- [x] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [x] Existing Zig suites pass; frontend typecheck and build pass
- [x] Compatible `haxy-hub-impl` backend commit recorded (`c4c6daf` on `issue-13-comments`)

## Blocked by

- [#12 Issues: create, edit, close/reopen, and remove](12-issues-write.md)

## Implementation notes

**Backend (`haxy`).**

- `src/thread_write.zig` gains the comment writes the TUI's comment forms, Haxy's HTML
  comment forms and the JSON API now share: `comment` (a comment on a thread or a reply to
  one of its comments, under a given id; the parent must be a comment in the same thread,
  `evt.threadHolds`; `IdTaken` checked inside a xit repository's transaction, or under the
  git events lock) and `editComment` (who may change it is `canModify`, checked here; an
  optional revision; `Removed` once removed; rebuilt from the comment as it is inside the
  transaction by a `CommentRebase` guard). `remove` of an already removed comment now writes
  nothing. `evt.Comment.contentRevision` digests the body (16 bytes of SHA-256, as for
  issues). `evt.Comment.update` (which re-checked nothing) is gone; `web.zig`'s comment
  new/edit handlers and the TUI thread widget's `submitComment` call the shared operations.
- `src/ui/Repo/Comment.zig` (the TUI's reader) gains `loadWindowSized`/`initSized` (its
  windows at a client's page size; the TUI keeps 10), `threadPosition` (a comment's rank in
  its thread, from the sorted index), and no longer reads a window past the end.
- `src/api/comments.zig` serves `GET`/`POST …/<thread>/comments` and
  `GET`/`PATCH`/`DELETE …/<thread>/comments/<comment>`, generic over the thread kind (a
  `Kind` names the kind, its section and its messages); `api/issues.zig` hooks it in with
  one dispatch, and `api/thread.zig`'s route parser names the two new resources.
- Unit tests: `src/test/thread_write.zig` (idempotent post, reply parents in the thread,
  stale revision, author/writer rules, removal twice, git-repository catch-up) and
  `src/test/api_issues.zig` (the comment routes).

**Haxy Hub.** `src/lib/comments.ts` has the comment types, reads, writes
(`postComment` with a client id, `editComment` with a revision, `removeComment`),
`findComment`/`holdsBody` for settling unknown outcomes, and the routes
(`threadCommentsRoute` with `?comments=<cursor>#comment-<id>`; `commentRoute` lives in
`threads.ts` beside `threadRoute`). `src/components/thread/` gains `ThreadComments` (the
thread page's window, pager, focus on the fragment's comment, composer), `CommentPermalink`
(the comment's own page with its replies), `CommentCard` (one comment, its reply context
and actions, with an inline removal confirmation) and `CommentForms` (`CommentComposer`,
`CommentEditor`). The shared files change only by hooks: `ThreadDetail` renders
`ThreadComments` and re-reads the thread on navigation (so the comment count follows),
`ThreadSection` routes `<id>/comments/<comment>`, `threadView` parses it, and Haxy's comment
permalinks (`hubPathForIssuePath`) and comment events (`eventTargetRoute`) open the
comment's page.

**Decisions.**

- Comment pages follow the TUI: a thread's window lists every comment in it, replies
  included, oldest first, 10 per page; a comment's page shows its immediate replies. A
  removed comment stays listed as "(removed)" (no text sent), and may still be replied to,
  as in the TUI.
- Comment windows carry `previous_cursor` (an additive field), since a permalink lands on a
  later page with no history to go back through.
- A removed comment's edit is `conflict` ("This comment has been removed."), not
  `not_found`, since the comment is still listed; removing it again succeeds without writing.
- A reply posted from Hub opens in the thread's comment window that holds it, focused
  (the TUI opens the new comment's permalink page).

**Tests.** `e2e/comments-api.spec.ts` (contract, rights, idempotency, revisions, paging,
local mode; each write checked in Haxy's own pages, after a restart) and
`e2e/comments.spec.ts` (browser: post, reply, permalinks and pages after refresh, edit with
a stale revision, moderation, removal, unknown outcomes, local mode).
