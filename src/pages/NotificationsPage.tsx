import { useEffect, useState } from "react"
import { Link, useLocation } from "react-router"
import { CircleDot, MessageSquare } from "lucide-react"
import { useConnection } from "@/app/connection"
import { useSession } from "@/app/session"
import { EmptyState, FailureState, LoadingState, Pager, UnavailableState, useListParams } from "@/components/listing"
import { countText, linkClass } from "@/components/thread/config"
import { Instant } from "@/components/thread/ThreadParts"
import { listNotifications, notificationRoute, notificationsRoute, onNotificationsChanged, type NotificationItem } from "@/lib/notifications"
import { useResource } from "@/lib/resource"
import { loginPath } from "@/lib/session"

const kindNouns: Record<string, string> = { issues: "Issue", discussions: "Discussion", patches: "Patch" }

function NotificationRow({ item }: { item: NotificationItem }) {
  const noun = kindNouns[item.thread.kind] ?? "Thread"
  return (
    <li className={`flex gap-3 px-4 py-3 ${item.unread ? "bg-primary/5" : ""}`} data-unread={item.unread}>
      <span className="mt-1.5 w-2 shrink-0" aria-hidden>{item.unread && <span className="block size-2 rounded-full bg-primary" />}</span>
      <div className="min-w-0">
        <Link to={notificationRoute(item)} className={`text-foreground underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${item.unread ? "font-semibold" : "font-normal"}`}>
          {item.title}
        </Link>
        {item.unread && <span className="sr-only"> (unread)</span>}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            {item.thread.kind === "discussions" ? <MessageSquare size={12} aria-hidden /> : <CircleDot size={12} aria-hidden />}
            {noun} in {item.repo.owner}/{item.repo.name}
          </span>
          <span>Updated <Instant value={item.updated_at} /></span>
          {item.unread && <span className="rounded-full border border-primary/40 px-1.5 font-medium text-primary">Unread</span>}
        </div>
      </div>
    </li>
  )
}

/**
 * `/notifications`: the signed-in viewer's inbox, newest first, unread ones
 * marked, each linking to its thread. Opening the thread is what marks it
 * read (its page acknowledges it once shown), never this list. Server mode only.
 */
export function NotificationsPage() {
  const { check } = useConnection()
  const { viewer } = useSession()
  const location = useLocation()

  if (check?.kind === "connected" && check.status.mode === "local") {
    return <UnavailableState title="Notifications">Local mode serves a single repository without accounts, so nobody is notified of anything.</UnavailableState>
  }
  if (!viewer) {
    return (
      <section className="max-w-md">
        <h1 className="text-3xl font-semibold tracking-tight">Notifications</h1>
        <p className="mt-3 text-muted-foreground">Log in to see your notifications.</p>
        <Link to={loginPath(location.pathname + location.search)} className={`mt-6 inline-block text-sm ${linkClass}`}>Log in</Link>
      </section>
    )
  }
  return <Inbox />
}

function Inbox() {
  const { cursor } = useListParams()
  const location = useLocation()
  // read again on each navigation, so threads read elsewhere show as read, and
  // whenever this tab changes read state (an acknowledgement landing late)
  const [changes, setChanges] = useState(0)
  useEffect(() => onNotificationsChanged(() => setChanges((value) => value + 1)), [])
  const inbox = useResource(`notifications ${cursor}`, (signal) => listNotifications({ cursor }, { signal }), `${location.key} ${changes}`)
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight">
        Notifications
        {inbox.kind === "loaded" && inbox.data.page.count.kind !== "unknown" && <span className="ml-3 text-base font-normal text-muted-foreground">{countText(inbox.data.page.count)}</span>}
      </h1>
      {inbox.kind === "loaded" && <p className="mt-2 text-muted-foreground">{inbox.data.unread_count === 0 ? "Everything is read." : `${inbox.data.unread_count} unread.`}</p>}
      {inbox.kind === "loading" && <LoadingState>Loading your notifications…</LoadingState>}
      {inbox.kind === "failed" && (
        inbox.error.code === "validation" && cursor
          ? <EmptyState title="This page is no longer available"><Link to={notificationsRoute()} className={linkClass}>Back to the first page</Link></EmptyState>
          : <FailureState title="Couldn't load your notifications" error={inbox.error} onRetry={inbox.reload} />
      )}
      {inbox.kind === "loaded" && (
        inbox.data.items.length === 0 ? (
          cursor
            ? <EmptyState title="No more notifications"><Link to={notificationsRoute()} className={linkClass}>Back to the first page</Link></EmptyState>
            : <EmptyState title="No notifications">Activity by others on threads you opened, are assigned to, commented on or subscribed to shows here.</EmptyState>
        ) : (
          <>
            <ul aria-label="Notifications" className="mt-6 divide-y rounded-xl border bg-card">
              {inbox.data.items.map((item) => <NotificationRow key={item.id} item={item} />)}
            </ul>
            <Pager page={inbox.data.page} search="" cursor={cursor} noun="Notification" base={notificationsRoute()} />
          </>
        )
      )}
    </>
  )
}
