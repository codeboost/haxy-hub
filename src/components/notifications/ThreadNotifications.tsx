import { useEffect, useRef, useState, type MouseEvent } from "react"
import { BellOff, BellRing, LoaderCircle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FailureMessage, FormMessage, failureOf, type Failure } from "@/components/form"
import type { AnswerClock } from "@/components/assignees/useThreadAnswers"
import type { ThreadConfig } from "@/components/thread/config"
import type { EventId } from "@/lib/api"
import { acknowledgeThread, getThreadNotification, notificationsChanged, setThreadNotification, type NotificationRead, type NotifyMode } from "@/lib/notifications"
import type { RepoLocator } from "@/lib/repo"
import type { ThreadKind, WriteViewer } from "@/lib/threads"
import { useWrite } from "@/pages/settings/shared"
import { Unresolved } from "@/pages/settings/Unresolved"

// How a thread page keeps the viewer's notification state, kept small so its
// interleavings are plain:
//
// - The state is read together with the thread, in the page's one read
//   (`withNotification`), so whatever the page shows of it belongs to the
//   thread shown with it. A refresh that fails keeps both, and a retry reads
//   both again.
// - Read state is acknowledged from that read only: once per bump it names as
//   unread, while the tab is visible. Its answer changes nothing on the page
//   (the panel doesn't show read state); it only makes the header count again.
// - Whether the viewer is notified is shown from that read, or from the latest
//   answer to a subscribe or mute (or a read settling one, or a read after an
//   assignee change, which may notify the viewer) when that arrived after the
//   read started. All of those run one at a time (`useWrite`), so their answers
//   can't cross each other; a read after assignee changes waits for whatever
//   runs, then covers every change made meanwhile. Acknowledgements never touch
//   this. Every subscribe or mute that lands makes the header count again, even
//   when its page is gone by then.

/**
 * What a page that loads its comments on their own (the thread page) must
 * have shown before it acknowledges: comments read after the notification
 * state answered. Null for a page whose comment read is part of its own read
 * (a comment's own page).
 */
export type CommentsShown = {
  /** When the state the page shows answered (`nextReadOrder`). */
  stateAt: number
  /** When the latest comment read that succeeded went out, 0 before any did. */
  commentsFrom: number
  /** Reads the comments again. */
  readComments(): void
}

/**
 * The comments a thread page has shown, against the state it read (for
 * `ThreadNotifications`), and what its `ThreadComments` takes to report them:
 * when each read that succeeded went out, and a way to read them once more.
 */
export function useCommentsShown(stateAt: number): { comments: CommentsShown; commentReads: { refresh: number; onLoaded(startedAt: number): void } } {
  const [commentsFrom, setCommentsFrom] = useState(0)
  const [refresh, setRefresh] = useState(0)
  return {
    comments: { stateAt, commentsFrom, readComments: () => setRefresh((count) => count + 1) },
    commentReads: { refresh, onLoaded: (startedAt) => setCommentsFrom((latest) => Math.max(latest, startedAt)) },
  }
}

/**
 * Acknowledges a thread the page shows, from the notification state read with
 * it: once per bump it names as unread, once the page has shown comments read
 * after that state (any page of them: the TUI also marks a thread read on
 * viewing it), only while the browser tab is visible (a page opened in a
 * background tab waits until it is looked at), bound to the viewer the page
 * was loaded for, and never retried automatically.
 */
