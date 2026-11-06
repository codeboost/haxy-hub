import { useState, type ReactNode } from "react"
import { Link, useNavigate } from "react-router"
import { ArrowLeft, RefreshCw, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormMessage, failureOf, type Failure } from "@/components/form"
import { FailureState, LoadingState } from "@/components/listing"
import { useBranchChoices } from "@/components/thread/BranchFields"
import { linkClass } from "@/components/thread/config"
import { SectionUnavailable } from "@/components/thread/ThreadParts"
import { ThreadForm } from "@/components/thread/ThreadForm"
import { useSession } from "@/app/session"
import { ApiError } from "@/lib/api"
import { draftFieldsOf, draftHolds, draftRoute, editDraft, findDraft, getDraft, type DraftDetail, type DraftFields } from "@/lib/drafts"
import type { BranchChoices } from "@/lib/patches"
import type { RepoLocator } from "@/lib/repo"
import { useResource } from "@/lib/resource"
import type { ThreadFields, WriteViewer } from "@/lib/threads"
import { useLatest } from "@/pages/settings/shared"
import { patchThreads } from "../config"

/** `<repo>/patches/drafts/<id>/edit`: replaces a draft's title, labels, description and target. */
export function DraftEditView({ repo, id, unavailable }: { repo: RepoLocator; id: string; unavailable: string | null }) {
  const { viewer, viewerKey } = useSession()
  const key = repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
  const draft = useResource(`draft edit ${key} ${id} ${viewerKey}`, (signal) => getDraft(repo, id, { signal }))
  const branches = useBranchChoices(repo, patchThreads, viewerKey)
  if (draft.kind === "loading") return <LoadingState>Loading the draft…</LoadingState>
  if (draft.kind === "failed") {
    if (draft.error.code === "not_found" && unavailable) return <SectionUnavailable>{unavailable}</SectionUnavailable>
    if (draft.error.code === "not_found") return <section className="mt-6"><h2 className="text-2xl font-semibold tracking-tight">Draft not found</h2><p className="mt-2 text-muted-foreground">You have no draft with this id in this repository. It may have been published or removed.</p></section>
    return <FailureState title="Couldn't load this draft" error={draft.error} onRetry={draft.reload} />
  }
  const { edit } = draft.data.actions
  let body: ReactNode
  if (!edit.available) body = <p className="mt-3 text-muted-foreground">{edit.reason.message}</p>
  else if (branches?.kind === "loading") body = <LoadingState>Loading the branches…</LoadingState>
  else if (branches?.kind === "failed") body = <FailureState title="Couldn't load the branches" error={branches.error} onRetry={branches.reload} />
  else if (branches?.kind === "loaded") body = <EditForm key={viewerKey} repo={repo} loaded={draft.data} viewer={viewer?.name ?? null} branches={branches.data} />
  return (
    <section className="mt-6">
      <Link to={draftRoute(repo, id)} className={`inline-flex items-center gap-1 text-sm ${linkClass}`}><ArrowLeft size={14} aria-hidden />Back to the draft</Link>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight">Edit draft</h2>
      {body}
    </section>
  )
}

/**
 * What stands in the way of saving: an outcome Haxy couldn't confirm, being
 * settled by reading the draft again, or a change made since the form loaded
 * (another tab of the author's), which they must look at before replacing it:
 * once shown in place (`reviewing`), the next save replaces that version.
 */
type Notice = { kind: "checking" | "unchecked" | "unsaved"; cause: string } | { kind: "stale" } | { kind: "reviewing"; current: DraftDetail }

// what an unknown outcome left, read again (null: gone; undefined: Haxy
// couldn't say): the draft holding exactly what was sent means the save
// landed; still at the revision it was made against means it didn't
function settled(current: DraftDetail | null | undefined, sent: DraftFields, revision: string, cause: string): Notice | "saved" | "gone" {
  if (current === undefined) return { kind: "unchecked", cause }
  if (current === null) return "gone"
  if (draftHolds(current, sent)) return "saved"
  return current.edit_revision === revision ? { kind: "unsaved", cause } : { kind: "stale" }
}

const isStale = (error: unknown) => error instanceof ApiError && error.code === "conflict" && error.fieldError("revision") !== undefined

