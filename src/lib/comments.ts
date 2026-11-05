/**
 * Comments on a thread (issues now; discussions and patches reuse them),
 * read and written through the routes in haxy's src/api/comments.zig. The
 * windows (oldest first, the TUI's ten by default), the reply context and who
 * may change a comment are Haxy's own (the TUI's comment reader and
 * src/thread_write.zig): Hub never builds a cursor or decides a right.
 */
import { ApiError, getJson, requestJson, type ActionAvailability, type EventId, type PageInfo, type PageQuery, type RequestOptions, type Timestamp } from "@/lib/api"
import type { MarkdownBlock } from "@/lib/markdown"
import type { RepoLocator } from "@/lib/repo"
import { newThreadId, threadApiPath, threadRoute, type ThreadAuthor, type ThreadKind, type WriteViewer } from "@/lib/threads"

export { commentRoute } from "@/lib/threads"

/** What the viewer may do to one comment; Haxy checks again when it is done. */
export type CommentActions = Record<"reply" | "edit" | "remove", ActionAvailability>

export type ThreadComment = {
  id: EventId
  /** The comment this one replies to; null for a comment on the thread itself. */
  parent_id: EventId | null
  author: ThreadAuthor
  /** Who wrote the comment this one replies to (the reply context); null on the thread itself. */
  parent_author: ThreadAuthor | null
  created_at: Timestamp
  /** Removed comments stay in their thread, so their replies stay connected; they have no body. */
  removed: boolean
  body: MarkdownBlock[]
  body_text: string
  /** Opaque: what an edit is made against. */
  revision: string
  actions: CommentActions
}

/** A window of comments; `previous_cursor` names the window before it (null on the first). */
export type CommentWindow = { items: ThreadComment[]; page: PageInfo; previous_cursor: string | null }

/** A thread's comments, with whether the viewer may comment on it. */
export type ThreadComments = CommentWindow & { actions: Record<"create", ActionAvailability> }

/**
 * One comment with a window of its immediate replies, and the cursor of the
 * thread's (default) comment window that shows it (null for the first).
 */
export type CommentPermalink = { comment: ThreadComment; thread_cursor: string | null; replies: CommentWindow }

type Options = Pick<RequestOptions, "signal">

function commentsPath(repo: RepoLocator, kind: ThreadKind, thread: EventId): string {
  return `${threadApiPath(repo, kind, thread)}/comments`
}

function commentPath(repo: RepoLocator, kind: ThreadKind, thread: EventId, comment: EventId): string {
  return `${commentsPath(repo, kind, thread)}/${encodeURIComponent(comment)}`
}

function withCursor(path: string, query: PageQuery): string {
  const params = new URLSearchParams()
  if (query.cursor) params.set("cursor", query.cursor)
  if (query.page_size !== undefined) params.set("page_size", String(query.page_size))
  const text = params.toString()
  return text ? `${path}?${text}` : path
}

export function listComments(repo: RepoLocator, kind: ThreadKind, thread: EventId, query: PageQuery = {}, options: Options = {}): Promise<ThreadComments> {
  return getJson(withCursor(commentsPath(repo, kind, thread), query), options)
}

/** One comment and a window of its replies (`query.cursor` pages the replies). */
export function getComment(repo: RepoLocator, kind: ThreadKind, thread: EventId, comment: EventId, query: PageQuery = {}, options: Options = {}): Promise<CommentPermalink> {
  return getJson(withCursor(commentPath(repo, kind, thread, comment), query), options)
}

/**
 * The comment as it is now, or null when Haxy has none with this id in the
 * thread, for settling a write whose outcome is unknown. Removed comments are
 * still found (`removed`). Rejects when Haxy can't say.
 */
export async function findComment(repo: RepoLocator, kind: ThreadKind, thread: EventId, comment: EventId): Promise<CommentPermalink | null> {
  try {
    return await getComment(repo, kind, thread, comment)
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return null
    throw error
  }
}

/**
 * A fresh id for a new comment. Sent with the post, it makes the post
 * idempotent: Haxy refuses a second event with the same id (`conflict` keyed
 * by `id`), so a composer whose outcome is unknown can look the id up and
 * retry with it without posting twice.
 */
export const newCommentId = newThreadId

function writeJson<T>(path: string, method: string, viewer: WriteViewer, body?: unknown): Promise<T> {
  return requestJson<T>(path, {
    method,
    viewer,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  })
}

/** Posts a comment on the thread, or a reply to its comment `parent`, under `id` (see `newCommentId`). */
export function postComment(repo: RepoLocator, kind: ThreadKind, thread: EventId, viewer: WriteViewer, id: EventId, parent: EventId | null, body: string): Promise<CommentPermalink> {
  return writeJson(commentsPath(repo, kind, thread), "POST", viewer, { id, parent_id: parent ?? "", body })
}

/** Replaces a comment's body as of `revision`; `conflict` keyed by `revision` when it changed since. */
export function editComment(repo: RepoLocator, kind: ThreadKind, thread: EventId, comment: EventId, viewer: WriteViewer, revision: string, body: string): Promise<CommentPermalink> {
  return writeJson(commentPath(repo, kind, thread, comment), "PATCH", viewer, { revision, body })
}

/** Removes a comment; removing a removed one changes nothing, so a retry is safe. */
export function removeComment(repo: RepoLocator, kind: ThreadKind, thread: EventId, comment: EventId, viewer: WriteViewer): Promise<CommentPermalink> {
  return writeJson(commentPath(repo, kind, thread, comment), "DELETE", viewer)
}

/** Whether `comment` holds exactly `body`, as Haxy stores it (CRLF line breaks become LF). */
export function holdsBody(comment: ThreadComment, body: string): boolean {
  return !comment.removed && comment.body_text === body.replace(/\r\n/g, "\n")
}

// --- Hub routes ----------------------------------------------------------------

/** The element id a thread page gives a comment, which its URL's fragment names. */
export function commentAnchor(comment: EventId): string {
  return `comment-${comment}`
}

/**
 * The Hub route of a thread's page at one of its comment windows
 * (`?comments=<cursor>`), focused on `focus` (`#comment-<id>`) when given.
 */
export function threadCommentsRoute(repo: RepoLocator, kind: ThreadKind, thread: EventId, cursor: string | null = null, focus: EventId | null = null): string {
  const query = cursor ? `?${new URLSearchParams({ comments: cursor }).toString()}` : ""
  return `${threadRoute(repo, kind, thread)}${query}${focus ? `#${commentAnchor(focus)}` : ""}`
}
