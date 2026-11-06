/**
 * Notifications, server mode only, through haxy's src/api/notifications.zig,
 * which reads and writes through the TUI's own operations (src/notify.zig):
 * who is notified, what the inbox lists and counts, subscribing and muting,
 * and when a notification counts as read are Haxy's rules. Local mode has no
 * accounts, so it has no notifications.
 *
 * Reads never change read state. A thread's page sends `acknowledgeThread`
 * once it has shown the thread, naming the notification's `revision` it read
 * alongside it, and Haxy marks it read unless another bump came since.
 */
import { ApiError, getJson, requestJson, type Count, type EventId, type RequestOptions, type Timestamp } from "@/lib/api"
import type { RepoLocator } from "@/lib/repo"
import { threadApiPath, threadRoute, type ThreadKind, type WriteViewer } from "@/lib/threads"

type Options = Pick<RequestOptions, "signal">

/** A thread kind as notifications name it: every kind Hub shows. */
export type NotifiedKind = ThreadKind

/** One notification in the inbox: the thread it is about, as of its latest bump. */
export type NotificationItem = {
  id: EventId
  unread: boolean
  title: string
  repo: { owner: string; name: string }
  thread: { kind: NotifiedKind; id: EventId }
  updated_at: Timestamp
}

export type Inbox = {
  items: NotificationItem[]
  page: { has_more: boolean; next_cursor: string | null; count: Count }
  unread_count: number
}

/** The viewer's state on one thread: whether Haxy notifies them of it, and their notification about it. */
export type ThreadNotification = {
  /** Whether Haxy notifies the viewer of activity here (they are its author, an assignee, a commenter or a subscriber). */
  notified: boolean
  notification: { id: EventId; unread: boolean; revision: string } | null
}

/** What subscribing or muting asks for. */
export type NotifyMode = "subscribed" | "muted"

export function listNotifications(query: { cursor?: string; page_size?: number } = {}, options: Options = {}): Promise<Inbox> {
  const params = new URLSearchParams()
  if (query.cursor) params.set("cursor", query.cursor)
  if (query.page_size !== undefined) params.set("page_size", String(query.page_size))
  const text = params.toString()
  return getJson(`/api/v1/notifications${text ? `?${text}` : ""}`, options)
}

export async function unreadCount(options: Options = {}): Promise<number> {
  return (await getJson<{ unread_count: number }>("/api/v1/notifications/count", options)).unread_count
}

function notificationPath(repo: RepoLocator, kind: ThreadKind, id: EventId): string {
  return `${threadApiPath(repo, kind, id)}/notifications`
}

export function getThreadNotification(repo: RepoLocator, kind: ThreadKind, id: EventId, options: Options = {}): Promise<ThreadNotification> {
  return getJson(notificationPath(repo, kind, id), options)
}

/**
 * The viewer's notification state as a thread page reads it beside the thread,
 * in the same read: "off" where there is none (local mode, nobody signed in),
 * and a failure kept apart, so it never fails the page.
 */
export type NotificationRead =
  | { kind: "off" }
  | { kind: "loaded"; value: ThreadNotification }
  | { kind: "failed"; error: ApiError }

let reads = 0

/**
 * This tab's one order of reads: when a read went out, or answered. A thread
 * page acknowledges only once its comments were read after its notification
 * state answered.
 */
export function nextReadOrder(): number {
  return ++reads
}

/**
 * Reads a page's thread and the viewer's notification state on it as one read:
 * the state first, and the thread only once Haxy has answered it (or failed
 * to), so the bump the state names is never newer than the thread the page
 * then shows. The page shows both together, so it only ever acknowledges a
 * bump it shows. The cost is one small request before the thread's.
 */
export async function withNotification<T>(repo: RepoLocator, kind: ThreadKind, id: EventId, viewer: WriteViewer, signal: AbortSignal, readThread: () => Promise<T>): Promise<{ data: T; notification: NotificationRead; stateAt: number }> {
  const notification: NotificationRead = repo.kind === "server" && viewer !== null
    ? await getThreadNotification(repo, kind, id, { signal }).then(
      (value) => ({ kind: "loaded", value }),
      (error: unknown) => ({ kind: "failed", error: error instanceof ApiError ? error : new ApiError("invalid_response", "Haxy Hub could not read Haxy's answer.", 0) }),
    )
    : { kind: "off" }
  // when the state answered (`nextReadOrder`)
  const stateAt = nextReadOrder()
  return { data: await readThread(), notification, stateAt }
}

/** Subscribes to the thread or mutes it; a thread at its subscriber cap is `conflict`, with Haxy's message. */
export function setThreadNotification(repo: RepoLocator, kind: ThreadKind, id: EventId, viewer: WriteViewer, mode: NotifyMode): Promise<ThreadNotification> {
  return requestJson<ThreadNotification>(notificationPath(repo, kind, id), {
    method: "PUT",
    viewer,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  })
}

/** Says the page showed the thread while its notification was at `revision`; the header counts again after. */
export async function acknowledgeThread(repo: RepoLocator, kind: ThreadKind, id: EventId, viewer: WriteViewer, revision: string): Promise<ThreadNotification> {
  try {
    return await requestJson<ThreadNotification>(`${notificationPath(repo, kind, id)}/read`, {
      method: "POST",
      viewer,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision }),
    })
  } finally {
    // answered or not, it may have landed: the counts read again (never the write)
    notificationsChanged()
  }
}

/** The Hub route of the thread a notification is about. */
export function notificationRoute(item: NotificationItem): string {
  const repo: RepoLocator = { kind: "server", owner: item.repo.owner, name: item.repo.name }
  return threadRoute(repo, item.thread.kind, item.thread.id)
}

/** The Hub route of the inbox, at a cursor's page. */
export function notificationsRoute(cursor = ""): string {
  return cursor ? `/notifications?${new URLSearchParams({ cursor }).toString()}` : "/notifications"
}

// --- Freshness ------------------------------------------------------------------
//
// The header's unread count reads again on every navigation, and right after
// this tab changed read state.

const listeners = new Set<() => void>()

/** Tells every reader of the unread count that it may have changed. */
export function notificationsChanged(): void {
  for (const listener of listeners) listener()
}

/** Calls `listener` whenever this tab changes read state; returns the unsubscribe. */
export function onNotificationsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