/** Saving the form as of the revision the user has seen, and settling what Haxy couldn't confirm. */
function useDraftSave(repo: RepoLocator, loaded: DraftDetail, viewer: WriteViewer) {
  const navigate = useNavigate()
  const latest = useLatest()
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  // the revision the next save replaces; it moves only once the user has seen what it holds
  const [revision, setRevision] = useState(loaded.edit_revision)
  const saved = () => navigate(draftRoute(repo, loaded.id))

  async function review() {
    const started = latest.begin()
    const current = await getDraft(repo, loaded.id).catch((error: unknown) => failureOf(error, "Loading the draft failed."))
    if (!latest.isLatest(started)) return
    if ("id" in current) {
      setRevision(current.edit_revision)
      setNotice({ kind: "reviewing", current })
    } else setFailure(current)
  }

  async function settle(cause: string, sent: DraftFields) {
    const started = latest.begin()
    setNotice({ kind: "checking", cause })
    const outcome = settled(await findDraft(repo, loaded.id).catch(() => undefined), sent, revision, cause)
    if (!latest.isLatest(started)) return
    if (outcome === "saved") await saved()
    else if (outcome === "gone") setFailure({ message: "This draft has been published or removed.", cause, fields: {}, unknown: false, viewerChanged: false })
    else setNotice(outcome)
  }

  async function submit(fields: ThreadFields) {
    if (pending || (notice !== null && notice.kind !== "unsaved" && notice.kind !== "reviewing")) return
    const started = latest.begin()
    const sent = draftFieldsOf(fields)
    setPending(true)
    setFailure(null)
    setNotice(null)
    const failed = await editDraft(repo, loaded.id, viewer, revision, sent).then(() => null, (error: unknown) => error)
    if (!latest.isLatest(started)) return
    if (failed === null) return void await saved()
    setPending(false)
    if (isStale(failed)) return setNotice({ kind: "stale" })
    const failure = failureOf(failed, "Saving the draft failed.")
    if (failure.unknown) await settle(failure.cause, sent)
    else setFailure(failure)
  }
  return { pending, failure, notice, review, submit }
}

function EditForm({ repo, loaded, viewer, branches }: { repo: RepoLocator; loaded: DraftDetail; viewer: WriteViewer; branches: BranchChoices }) {
  const { pending, failure, notice, review, submit } = useDraftSave(repo, loaded, viewer)
  const initial = { title: loaded.title, labels: loaded.labels.join(" "), description: loaded.description_text, target: loaded.target.id }
  return (
    <ThreadForm config={patchThreads} label="Edit draft" initial={initial} branches={{ choices: branches, source: false }} submitLabel="Save changes" icon={<Save />} pending={pending}
      blocked={notice !== null && notice.kind !== "unsaved" && notice.kind !== "reviewing"} failure={failure} notice={notice && <NoticeMessage notice={notice} onReview={() => void review()} />} onSubmit={(fields) => void submit(fields)} />
  )
}

function NoticeMessage({ notice, onReview }: { notice: Notice; onReview(): void }) {
  const show = <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onReview}><RefreshCw />Show the current version</Button>
  if (notice.kind === "reviewing") return <CurrentVersion draft={notice.current} />
  if (notice.kind === "stale") return <FormMessage kind="error"><p>This draft changed since you opened the form, so your changes weren't saved. They're kept below.</p>{show}</FormMessage>
  const lead = `Haxy couldn't confirm what happened to this request (${notice.cause}).`
  const text = { checking: `${lead} Checking the draft…`, unchecked: `${lead} Haxy couldn't say whether the draft changed either; look at it before saving again.`, unsaved: `${lead} The draft is unchanged, so nothing was saved; save again to try once more.` }[notice.kind]
  return <FormMessage kind="error"><p>{text}</p>{notice.kind === "unchecked" && show}</FormMessage>
}

/** The draft as it is now, beside the form that would replace it. */
function CurrentVersion({ draft }: { draft: DraftDetail }) {
  return (
    <section aria-label="Current version" className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
      <p>This is the draft as it is now. Saving replaces it with the form's fields.</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="font-medium">Title</dt><dd>{draft.title}</dd>
        <dt className="font-medium">Labels</dt><dd>{draft.labels.join(" ") || "None"}</dd>
        <dt className="font-medium">Target branch</dt><dd className="font-mono">{draft.target.name}</dd>
        <dt className="font-medium">Description</dt><dd><pre className="whitespace-pre-wrap font-mono text-xs">{draft.description_text || "None"}</pre></dd>
      </dl>
    </section>
  )
}
