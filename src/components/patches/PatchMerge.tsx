import { useEffect, useRef, useState, type MouseEvent, type RefObject } from "react"
import { GitMerge, LoaderCircle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FailureMessage, FormMessage, failureOf, type Failure } from "@/components/form"
import { useNavigate } from "react-router"
import { ApiError } from "@/lib/api"
import { getPatch, patchStatuses, type PatchDetail } from "@/lib/patches"
import { mergeChoices, mergePatch, reviewedOf, type MergeChoice, type MergeMethod, type Reviewed } from "@/lib/patchMerge"
import { readStart, type ThreadReads } from "@/components/assignees/useThreadAnswers"
import type { RepoLocator } from "@/lib/repo"
import { useGateReport, type WriteGate } from "@/components/thread/writeGate"
import { threadsRoute, type WriteViewer } from "@/lib/threads"
import { useStillHere } from "@/lib/stillHere"

const methodLabels: Record<MergeMethod, string> = { source: "Merge", squash: "Squash and merge" }

/** How a refused field reads when the merge controls list it. */
const refusedLabels = { revision: "Revision", target_commit: "Target branch", method: "Method" }

type Props = {
  repo: RepoLocator
  patch: PatchDetail
  viewer: WriteViewer
  /** The patch as Haxy answered a merge. */
  onChanged(patch: PatchDetail): void
  /** Where a read that settles a failed merge goes, ordered by when it started. */
  reads: ThreadReads<PatchDetail>
  /** Holds merging while another of the page's writes (a status change) is in flight. */
  gate: WriteGate
}

/**
 * Merging the patch, with its source commits or squashed into one commit,
 * as Haxy offers it (`actions.merge`, and each way's `mergeability`), each
 * after a confirmation. The merge sends what the page shows (the revision and
 * the target's tip); a refusal is said with the patch read again, and a lost
 * answer is settled by reading the patch again before anything is offered;
 * a merge is never retried by itself.
 */
export function PatchMerge(props: Props) {
  const { patch } = props
  const merge = useMerge(props)
  useGateReport(props.gate, merge.pending || merge.unsettled)
  // a merged patch keeps only what its merge here said
  if (patch.status === "merged" && !merge.merged && !merge.notice && !merge.failure) return null
  return (
    <section aria-labelledby="patch-merge" className="mt-6">
      <h3 id="patch-merge" className="mb-2 text-sm font-semibold">Merge</h3>
      <div className="space-y-3">
        {merge.merged && <FormMessage kind="success">{merge.merged}</FormMessage>}
        {merge.failure && <FailureMessage failure={merge.failure} shown={[]} labels={refusedLabels} />}
        {merge.notice && <FormMessage kind="error">{merge.notice}</FormMessage>}
        {merge.unsettled && (
          <Button type="button" variant="outline" size="sm" disabled={merge.pending} onClick={() => void merge.settle()}><RefreshCw />Check the patch again</Button>
        )}
        {patch.status !== "merged" && <MergeControls patch={patch} merge={merge} />}
      </div>
    </section>
  )
}

function MergeControls({ patch, merge }: { patch: PatchDetail; merge: Merge }) {
  if (!patch.actions.merge.available) {
    return <p role="status" aria-label="Merge unavailable" className="text-sm text-muted-foreground">{patch.actions.merge.reason.message}</p>
  }
  // a click that continues a double (or triple) click; keyboard activation is 0
  const repeated = (event: MouseEvent) => event.detail > 1
  return (
    <>
      <div role="group" aria-label="Merge actions" className="flex flex-wrap items-start gap-3">
        {mergeChoices(patch).map((choice) => (
          <MergeButton key={choice.method} choice={choice} disabled={merge.pending || merge.unsettled || merge.blocked || !choice.enabled}
            onClick={(event) => { if (!repeated(event)) merge.confirm(choice.method) }} />
        ))}
      </div>
      {merge.confirming && <MergeConfirmation patch={patch} method={merge.confirming.method} merge={merge} />}
    </>
  )
}

function MergeButton({ choice, disabled, onClick }: { choice: MergeChoice; disabled: boolean; onClick(event: MouseEvent): void }) {
  return (
    <span className="flex flex-col gap-1">
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onClick}><GitMerge />{methodLabels[choice.method]}</Button>
      {choice.note && <span className="text-xs text-muted-foreground">{choice.note}</span>}
    </span>
  )
}

