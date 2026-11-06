import { useEffect, useState } from "react"
import { Link, useLocation } from "react-router"
import { Bell } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useConnection } from "@/app/connection"
import { useSession } from "@/app/session"
import { onNotificationsChanged, unreadCount } from "@/lib/notifications"

/**
 * The viewer's unread notification count: read for each viewer, again on
 * every navigation (so another tab's or client's changes show on the next
 * one), and right after this tab changes read state. Null until known, and
 * while a read fails (the count is then left out rather than guessed).
 */
export function useUnreadCount(enabled: boolean, viewerKey: string): number | null {
  const location = useLocation()
  const [changes, setChanges] = useState(0)
  const [count, setCount] = useState<{ key: string; value: number | null }>({ key: viewerKey, value: null })

  useEffect(() => onNotificationsChanged(() => setChanges((value) => value + 1)), [])

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    unreadCount({ signal: controller.signal }).then(
      (value) => { if (!controller.signal.aborted) setCount({ key: viewerKey, value }) },
      () => { if (!controller.signal.aborted) setCount({ key: viewerKey, value: null }) },
    )
    return () => controller.abort()
  }, [enabled, viewerKey, location.key, changes])

  // another viewer's count is never shown, even for a moment
  return enabled && count.key === viewerKey ? count.value : null
}

/** The header's link to the inbox, with the unread count. Only for a signed-in viewer on a server. */
export function NotificationsLink() {
  const { check } = useConnection()
  const { ready, viewer, viewerKey } = useSession()
  const enabled = check?.kind === "connected" && check.status.mode === "server" && ready && viewer !== null
  const count = useUnreadCount(enabled, viewerKey)
  if (!enabled) return null
  const label = count === null ? "Notifications" : `Notifications, ${count} unread`
  return (
    <Button asChild variant="ghost" size="sm">
      <Link to="/notifications" aria-label={label} title={label} className="relative">
        <Bell />
        {count !== null && count > 0 && (
          <span data-testid="unread-count" className="min-w-5 rounded-full bg-primary px-1.5 text-center text-xs font-semibold text-primary-foreground">{count > 99 ? "99+" : count}</span>
        )}
      </Link>
    </Button>
  )
}
