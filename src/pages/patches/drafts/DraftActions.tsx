import { useState, type MouseEvent } from "react"
import { Link, useNavigate } from "react-router"
import { LoaderCircle, Pencil, RefreshCw, Send, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FailureMessage, FormMessage, failureOf, type Failure } from "@/components/form"
import { ApiError } from "@/lib/api"
import { draftState, draftsRoute, editDraftRoute, publishDraft, removeDraft, type DraftDetail } from "@/lib/drafts"
import type { RepoLocator } from "@/lib/repo"
import { threadRoute, type WriteViewer } from "@/lib/threads"
import { useWrite } from "@/pages/settings/shared"

type Pending = "publish" | "remove"

/** Where a write whose outcome is unknown left the draft: published, still a draft, or gone. */
type Settled = Awaited<ReturnType<typeof draftState>>

const unconfirmed = (cause: string) => `Haxy couldn't confirm what happened to this request (${cause}).`

const publishNotices: Record<Exclude<Settled, "published">, string> = {
  draft: "The draft wasn't published; publish it again to try once more.",
  gone: "The draft is gone and no patch was published from it.",
}

/** What to do once a write's outcome is settled: go somewhere, or say what happened. */
type Outcome = { to: string } | { notice: string }

// a click that continues a double (or triple) click; keyboard activation is 0
const repeated = (event: MouseEvent) => event.detail > 1

/** Where a settled write leaves the page: the patch it published, the drafts list, or here with a word on what happened. */
function outcomeOf(repo: RepoLocator, id: string, write: { kind: Pending; cause: string }, state: Settled): Outcome {
  if (write.kind === "publish") return state === "published" ? { to: threadRoute(repo, "patches", id) } : { notice: `${unconfirmed(write.cause)} ${publishNotices[state]}` }
  return state === "draft" ? { notice: `${unconfirmed(write.cause)} The draft still exists; remove it again to try once more.` } : { to: draftsRoute(repo) }
}

/** A write whose outcome is unknown and that a read couldn't settle either: it may still land. */
type Unresolved = { kind: Pending; cause: string }

/**
 * A draft's writes, one at a time: a refusal keeps Haxy's reason, and an
 * outcome Haxy couldn't confirm is settled by reading the patch and the draft
 * again. Until a read settles it, every write is held and only a check is
 * offered, since the first may still land.
 */
function useDraftWrites(repo: RepoLocator, draft: DraftDetail, viewer: WriteViewer) {
  const navigate = useNavigate()
  const write = useWrite<Unresolved>()
  const [pending, setPending] = useState<Pending | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const patchRoute = threadRoute(repo, "patches", draft.id)

  async function settle(unresolved: Unresolved, current: () => boolean) {
    const state = await draftState(repo, draft.id).catch(() => null)
    if (!current()) return
    if (state === null) {
      write.setUnresolved(unresolved)
      return setNotice(`${unconfirmed(unresolved.cause)} Haxy couldn't say what happened either, so check again before trying once more.`)
    }
    write.setUnresolved(null)
    const outcome = outcomeOf(repo, draft.id, unresolved, state)
    if ("to" in outcome) await navigate(outcome.to)
    else setNotice(outcome.notice)
  }

  const run = (kind: Pending, operation: () => Promise<string>) => write.start(async (current) => {
    setPending(kind)
    setFailure(null)
    setNotice(null)
    try {
      const next = await operation()
      if (current()) await navigate(next)
    } catch (error) {
      const failed = failureOf(error, kind === "publish" ? "Publishing the draft failed." : "Removing the draft failed.")
      if (!current()) return
      if (failed.unknown) await settle({ kind, cause: failed.cause }, current)
      else setFailure(failed)
    } finally {
      if (current()) setPending(null)
    }
  })

  const publish = () => run("publish", async () => (await publishDraft(repo, draft.id, viewer), patchRoute))
  const remove = () => run("remove", async () => {
    // already gone is what was asked
    await removeDraft(repo, draft.id, viewer).catch((error: unknown) => { if (!(error instanceof ApiError && error.code === "not_found")) throw error })
    return draftsRoute(repo)
  })
  const checkAgain = () => write.check((unresolved, current) => (setNotice(null), settle(unresolved, current)))
  return { pending, failure, notice, blocked: write.blocked, unresolved: write.unresolved !== null, publish, remove, checkAgain, clearFailure: () => setFailure(null) }
}

/**
 * A draft's own actions — edit, publish, remove — each offered when Haxy
 * says its author may take it (Haxy checks again when it runs, and a refusal
 * says Haxy's reason; an unavailable publication says why). Removing asks
 * first.
 */
export function DraftActions({ repo, draft, viewer }: { repo: RepoLocator; draft: DraftDetail; viewer: WriteViewer }) {
  const writes = useDraftWrites(repo, draft, viewer)
  const [confirming, setConfirming] = useState(false)
  const { actions } = draft
  const busy = writes.blocked
  return (
    <div className="mt-4 space-y-3">
      {writes.failure && <FailureMessage failure={writes.failure} shown={[]} />}
      {writes.notice && (
        <FormMessage kind="error">
          <p>{writes.notice}</p>
          {writes.unresolved && <Button type="button" variant="outline" size="sm" className="mt-2" disabled={writes.pending !== null} onClick={() => void writes.checkAgain()}><RefreshCw />Check again</Button>}
        </FormMessage>
      )}
      <div role="group" aria-label="Draft actions" className="flex flex-wrap items-center gap-2">
        {/* while a write may still land, the edit form waits too */}
        {actions.edit.available && (busy
          ? <Button type="button" variant="outline" size="sm" disabled><Pencil />Edit</Button>
          : <Button asChild variant="outline" size="sm"><Link to={editDraftRoute(repo, draft.id)}><Pencil />Edit</Link></Button>)}
        {actions.publish.available && (
          <Button type="button" size="sm" disabled={busy} onClick={(event) => { if (!repeated(event)) void writes.publish() }}>
            {writes.pending === "publish" ? <LoaderCircle className="animate-spin" /> : <Send />}Publish
          </Button>
        )}
        {actions.remove.available && !confirming && (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={(event) => { if (repeated(event)) return; writes.clearFailure(); setConfirming(true) }}><Trash2 />Remove</Button>
        )}
      </div>
      {!actions.publish.available && <p role="status" aria-label="Publishing unavailable" className="text-sm text-muted-foreground">{actions.publish.reason.message}</p>}
      {confirming && <RemoveConfirmation title={draft.title} pending={writes.pending} blocked={busy} onRemove={() => void writes.remove()} onCancel={() => setConfirming(false)} />}
    </div>
  )
}

function RemoveConfirmation({ title, pending, blocked, onRemove, onCancel }: { title: string; pending: Pending | null; blocked: boolean; onRemove(): void; onCancel(): void }) {
  return (
    <section role="alertdialog" aria-label="Remove this draft?" aria-describedby="draft-remove-text" className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
      <p id="draft-remove-text" className="text-sm">Remove “{title}”? Its fork goes with it, along with anything pushed to it.</p>
      <div className="mt-3 flex gap-2">
        <Button type="button" variant="destructive" size="sm" disabled={blocked} onClick={(event) => { if (!repeated(event)) onRemove() }}>
          {pending === "remove" ? <LoaderCircle className="animate-spin" /> : <Trash2 />}Remove draft
        </Button>
        <Button type="button" variant="outline" size="sm" autoFocus disabled={pending !== null} onClick={onCancel}>Cancel</Button>
      </div>
    </section>
  )
}
