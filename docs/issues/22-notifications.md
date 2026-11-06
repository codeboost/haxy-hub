# #22 Notifications: inbox, read state, subscribe and mute

**Type:** AFK · **Status:** done · **User stories:** 90, 91, 92

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Registered users see a paginated inbox with unread indicators and links to threads. Read state and the unread count update when the user actually views the thread (an explicit acknowledgement, not prefetch). Users subscribe to or mute supported threads and see any subscription-capacity error. Server mode only.

## Acceptance criteria

- [x] Activity by another user produces an inbox entry and unread count
- [x] Opening the thread marks it read; hovering/prefetching does not
- [x] Subscribe/mute persist; capacity limit error is shown
- [x] Notifications for repos the user lost access to are not exposed
- [x] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [x] Existing Zig suites pass; frontend typecheck and build pass
- [x] Compatible `haxy-hub-impl` backend commit recorded (`28f2758` on `haxy-hub-impl`)

## Blocked by

- [#13 Comments: pagination, replies, permalinks, edit and remove](13-comments.md)

## Implementation notes

See "Notifications" in [the API conventions](../api-conventions.md) for the routes and rules.

**Backend (`haxy`).**

- `src/notify.zig` gains the shared operations the TUI and the API both use:
  - `mayRead(repo, role, kind)`: whether someone may read a repository's threads of a kind
    (a role in it, and the kind's tab on). Delivery (`Inboxes`) now decides by it too, per
    notification, so a notification is no longer delivered for a kind whose tab is off.
  - `Readable` and `readWindow(moment, arena, readable, from, count)`: one window of the
    notifications the viewer may still read, newest first, with the readable total and
    unread counts. A notification's repository is read again by its id from its owner (named
    as of its last bump), with the viewer's role now; one they can't read is skipped, kept,
    not deleted. `from` is an index (the TUI's `start:` links) or an order key (the API's
    cursor). The TUI's inbox (`ui/UserNotifications.zig`) now reads through it, so the TUI
    also stops listing and counting notifications of repositories the user lost, and links
    each to the repository's current name.
  - `markViewed(…, seen)`: the end of `ui.Repo.readNotify` moved here. The TUI calls it with
    `seen = null` (the latest bump, as before); the API with the revision the page read.
  - `subscribe` answers `.subscribed` or `.full`. The cap check and the insertion into the
    owner's subscribed tier are one transaction now (they were a read then a later write);
    the user's own notify record is written after. `writeMode` is split into `writeRecord` +
    `indexMode`. Haxy's HTML form and the TUI ignore `.full`, as they ignored the cap before.
    If the record write fails, `unreserve` gives the place back before the error escapes
    (Codex review, round 1).
- `src/api/notifications.zig`: `GET /api/v1/notifications`, `GET /api/v1/notifications/count`,
  and `GET`/`PUT …/issues/{id}/notifications`, `POST …/issues/{id}/notifications/read`, the
  thread routes taking an `api_comments.Kind`. Hooked with two lines in `routeApiRequest`
  (`api_issues.comment_kind` and `api_comments.threadLive` are now `pub`).
- Unit tests: `src/test/api_notifications.zig` (routes, cursors, the cap's message) and
  `src/test/event/notify.zig` (subscribe's outcomes, including `.full`).

**Haxy Hub.** `src/lib/notifications.ts`; `src/pages/NotificationsPage.tsx` (`/notifications`,
one route in `router.tsx`); `src/app/NotificationsLink.tsx` (the header's bell and unread
count, one line in `AppShell.tsx`); `src/components/notifications/ThreadNotifications.tsx`
(the Mute/Subscribe control and `useAcknowledgement`, rendered in the shared thread body; the
state is read with the thread through `withNotification` in `ThreadDetailView` and
`CommentPermalinkView`). All of it is
keyed by `config.kind`, so discussions and patches pick it up once #16/#17 add their kinds and
one `threadRoute(path, "<kind>")` line each in `routeApiRequest`.

**Tests.** `e2e/notifications-api.spec.ts`: a comment by another user produces an unread
entry and count; reads (thread, comments, state, `HEAD`) change nothing; a stale
acknowledgement changes nothing; the right one marks it read, through a restart; a new bump
needs a new acknowledgement; paging by cursor and parameter refusals; subscribe and mute
persist through restarts, agree with Haxy's own page and decide who hears of a comment; a
real 101st subscriber gets the cap's `conflict`; revoked access and issues turned off hide a
notification from the inbox, the counts, Haxy's own inbox and every thread route, and access
again restores it; a removed thread's notification leaving the inbox, the counts and Haxy's
own inbox; a repository without events answering 404; a repository whose directory or database vanished mid-scan
hidden instead of failing the inbox; anonymous viewers and local mode. `e2e/notifications.spec.ts`: the inbox
and header count, hover and focus reading nothing, opening the thread acknowledging it once,
a background tab acknowledging only once visible, a newer bump read beside a failed thread
refresh waiting for the thread to be shown, a late acknowledgement answer not undoing a mute,
assigning yourself turning the panel to Mute without a reload, an acknowledgement sent while
a mute is on its way, a comment permalink acknowledging its thread, a retried failed state
read acknowledging, a settled lost mute updating the count, two assignee changes during one state read, the
inbox reading again when a late acknowledgement lands, a mute landing after its page is left, acknowledging only after the comments are shown (on first load and
on a refresh), an acknowledgement whose answer is lost, an extra comment read cut short by a page change, the thread read waiting for the state read (an
assignment made meanwhile is shown before it is acknowledged), a mute whose answer is lost
after its page is left,
subscribe/mute after refresh, the cap's
message beside the button, a lost answer settled by a read, local mode and signed-out
visitors.

**Codex review, round 1.** A failed subscriber record gives its tier place back
(`notify.unreserve`); the acknowledgement waits for a thread read that went out after the
state read it names (`nextReadOrder`, stamped on both reads); answers are ordered by when
their change went out, so a late acknowledgement answer can't undo a mute; and an assignee
change reads the notification state again (posting a comment already navigates, which reads
it again).

**Codex review, round 2.** Simplified rather than patched:

- *Backend.* One process-wide lock (`notify.mode_mutex`) covers each change of a notify
  mode from its check to its last write (`subscribe`, `mute`, `writeMode`, and each
  participant in `subscribeEach`), so a subscription racing one whose record write then
  fails can't answer `.subscribed` on a place that is given back. The web, the API and the
  TUI over SSH all run in the one `haxy serve` process. Test: six concurrent subscriptions,
  forty rounds, in `src/test/event/notify.zig` (red before the lock).
- *Hub.* The notification state is now part of the page's own read (`withNotification`), on
  the thread page and on comment permalink pages, so the ordering stamps (`nextReadOrder`,
  `begin`/`issued`) are gone. Acknowledgements come only from that read and their answers
  are not applied; whether the viewer is notified is owned by subscribe/mute answers, settling
  reads and post-assignment reads, which run one at a time through `useWrite`. Retry reads the
  page again; every applied answer makes the header count again.

**Codex review, round 3.**

- A removed thread's notification is hidden from the inbox and both counts, in the API and
  the TUI's inbox alike (`readWindow` opens each repository with a listed thread once and
  checks it with `notify.threadLive`, which `api_comments.threadLive` now calls), since it
  could never be acknowledged or muted. It is kept, like a lost repository's.
- A thread route of a repository without events answers the missing thread (404), not 500.
- Hub: a read after assignee changes that arrive while another request runs is kept pending
  and runs once nothing else does; every subscribe or mute that lands calls
  `notificationsChanged()` even after its page is gone; and an open inbox reads again on
  `notificationsChanged`.

**Codex review, round 4.**

- A repository deleted during an inbox scan (its record read, its directory already gone)
  is hidden like a lost one instead of failing the inbox, the count, or a TUI page that
  builds the inbox.
- `withNotification` reads the state first and the thread only after it answers, so the bump
  acknowledged is always in the thread shown (one small request's latency). This closes the
  window earlier rounds documented.
- A subscribe or mute whose outcome is unknown calls `notificationsChanged()` at once, even
  after its page is gone, so the header and an open inbox read again.

**Codex review, round 5.**

- `dropRemoved` also treats `RepoNotFound` (a deletion that removed the database but not yet
  the directories) as a gone repository, and opens with `require_repo_root`, so a repository
  whose metadata is gone is never mistaken for one an ancestor directory holds. Server
  repositories are always xit (opened through `AnyRepo(.xit)`), so no git opener is involved.
- The thread page acknowledges only once it has shown comments read after the notification
  state answered: `ThreadComments` gains an optional `onLoaded` (when its successful read went
  out, on `nextReadOrder`) and `refresh` (read again); a refresh whose comments were read
  before the state answered reads them once more, and a failed comment read waits for its own
  Retry. The permalink page needs nothing: its comment read is part of its page read.
- An acknowledgement whose answer is lost still calls `notificationsChanged()` (never
  retrying the write).

**Codex review, round 6.** The extra comment read a refresh asks for is tracked per state
read (`stateAt` and the bump), and the acknowledgement's effect re-runs when the state read
changes, so a read cut short by a comment page change no longer leaves the notification
unread: the next state read asks again. Test: the extra read is held, the user changes
page, and that page's comments answer after its state and thread.

**Decisions.**

- The acknowledgement names the bump it read (`revision`), and Haxy marks the notification
  read only if it is still at that bump, as the TUI's `markRead` already required. A stale
  acknowledgement answers 200 with the state rather than `conflict`: it isn't an error the
  user can act on, and the page shows the notification as still unread.
- A full subscriber tier is `conflict` (409): a refusal that depends on the thread's state,
  like a taken name.
- A notification of a thread the viewer can't read any more is hidden but kept, so regaining
  access restores it. Hidden also covers a kind turned off in the repository (the thread
  isn't readable then), and delivery skips such kinds too.
- The TUI's inbox now hides the same notifications (one rule for both).
- Subscribe and mute are the thread state's `PUT` with a `mode`, both always allowed (muting
  while not notified keeps commenting from subscribing you); Hub shows the TUI's one button.
- The acknowledgement waits until the browser tab is visible, so a thread opened in a
  background tab isn't read until it is looked at.
- Haxy's HTML subscribe form and the TUI still say nothing when the cap refuses (unchanged);
  showing it there is left for a later slice.

**Left for after the merge.** Discussions (#16) and patches (#17) need one
`api_notifications.threadRoute(path, "discussions"|"patches")` line each in `routeApiRequest`
with their `Kind`; the Hub side needs nothing more as long as their pages use
`ThreadDetailView` and `CommentPermalinkView` (a patch page built from its own body must read
through `withNotification` and render `ThreadNotifications` the same way). `notificationRoute` already links
`discussions`/`patches` items to `/repos/<owner>/<name>/<kind>/<id>`.

**Wired after merge (batch 5).** `routeApiRequest` routes `…/discussions/{id}/notifications` and
`…/patches/{id}/notifications` with each kind's comment `Kind` (now `pub`). Discussion pages get
the panel and the acknowledgement through `ThreadDetailView`; the patch page
(`PatchDetailView`) reads through `withNotification` and renders `ThreadNotifications`, with
`useCommentsShown` (extracted from `ThreadDetail`, which uses it too) wiring its
`ThreadComments` so it acknowledges only after showing comments read after the state. Comment
permalink pages of both kinds acknowledge through the shared `CommentPermalinkView`.
`NotifiedKind` is now `ThreadKind`. e2e: `e2e/thread-kinds-api.spec.ts` and
`e2e/thread-kinds.spec.ts`.
