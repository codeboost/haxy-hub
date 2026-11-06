import { useEffect, useRef, useState, type MouseEvent } from "react"
import { Link, useNavigate } from "react-router"
import { LoaderCircle, Pencil, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FailureMessage, FormMessage, failureOf, type Failure } from "@/components/form"
import { ApiError } from "@/lib/api"
import type { RepoLocator } from "@/lib/repo"
import { editThreadRoute, findThread, removeThread, setThreadStatus, threadsRoute, type ThreadDetail, type WriteViewer } from "@/lib/threads"
import { readStart, type ThreadReads } from "@/components/assignees/useThreadAnswers"
import { branchLabels } from "./BranchFields"
import { useGateReport, type WriteGate } from "./writeGate"
import type { ThreadConfig } from "./config"
import { useStillHere } from "@/lib/stillHere"

/**
 * A thread's own actions — edit, close or reopen, remove — each shown only
 * when Haxy says the viewer may take it (its `actions`; Haxy checks again
 * when it runs). Removing asks first. One action runs at a time, and the
 * later clicks of a double click are ignored even when the first one's
 * answer has already turned the button into its opposite (Close into
 * Reopen), so a double click is one write; an outcome Haxy couldn't confirm is
 * settled by reading the thread again before anything is offered again.
 */
export function ThreadActions<Status extends string>({ repo, config, thread, viewer, onChanged, reads, gate }: {
  repo: RepoLocator
  config: ThreadConfig<Status>
  thread: ThreadDetail<Status>
  viewer: WriteViewer
  /** The thread as Haxy answered a change. */
  onChanged(thread: ThreadDetail<Status>): void
  /** Where a read that settles an unknown outcome goes, ordered by when it started. */
  reads: ThreadReads<ThreadDetail<Status>>
  /** Where the page holds these writes while another of its writes is in flight, if it does. */
  gate?: WriteGate
}) {
  const navigate = useNavigate()
  const [pending, setPending] = useState<"status" | "remove" | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // set synchronously, so a double click can't start a second write
  const busy = useRef(false)
  const mounted = useRef(true)
  const here = useStillHere()
  useGateReport(gate, pending !== null)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const held = pending !== null || gate?.blocked === true
  const noun = config.noun.toLowerCase()
  const listRoute = threadsRoute(repo, config.kind, config.statuses, thread.status)
  const change = config.statusChanges[thread.status]
  const { actions } = thread
  // a click that continues a double (or triple) click; keyboard activation is 0
  const repeated = (event: MouseEvent) => event.detail > 1
  if (!actions.edit.available && !actions.set_status.available && !actions.remove.available) return null

  async function run(kind: "status" | "remove", write: () => Promise<void>, settle: (cause: string) => Promise<void>) {
    if (busy.current || gate?.blocked) return
    busy.current = true
    setPending(kind)
    setFailure(null)
    setNotice(null)
    try {
      await write()
    } catch (error) {
      if (!mounted.current) return
      const failed = failureOf(error, `Changing the ${noun} failed.`)
      if (failed.unknown) await settle(failed.cause).catch(() => setFailure(failed))
      else setFailure(failed)
    } finally {
      busy.current = false
      if (mounted.current) setPending(null)
    }
  }

  const changeStatus = (to: Status) => run("status", async () => {
    const updated = await setThreadStatus<Status>(repo, config.kind, thread.id, viewer, to)
    if (mounted.current) onChanged(updated)
  }, async (cause) => {
    // setting a status is the same whether or not it ran before, so the
    // thread as it is now is all there is to say
    const startedAt = readStart(reads.clock)
    const current = await findThread<Status>(repo, config.kind, thread.id)
    if (!mounted.current) return
    if (current === null) return void (here.current && navigate(listRoute))
    reads.onRead(current, startedAt)
    setNotice(`Haxy couldn't confirm what happened to this request (${cause}). This is the ${noun} as it is now.`)
  })

  const remove = () => run("remove", async () => {
    try {
      await removeThread(repo, config.kind, thread.id, viewer)
    } catch (error) {
      // already gone, which is what was asked
      if (!(error instanceof ApiError && error.code === "not_found")) throw error
    }
    if (here.current) await navigate(listRoute)
  }, async (cause) => {
    const startedAt = readStart(reads.clock)
    const current = await findThread<Status>(repo, config.kind, thread.id)
    if (!mounted.current) return
    if (current === null) return void (here.current && navigate(listRoute))
    setConfirming(false)
    reads.onRead(current, startedAt)
    setNotice(`Haxy couldn't confirm what happened to this request (${cause}). The ${noun} still exists; remove it again to try once more.`)
  })

  return (
    <div className="mt-4 space-y-3">
      {/* the actions have no fields, so a refusal's field errors (a patch's branch gone) are said here */}
      {failure && <FailureMessage failure={failure} shown={[]} labels={branchLabels} />}
      {notice && <FormMessage kind="error">{notice}</FormMessage>}
      <div role="group" aria-label={`${config.noun} actions`} className="flex flex-wrap gap-2">
        {actions.edit.available && (
          <Button asChild variant="outline" size="sm"><Link to={editThreadRoute(repo, config.kind, thread.id)}><Pencil />Edit</Link></Button>
        )}
        {actions.set_status.available && change && (
          <Button type="button" variant="outline" size="sm" disabled={held} onClick={(event) => { if (!repeated(event)) void changeStatus(change.to) }}>
            {pending === "status" && <LoaderCircle className="animate-spin" />}{change.label}
          </Button>
        )}
        {actions.remove.available && !confirming && (
          <Button type="button" variant="outline" size="sm" disabled={held} onClick={(event) => { if (repeated(event)) return; setFailure(null); setConfirming(true) }}><Trash2 />Remove</Button>
        )}
      </div>
      {confirming && (
        <section role="alertdialog" aria-label={`Remove this ${noun}?`} aria-describedby="thread-remove-text" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <p id="thread-remove-text" className="text-sm">Remove “{thread.title}”? It disappears from this repository's {config.plural.toLowerCase()} for everyone, along with its page.</p>
          <div className="mt-3 flex gap-2">
            <Button type="button" variant="destructive" size="sm" disabled={held} onClick={(event) => { if (!repeated(event)) void remove() }}>
              {pending === "remove" ? <LoaderCircle className="animate-spin" /> : <Trash2 />}Remove {noun}
            </Button>
            <Button type="button" variant="outline" size="sm" autoFocus disabled={held} onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        </section>
      )}
    </div>
  )
}