export function useAcknowledgement(repo: RepoLocator, kind: ThreadKind, thread: EventId, viewer: WriteViewer, read: NotificationRead, comments: CommentsShown | null) {
  const acknowledged = useRef(new Set<string>())
  const requested = useRef(new Set<string>())
  const unread = read.kind === "loaded" && read.value.notification?.unread ? read.value.notification.revision : null
  // shown: comments read after the state answered; stale: only older ones succeeded (a refresh read them meanwhile)
  const shown = comments === null || comments.commentsFrom > comments.stateAt
  const stale = comments !== null && comments.commentsFrom > 0 && !shown

  useEffect(() => {
    if (unread === null || acknowledged.current.has(unread)) return
    if (!shown) {
      // comments read before the state answered can't show its bump: read them once more,
      // once per state read (a read cut short by a page change leaves the next state read
      // free to ask again; a failed read waits for its own Retry)
      const attempt = `${comments.stateAt} ${unread}`
      if (stale && !requested.current.has(attempt)) {
        requested.current.add(attempt)
        comments.readComments()
      }
      return
    }
    const revision = unread
    const send = () => {
      if (document.visibilityState !== "visible" || acknowledged.current.has(revision)) return false
      acknowledged.current.add(revision)
      // the header counts again (`acknowledgeThread`); a failure waits for a later visit
      acknowledgeThread(repo, kind, thread, viewer, revision).catch(() => {})
      return true
    }
    if (send()) return
    const onVisible = () => { if (send()) document.removeEventListener("visibilitychange", onVisible) }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
    // the bump named, the state read naming it, and whether comments read after it were shown
  }, [unread, shown, stale, comments?.stateAt])
}

/** The acknowledgement alone, for pages that show a thread without its panel (a comment's own page). */
export function ThreadAcknowledgement({ repo, kind, thread, viewer, read }: { repo: RepoLocator; kind: ThreadKind; thread: EventId; viewer: WriteViewer; read: NotificationRead }) {
  // its comment read is part of the page's read, which went out after the state answered
  useAcknowledgement(repo, kind, thread, viewer, read, null)
  return null
}

/** A write whose outcome Haxy couldn't confirm, and that reading the state couldn't settle either. */
type Unknown = { mode: NotifyMode; cause: string }

const verbs: Record<NotifyMode, { label: string; failed: string; done: string }> = {
  subscribed: { label: "Subscribe", failed: "Subscribing failed.", done: "You're subscribed." },
  muted: { label: "Mute", failed: "Muting failed.", done: "Muted. You won't be notified of this thread." },
}

/**
 * Whether Haxy notifies the viewer of a thread, with the TUI's one button:
 * Mute while it does, Subscribe while it doesn't. A thread at its subscriber
 * cap refuses with Haxy's message. An outcome Haxy couldn't confirm is settled
 * by reading the state again (both changes are safe to repeat). It also
 * acknowledges the thread (`useAcknowledgement`). Nothing is shown in local
 * mode or to nobody signed in.
 */
