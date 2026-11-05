import { useState, type ReactNode } from "react"
import { Link } from "react-router"
import { LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { failureOf, FormMessage } from "@/components/form"
import { countText, linkClass } from "@/components/thread/config"
import { ApiError, type Count } from "@/lib/api"
import { useResource } from "@/lib/resource"
import { readSync, runSync, type SyncRecord, type SyncStatus } from "@/lib/sync"
import { threadRoute } from "@/lib/threads"
import { useWrite } from "@/pages/settings/shared"

const local = { kind: "local" } as const

function When({ value }: { value: string }) {
  return <time dateTime={value} title={value}>{new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>
}

function stateText(status: SyncStatus): string {
  const remote = status.remote ?? "the remote"
  switch (status.state) {
    case "no_remote": return "This repository has no remote, so there is nothing to sync with. Add one with git remote add."
    case "not_fetched": return `Haxy has no copy of ${remote}'s events yet: it hasn't synced, or ${remote} has none.`
    case "in_sync": return `Events match ${remote}'s as of the last sync.`
    case "sync_needed": return `Events differ from ${remote}'s as of the last sync: a sync is needed.`
  }
}

/** A finished sync: success, or what failed and what it left behind (in Haxy's words, with the remote's own). */
function SyncResult({ record, remote, prefix }: { record: SyncRecord; remote: string; prefix?: ReactNode }) {
  if (record.failure === null) {
    return <FormMessage kind="success">{prefix}Synced with {remote} at <When value={record.finished_at} />.</FormMessage>
  }
  return (
    <FormMessage kind="error">
      <p>{prefix}The sync at <When value={record.finished_at} /> failed. {record.failure.message}</p>
      {record.failure.remote_message && <p className="mt-1">The remote said: <q className="font-mono text-xs">{record.failure.remote_message}</q></p>}
    </FormMessage>
  )
}

function plural(count: Count, one: string, many: string): string {
  return count.kind === "exact" && count.value === 1 ? one : many
}

function hasAny(count: Count): boolean {
  return count.kind !== "exact" || count.value > 0
}

/** Unresolved metadata conflicts, with where to see them (resolving them comes later). */
function Conflicts({ conflicts }: { conflicts: SyncStatus["conflicts"] }) {
  if (conflicts === null) {
    return <p className="mt-4 text-sm text-muted-foreground">Haxy couldn't read this repository's events, so it can't say which have metadata conflicts.</p>
  }
  const { issues, patches } = conflicts
  if (!hasAny(issues.count) && !hasAny(patches.count)) return null
  const more = issues.count.kind !== "exact" || issues.count.value > issues.items.length
  return (
    <section aria-label="Metadata conflicts" className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm">
      <h3 className="flex items-center gap-2 font-medium"><TriangleAlert size={16} aria-hidden />Unresolved metadata conflicts</h3>
      <p className="mt-1 text-muted-foreground">
        Concurrent edits on both sides changed the same fields. Each keeps this repository's value until the conflict is resolved; conflicted issues are marked in the issue lists.
      </p>
      {hasAny(issues.count) && (
        <>
          <p className="mt-2">{countText(issues.count)} {plural(issues.count, "issue has", "issues have")} a conflict:</p>
          <ul className="mt-1 list-disc pl-5">
            {issues.items.map((issue) => <li key={issue.id}><Link to={threadRoute(local, "issues", issue.id)} className={linkClass}>{issue.title}</Link></li>)}
          </ul>
          {more && <p className="mt-1 text-muted-foreground">More are marked in the issue lists.</p>}
        </>
      )}
      {hasAny(patches.count) && (
        <p className="mt-2">{countText(patches.count)} {plural(patches.count, "patch has", "patches have")} a conflict. Haxy Hub has no patch pages yet; see them in Haxy's patches tab.</p>
      )}
    </section>
  )
}

/** A sync whose end the panel waits to learn, and why: its own answer was lost, or another sync was running. */
type Pending = { before: string | null; reason: "lost" | "busy" }

/** What a sync whose answer was lost turned out to be, from a fresh read. */
type Settled =
  | { kind: "running" }
  | { kind: "finished"; record: SyncRecord }
  | { kind: "no_record" }

function settle(status: SyncStatus, before: string | null): Settled {
  if (status.running) return { kind: "running" }
  if (status.last !== null && status.last.id !== before) return { kind: "finished", record: status.last }
  return { kind: "no_record" }
}

/**
 * Local mode's sync with its remote, above the events list: where the events
 * stand against the remote, a button that runs Haxy's sync (which answers
 * once it finished), its outcome, and any metadata conflicts.
 */
export function SyncPanel({ onSynced }: { onSynced(): void }) {
  const loaded = useResource("sync", (signal) => readSync({ signal }))
  // the newest answer: a sync's own, or a read that settled one
  const [answer, setAnswer] = useState<{ status: SyncStatus; note: ReactNode; record: SyncRecord | null } | null>(null)
  const [message, setMessage] = useState<ReactNode>(null)
  // a sync whose end this panel waits to learn: its own whose answer was lost,
  // or another one (another tab, the TUI) that was running when this one was
  // asked for. `before` is the last sync's id seen before.
  const write = useWrite<Pending>()

  const status = answer?.status ?? (loaded.kind === "loaded" ? loaded.data : null)

  async function check(pending: Pending, current: () => boolean) {
    let fresh: SyncStatus
    try {
      fresh = await readSync()
    } catch (error) {
      if (!current()) return
      write.setUnresolved(pending)
      setMessage(<>{failureOf(error, "Couldn't check the sync.").cause} {pending.reason === "lost" ? "Haxy may or may not have synced. " : ""}Check again before syncing.</>)
      return
    }
    if (!current()) return
    const settled = settle(fresh, pending.before)
    if (settled.kind === "running") {
      write.setUnresolved(pending)
      setAnswer({ status: fresh, note: null, record: null })
      setMessage(pending.reason === "lost"
        ? <>The sync is still running in Haxy. Check again in a moment.</>
        : <>A sync is already running in Haxy (from another tab or the terminal). Check again once it has finished.</>)
      return
    }
    write.setUnresolved(null)
    setMessage(null)
    if (settled.kind === "finished") {
      const note = pending.reason === "lost" ? "Haxy's answer was lost, but a sync has finished since: " : "The other sync has finished: "
      setAnswer({ status: fresh, note, record: settled.record })
      onSynced()
    } else {
      setAnswer({ status: fresh, note: null, record: null })
      setMessage(pending.reason === "lost"
        ? <>Haxy's answer was lost, and Haxy has no record of a sync finishing since (it may not have started, or Haxy restarted). You can sync again.</>
        : <>No sync is running now, and Haxy has no record of one finishing (Haxy may have restarted). You can sync again.</>)
    }
  }

  function sync() {
    const before = status?.last?.id ?? null
    void write.start(async (current) => {
      setMessage(null)
      try {
        const synced = await runSync()
        if (!current()) return
        setAnswer({ status: synced, note: null, record: synced.last })
        onSynced()
      } catch (error) {
        if (!current()) return
        // another sync is running: wait for it like for a lost answer
        if (error instanceof ApiError && error.code === "conflict") return check({ before, reason: "busy" }, current)
        const failure = failureOf(error, "Haxy Hub couldn't read Haxy's answer.")
        if (!failure.unknown) {
          setMessage(<>{failure.message}</>)
          return
        }
        await check({ before, reason: "lost" }, current)
      }
    })
  }

  if (loaded.kind === "failed" && answer === null) {
    return (
      <section role="alert" aria-label="Sync" className="mt-6 rounded-xl border border-destructive/40 bg-card p-6">
        <h2 className="font-medium">Couldn't read the sync status</h2>
        <p className="mt-1 text-sm text-muted-foreground">{loaded.error.message}</p>
        <Button className="mt-4" variant="outline" onClick={loaded.reload}><RefreshCw />Retry</Button>
      </section>
    )
  }

  const remote = status?.remote ?? null
  return (
    <section aria-label="Sync" className="mt-6 rounded-xl border bg-card p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Sync{remote ? ` with ${remote}` : ""}</h2>
        {status && remote !== null && (
          write.unresolved ? (
            <Button variant="outline" size="sm" className="ml-auto" disabled={write.busy} onClick={() => void write.check((pending, current) => check(pending, current))}><RefreshCw />Check again</Button>
          ) : (
            <Button size="sm" className="ml-auto" disabled={write.blocked || status.running} onClick={(event) => { if (event.detail <= 1) sync() }}>
              {write.busy ? <><LoaderCircle className="animate-spin" />Syncing…</> : <><RefreshCw />Sync now</>}
            </Button>
          )
        )}
      </div>
      {status === null ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">Reading the sync status…</p>
      ) : (
        <>
          <p className="mt-2 text-sm text-muted-foreground">{stateText(status)}</p>
          {write.busy && <p role="status" className="mt-2 text-sm">Syncing with {remote}… This waits for Haxy to finish, however long the remote takes.</p>}
          {!write.busy && status.running && !write.unresolved && (
            <p role="status" className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              A sync is running in Haxy.
              <Button variant="outline" size="sm" disabled={write.busy} onClick={() => { const before = status.last?.id ?? null; void write.start((current) => check({ before, reason: "busy" }, current)) }}><RefreshCw />Check again</Button>
            </p>
          )}
          {message && <div className="mt-3"><FormMessage kind="error">{message}</FormMessage></div>}
          {answer?.record && remote && <div className="mt-3"><SyncResult record={answer.record} remote={remote} prefix={answer.note} /></div>}
          {!answer?.record && !message && status.last && remote && <div className="mt-3"><SyncResult record={status.last} remote={remote} prefix="Last sync: " /></div>}
          <Conflicts conflicts={status.conflicts} />
        </>
      )}
    </section>
  )
}