function MergeConfirmation({ patch, method, merge }: { patch: PatchDetail; method: MergeMethod; merge: Merge }) {
  const how = method === "squash" ? "as one squashed commit" : "with its source commits"
  return (
    <section role="alertdialog" aria-label={`${methodLabels[method]} this patch?`} aria-describedby="patch-merge-text" className="rounded-lg border p-4">
      <p id="patch-merge-text" className="text-sm">Merge “{patch.title}” into <span className="font-mono">{patch.target.name}</span> {how}? The target branch moves for everyone.</p>
      <div className="mt-3 flex gap-2">
        <Button type="button" size="sm" disabled={merge.pending || merge.blocked} onClick={(event) => { if (event.detail <= 1) void merge.run() }}>
          {merge.pending ? <LoaderCircle className="animate-spin" /> : <GitMerge />}{methodLabels[method]}
        </Button>
        <Button type="button" variant="outline" size="sm" autoFocus disabled={merge.pending} onClick={merge.cancel}>Cancel</Button>
      </div>
    </section>
  )
}

type Merge = ReturnType<typeof useMerge>

/** The merge controls' state: one merge at a time, its answer, and settling an answer Haxy couldn't give. */
function useMerge({ repo, patch, viewer, onChanged, reads, gate }: Props) {
  // what the confirmation was opened on, which the merge sends whatever the page reads meanwhile
  const [confirming, setConfirming] = useState<{ method: MergeMethod; reviewed: Reviewed } | null>(null)
  const [merged, setMerged] = useState<string | null>(null)
  const mounted = useMounted()
  const { pending, exclusive } = useExclusive(mounted)
  const reading = useReread({ repo, patch, reads }, mounted)
  const clear = () => { reading.clear(); setMerged(null) }

  const run = () => exclusive(async () => {
    if (!confirming || gate.blocked) return
    clear()
    try {
      const answer = await mergePatch(repo, patch.id, viewer, confirming.method, confirming.reviewed)
      if (!mounted.current) return
      setConfirming(null)
      setMerged(`Merged into ${answer.target.name}.`)
      onChanged(answer)
    } catch (error) {
      if (!mounted.current) return
      setConfirming(null)
      await reading.settle(failureOf(error, "Merging the patch failed."))
    }
  })

  return {
    confirming, pending, merged, run, blocked: gate.blocked,
    failure: reading.failure, notice: reading.notice, unsettled: reading.unsettled,
    confirm: (method: MergeMethod) => {
      const reviewed = reviewedOf(patch)
      clear()
      setConfirming(reviewed && { method, reviewed })
    },
    cancel: () => setConfirming(null),
    settle: () => exclusive(async () => { clear(); await reading.settle(null) }),
  }
}

/**
 * Reading the patch again after a merge failed (`failed`), or to check it:
 * a refusal is shown beside the patch as it now is, and an outcome Haxy
 * couldn't confirm is said once the read shows what happened. Until a read
 * succeeds the patch shown is stale, so it stays unsettled (offering nothing
 * but checking again).
 */
function useReread({ repo, patch, reads }: Pick<Props, "repo" | "patch" | "reads">, mounted: RefObject<boolean>) {
  const here = useStillHere()
  const navigate = useNavigate()
  const [failure, setFailure] = useState<Failure | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [unsettled, setUnsettled] = useState(false)

  async function settle(failed: Failure | null) {
    if (failed && !failed.unknown) setFailure(failed)
    // a read, not a change: a change answered while it is in flight stands over it
    const startedAt = readStart(reads.clock)
    try {
      const current = await getPatch(repo, patch.id)
      if (!mounted.current) return
      setUnsettled(false)
      reads.onRead(current, startedAt)
      if (failed?.unknown) setNotice(`Haxy couldn't confirm whether the patch was merged (${failed.cause}). This is the patch as it is now.`)
    } catch (error) {
      if (!mounted.current) return
      // removed meanwhile: settled, as the shared thread pieces settle it
      if (error instanceof ApiError && error.code === "not_found") return void (here.current && navigate(threadsRoute(repo, "patches", patchStatuses, patch.status)))
      setUnsettled(true)
      setFailure(failed ?? readFailure(error))
    }
  }

  return { failure, notice, unsettled, settle, clear: () => { setFailure(null); setNotice(null) } }
}

function readFailure(error: unknown): Failure {
  const failed = failureOf(error, "Reading the patch failed.")
  return { ...failed, message: `Couldn't read the patch again (${failed.cause}). Check it again before merging.` }
}

/** Runs one piece of work at a time; a second start while one runs (a double click) is ignored. */
function useExclusive(mounted: RefObject<boolean>) {
  const [pending, setPending] = useState(false)
  // set synchronously, so a double click can't start a second merge
  const busy = useRef(false)
  async function exclusive(work: () => Promise<void>) {
    if (busy.current) return
    busy.current = true
    setPending(true)
    try {
      await work()
    } finally {
      busy.current = false
      if (mounted.current) setPending(false)
    }
  }
  return { pending, exclusive }
}

function useMounted() {
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  return mounted
}