export function ThreadNotifications<Status extends string>({ repo, config, thread, viewer, read, readStartedAt, clock, onRetry, refresh, comments }: {
  repo: RepoLocator
  config: ThreadConfig<Status>
  thread: EventId
  viewer: WriteViewer
  /** The state as the page's read of the thread found it. */
  read: NotificationRead
  /** When that read started, on the page's `clock`. */
  readStartedAt: number
  clock: AnswerClock
  /** Reads the page (the thread and this state) again. */
  onRetry(): void
  /** Changes when something else on the page may have changed the state (an assignee change): it is read again. */
  refresh: number
  /** The comments the page has shown, against the state. */
  comments: CommentsShown
}) {
  useAcknowledgement(repo, config.kind, thread, viewer, read, comments)
  const write = useWrite<Unknown>()
  const [failure, setFailure] = useState<Failure | null>(null)
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null)
  // the latest answer about whether the viewer is notified, and when it arrived
  const [answer, setAnswer] = useState<{ at: number; notified: boolean } | null>(null)

  // an assignee change waiting for its read: it runs once nothing else does, and
  // any number of changes meanwhile are covered by that one read
  const refreshPending = useRef(false)
  useEffect(() => {
    if (refresh !== 0) refreshPending.current = true
  }, [refresh])
  useEffect(() => {
    if (!refreshPending.current || read.kind === "off" || write.blocked) return
    void write.start(async (current) => {
      refreshPending.current = false
      try {
        const now = await getThreadNotification(repo, config.kind, thread)
        if (current()) setAnswer({ at: ++clock.now, notified: now.notified })
      } catch {
        // the next read of the page shows it
      }
    })
  }, [refresh, write.blocked])

  if (read.kind === "off") return null
  const noun = config.noun.toLowerCase()
  const notified = answer && answer.at > readStartedAt ? answer.notified : read.kind === "loaded" ? read.value.notified : null
  // a click that continues a double (or triple) click; keyboard activation is 0
  const repeated = (event: MouseEvent) => event.detail > 1

  /** Shows what Haxy answered about the viewer's notifications. */
  function show(value: { notified: boolean }) {
    setAnswer({ at: ++clock.now, notified: value.notified })
  }

  /** What a read after an unknown outcome says; false when Haxy couldn't say. */
  async function settle(unknown: Unknown, current: () => boolean): Promise<boolean> {
    let now
    try {
      now = await getThreadNotification(repo, config.kind, thread)
    } catch {
      return false
    }
    // the change may have landed (a mute drops a notification): the header counts again, even once this page is gone
    notificationsChanged()
    if (!current()) return true
    show(now)
    const wanted = unknown.mode === "subscribed"
    if (now.notified === wanted) setNotice({ kind: "success", text: verbs[unknown.mode].done })
    else setNotice({ kind: "error", text: `Haxy couldn't confirm what happened to this request (${unknown.cause}). The state shown is Haxy's now; trying again is safe.` })
    return true
  }

  function change(mode: NotifyMode) {
    void write.start(async (current) => {
      setFailure(null)
      setNotice(null)
      try {
        const value = await setThreadNotification(repo, config.kind, thread, viewer, mode)
        // a mute drops a notification: the header counts again, even once this page is gone
        notificationsChanged()
        if (!current()) return
        show(value)
        setNotice({ kind: "success", text: verbs[mode].done })
      } catch (error) {
        const failed = failureOf(error, verbs[mode].failed)
        // it may have landed (a mute drops a notification): the header and an
        // open inbox read again, even once this page is gone
        if (failed.unknown) notificationsChanged()
        if (!current()) return
        if (!failed.unknown) return setFailure(failed)
        const unknown = { mode, cause: failed.cause }
        if (!(await settle(unknown, current)) && current()) write.setUnresolved(unknown)
      }
    })
  }

  const check = () => write.check(async (unknown, current) => {
    if (await settle(unknown, current)) write.setUnresolved(null)
  })

  return (
    <section aria-labelledby="thread-notifications" className="mt-6">
      <h3 id="thread-notifications" className="mb-2 text-sm font-semibold">Notifications</h3>
      {notified === null && read.kind === "failed" && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
          <span>Couldn't load your notification settings: {read.error.message}</span>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}><RefreshCw />Retry</Button>
        </div>
      )}
      {notified !== null && (
        <div className="max-w-md space-y-3">
          <p className="text-sm text-muted-foreground">
            {notified ? `You're notified of activity on this ${noun}.` : `You're not notified of activity on this ${noun}.`}
          </p>
          {failure && <FailureMessage failure={failure} />}
          {notice && <FormMessage kind={notice.kind}>{notice.text}</FormMessage>}
          {write.unresolved && (
            <Unresolved pending={write.busy} onCheck={() => void check()}
              message={`Haxy couldn't confirm what happened to this request (${write.unresolved.cause}), and couldn't be reached to check. Check again before changing your notifications.`} />
          )}
          {notified ? (
            <Button type="button" variant="outline" size="sm" disabled={write.blocked} onClick={(event) => { if (!repeated(event)) change("muted") }}>
              {write.busy ? <LoaderCircle className="animate-spin" /> : <BellOff />}{verbs.muted.label}
            </Button>
          ) : (
            <Button type="button" variant="outline" size="sm" disabled={write.blocked} onClick={(event) => { if (!repeated(event)) change("subscribed") }}>
              {write.busy ? <LoaderCircle className="animate-spin" /> : <BellRing />}{verbs.subscribed.label}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
