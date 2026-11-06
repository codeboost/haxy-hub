# #14 Attachments: upload, download, and remove

**Type:** AFK · **Status:** done · **User stories:** 57, 58, 59

## Parent

[Haxy Hub front end parity spec](../haxy-hub-front-end-spec.md)

## What to build

Contributors attach files to supported threads (not comments: Haxy's attachments hang off threads, user decision), readers open or download them with correct filenames and content handling, and authorized users remove them with confirmation. Use bounded/streamed transfers (not page snapshots), expose backend size/type constraints, and authorize both reads and writes. Upload requests are exempt from the short status timeout.

## Acceptance criteria

- [x] Upload, download and remove work and persist
- [x] Over-limit and invalid uploads show useful errors
- [x] Attachments on private repos are not readable by unauthorized users (direct URL check)
- [x] Downloaded filename and content type are correct; active content is not rendered inline unsafely
- [x] Zig JSON endpoints follow the API conventions from #01 and share underlying operations with the TUI (no duplicated rules)
- [x] Playwright tests run through the Vite proxy against a real Zig fixture backend; mutations are verified after refresh
- [x] Existing Zig suites pass; frontend typecheck and build pass
- [x] Compatible `haxy-hub-impl` backend commit recorded (`1a193b7` on `haxy-hub-impl`)

## Blocked by

- [#13 Comments: pagination, replies, permalinks, edit and remove](13-comments.md)

## Implementation notes

**Backend (`haxy`).**

- New `src/attachment.zig` holds the rules every way of reading or uploading an attachment
  shares; Haxy's HTML routes (`web.zig` `handleAttach`, `serveAttachment`) now call it instead of
  their own copies (`sendAttachment` and `attachmentContentType` are gone):
  - `checkUpload(name, content_length)`: a name `evt.Attachment.nameValid` accepts and a declared
    length of 1 byte to `max_size` (10 MiB), checked before any of the body is read.
  - `handling(name)`: the content type and whether a browser may show it in place. Only PNG,
    JPEG, GIF and WebP are inline (the TUI's list); a few known types download with their own
    type; everything else, HTML/SVG/JS/XML included, downloads as `application/octet-stream`.
  - `disposition(name, inline)`: RFC 6266 `filename*` plus an ASCII `filename` fallback.
  - `readServable` (the read check: a live attachment on a live thread, the route's own thread
    when it names one) and `send`, which streams the blob with `nosniff`, a sandboxing CSP and
    `no-store`. Haxy's own `…/attachment:<id>` URL now also refuses attachments of removed
    threads.
- `src/thread_write.zig` gains `attach(…, actor, thread_kind, thread_id, id, blob)`: `canModify`
  on the thread (its author or a writer, as the HTML upload always required), then the thread's
  liveness and the id's freedom checked where the write lands (`evt.consumeGuarded` with an
  `AttachGuard` for xit, the git events lock otherwise), after local mode catches up. The HTML
  upload uses it (so it now takes the git lock and catches up too). `remove` now answers
  `error.NotFound` for an attachment already removed instead of writing a second removal.
  `kindOf` and `threadLiveAt` are `pub` for the read check. `evt.Attachment.create`, the HTML
  route's old write with its own copy of the checks, is gone.
- `ui.Repo.Attachment` is exported, and its entries carry `author_email`, which decides who may
  remove one.
- `src/api/attachments.zig`: `POST <thread>/attachments?name=&id=` (the body is the file,
  streamed; 201 with the thread), `GET`/`HEAD`/`DELETE <thread>/attachments/{id}`. It takes a
  `Kind` (the comment routes' `Kind` plus the kind's `readDetail` and `authorize`), and
  `api/issues.zig` hooks it in with one line, as it does comments; `api/thread.zig` parses the two
  resources. A refused upload drops a body of up to 40 MiB before answering, so the client sees
  the answer.
- Thread answers gain `attachments`, `attachment_limits` and `actions.attach`
  (`api/thread.zig`; `ViewerRights` carries the tab viewer for each attachment's
  `actions.remove`).
- Unit tests: `src/test/attachment.zig` (content handling, disposition, upload checks),
  `src/test/api_attachments.zig` (routes, attachment JSON and rights, limits),
  `src/test/thread_write.zig` (attach/remove rules and the read check),
  `src/test/api_issues.zig` (`attach` action).

**Haxy Hub.** `src/lib/attachments.ts` (`uploadAttachment`, `removeAttachment`,
`attachmentUrl`, `refusal`, `alreadyAttached`) and
`src/components/attachments/ThreadAttachments.tsx`, mounted under the description in
`ThreadDetail.tsx` (one line) and keyed by `config.kind`, so discussions and patches get it once
their routes hook `api_attachments` in. Downloads are plain links to the API route (images open
in a new tab, other files download); uploads send the `File` itself with an id chosen per file;
removal asks first. Files over the published limits, or empty, are refused before sending; Haxy's
refusals show beside the file input. Lost answers are settled by reading the issue (the id makes a
repeat safe); `useThreadAnswers` gains an attachments slot so upload/removal answers set only the
attachments. `vite.config.ts` exempts the attachment routes from the proxy's 10 s timeout.

**Decisions (conservative, for review).**

- Attachments are on threads only, never comments: Haxy's attachment event hangs off a thread and
  the TUI offers none on comments.
- The TUI hides "add attachment" on a conflicted thread; the API doesn't refuse it (as #12 doesn't
  refuse status changes on one), so `actions.attach` doesn't consider conflicts.
- Uploads are idempotent by a client-chosen `id`, as issue and comment creation are.
- Inline types stay the TUI's four image types; the CSP and `no-store` are new on every download,
  Haxy's own URL included.
- Downloads are exempt from the proxy timeout along with uploads.

**Codex review, round 1.**

- A refused upload with no `Content-Length` (chunked) closes the connection instead of being
  drained without bound (`api_attachments.drainable`, unit-tested).
- `useThreadAnswers` takes the assignees and attachments from their own answers or else from the
  latest read, never from a status answer that may have been read before an upload or an
  assignment landed. The same hole existed for assignees and is fixed with it
  (`e2e/attachments.spec.ts`, a held Close answer arriving after a fresh read).
- A repeated upload refused on its id is settled by reading the thread: listed means attached;
  otherwise it was removed since, which Hub says, giving the file a new id.

**Codex review, round 2.**

- A refused upload that is chunked is never drained, whatever `Content-Length` it also claims
  (`api_attachments.drainable` takes the transfer encoding); a chunked upload is refused as
  having no length (`attachment.declaredLength`, used by the API and the HTML upload alike).
- `thread_write.remove` checks that an attachment is live on the named thread before the actor's
  rights, so an unknown, removed or other thread's attachment is `not_found` for everyone, not
  `forbidden` (also for Haxy's HTML removal and the TUI).
- Every answer to a change on the issue page (status, edit, assignees, attachments) reads the
  issue again in the background (`ThreadDetail.tsx`), so changes from another client show after a
  write without a reload; round 1's per-field ordering stays.
- File refusals beside the file input are announced (`role="alert"`).
- `e2e/thread-refresh.spec.ts`'s "a read … that started before Close answered" no longer waits
  for the held stale read to land: the read after the close's answer now supersedes (aborts) it.
  It still checks that the close stands and the comment shows.

**Wired after merge (batch 5).** Discussions and patches take attachments through the same
routes: `api/discussions.zig` and `api/patches.zig` hook `api_attachments.handle` in with their
own `Kind` (one `readDetail` each; `Kind.authorize` is gone, since who may write is
`api_thread.authorize` with the kind), and their thread answers carry `attachments`,
`attachment_limits` and `actions.attach` (a patch's `actions` holds only `attach`, its one write
through the API until #18). Who may attach or remove is the thread's, as the TUI and Haxy's
upload form decide it for every kind: the tab role, then the thread's (or attachment's) author or
a writer. Hub: discussions take the attachments from Haxy's answer (`asThreadDetail`), upload and
removal answers go through the kind's adapter (`detailOf`), `ThreadAttachments` takes any kind's
attachment fields (`Attached`), and the patch page renders it with `useAttachmentAnswers` (the
attachment part of `useThreadAnswers`, extracted). e2e: `e2e/thread-kinds-api.spec.ts` and
`e2e/thread-kinds.spec.ts`.
