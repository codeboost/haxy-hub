import { useEffect, useRef, useState, type ReactNode } from "react"
import { Link, useNavigate } from "react-router"
import { ArrowLeft, RefreshCw, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormMessage, failureOf, type Failure } from "@/components/form"
import { FailureState, LoadingState } from "@/components/listing"
import { useSession } from "@/app/session"
import { ApiError } from "@/lib/api"
import type { RepoLocator } from "@/lib/repo"
import { useResource } from "@/lib/resource"
import { editThread, findThread, getThread, holdsFields, threadRoute, type ThreadDetail, type ThreadFields, type WriteViewer } from "@/lib/threads"
import { linkClass, type ThreadConfig } from "./config"
import { SectionUnavailable } from "./ThreadParts"
import { ThreadForm } from "./ThreadForm"
import { useBranchChoices, type BranchOffer } from "./BranchFields"

/** `<repo>/<kind>/<id>/edit`: replaces a thread's title, labels and description. */
export function ThreadEditView<Status extends string>({ repo, config, id, unavailable }: { repo: RepoLocator; config: ThreadConfig<Status>; id: string; unavailable: string | null }) {
  const { viewer, viewerKey } = useSession()
  const key = repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
  const thread = useResource(`${config.kind} edit ${key} ${id} ${viewerKey}`, (signal) => getThread<Status>(repo, config.kind, id, { signal }))
  // a patch's form chooses its target among the repository's branches
  const branches = useBranchChoices(repo, config, viewerKey)
  const noun = config.noun.toLowerCase()
  const back = <Link to={threadRoute(repo, config.kind, id)} className={`inline-flex items-center gap-1 text-sm ${linkClass}`}><ArrowLeft size={14} aria-hidden />Back to the {noun}</Link>
  switch (thread.kind) {
    case "loading":
      return <LoadingState>Loading the {noun}…</LoadingState>
    case "failed":
      if (thread.error.code === "not_found" && unavailable) return <SectionUnavailable>{unavailable}</SectionUnavailable>
      if (thread.error.code === "not_found") return <section className="mt-6"><h2 className="text-2xl font-semibold tracking-tight">{config.noun} not found</h2><p className="mt-2 text-muted-foreground">There is no {noun} with this id in this repository. It may have been removed.</p></section>
      return <FailureState title={`Couldn't load this ${noun}`} error={thread.error} onRetry={thread.reload} />
    case "loaded": {
      const edit = thread.data.actions.edit
      return (
        <section className="mt-6">
          {back}
          <h2 className="mt-3 text-2xl font-semibold tracking-tight">Edit {noun}</h2>
          {!edit.available ? <p className="mt-3 text-muted-foreground">{edit.reason.message}</p>
            : branches?.kind === "loading" ? <LoadingState>Loading the branches…</LoadingState>
            : branches?.kind === "failed" ? <FailureState title="Couldn't load the branches" error={branches.error} onRetry={branches.reload} />
            : <EditThreadForm key={viewerKey} repo={repo} config={config} loaded={thread.data} viewer={viewer?.name ?? null}
                branches={branches?.kind === "loaded" ? { choices: branches.data, source: false } : undefined} />}
        </section>
      )
    }
  }
}

/**
 * What stands in the way of saving: an outcome Haxy couldn't confirm, being
 * settled by reading the thread again, or someone else's change since the
 * form loaded (`conflict` on the revision), which the user must look at
 * before replacing it.
 */
type Notice =
  | { kind: "checking"; cause: string }
  | { kind: "unchecked"; cause: string }
  | { kind: "unsaved"; cause: string }
  | { kind: "stale" }
  | { kind: "reviewing"; current: ThreadDetail<string> }

function EditThreadForm<Status extends string>({ repo, config, loaded, viewer, branches }: { repo: RepoLocator; config: ThreadConfig<Status>; loaded: ThreadDetail<Status>; viewer: WriteViewer; branches?: BranchOffer }) {
  const navigate = useNavigate()
  // the revision the next save replaces; it moves only when the user has seen what it holds
  const [revision, setRevision] = useState(loaded.revision)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const noun = config.noun.toLowerCase()

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const generation = useRef(0)
  const begin = () => ++generation.current
  const isLatest = (started: number) => mounted.current && started === generation.current

  // An unknown outcome: the thread now holding exactly what was sent means
  // the save landed; still at the revision it was made against means it
  // didn't; anything else is someone else's change, to review first.
  async function settle(cause: string, sent: ThreadFields) {
    const started = begin()
    setNotice({ kind: "checking", cause })
    let current: ThreadDetail<Status> | null
    try {
      current = await findThread<Status>(repo, config.kind, loaded.id)
    } catch {
      if (isLatest(started)) setNotice({ kind: "unchecked", cause })
      return
    }
    if (!isLatest(started)) return
    if (current === null) setFailure({ message: `This ${noun} has been removed.`, cause, fields: {}, unknown: false, viewerChanged: false })
    else if (holdsFields(current, sent)) await navigate(threadRoute(repo, config.kind, loaded.id))
    else if (current.revision === revision) setNotice({ kind: "unsaved", cause })
    else setNotice({ kind: "stale" })
  }

  async function review() {
    const started = begin()
    try {
      const current = await getThread<Status>(repo, config.kind, loaded.id)
      if (!isLatest(started)) return
      setRevision(current.revision)
      setNotice({ kind: "reviewing", current })
    } catch (error) {
      if (isLatest(started)) setFailure(failureOf(error, `Loading the ${noun} failed.`))
    }
  }

  async function submit(fields: ThreadFields) {
    if (pending || notice?.kind === "checking" || notice?.kind === "unchecked" || notice?.kind === "stale") return
    const started = begin()
    setPending(true)
    setFailure(null)
    setNotice(null)
    try {
      await editThread<Status>(repo, config.kind, loaded.id, viewer, revision, fields)
      if (isLatest(started)) await navigate(threadRoute(repo, config.kind, loaded.id))
    } catch (error) {
      if (!isLatest(started)) return
      setPending(false)
      if (error instanceof ApiError && error.code === "conflict" && error.fieldError("revision") !== undefined) {
        setNotice({ kind: "stale" })
        return
      }
      const failed = failureOf(error, `Saving the ${noun} failed.`)
      if (failed.unknown) await settle(failed.cause, fields)
      else setFailure(failed)
    }
  }

  let message: ReactNode = null
  if (notice) {
    switch (notice.kind) {
      case "checking":
        message = <FormMessage kind="error">Haxy couldn't confirm what happened to this request ({notice.cause}). Checking the {noun}…</FormMessage>
        break
      case "unchecked":
        message = (
          <FormMessage kind="error">
            <p>Haxy couldn't confirm what happened to this request ({notice.cause}), nor say whether the {noun} changed.</p>
            <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void review()}><RefreshCw />Check the {noun}</Button>
          </FormMessage>
        )
        break
      case "unsaved":
        message = <FormMessage kind="error">Haxy couldn't confirm what happened to this request ({notice.cause}). The {noun} is unchanged, so nothing was saved; save again to try once more.</FormMessage>
        break
      case "stale":
        message = (
          <FormMessage kind="error">
            <p>Someone changed this {noun} since you opened the form, so your changes weren't saved. They're kept below.</p>
            <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void review()}><RefreshCw />Show the current version</Button>
          </FormMessage>
        )
        break
      case "reviewing":
        message = <CurrentVersion thread={notice.current} noun={noun} />
        break
    }
  }
  const initial = { title: loaded.title, labels: loaded.labels.map((label) => label.name).join(" "), description: loaded.description_text, ...(branches && loaded.target ? { target: loaded.target.id } : {}) }
  return (
    <ThreadForm config={config} label={`Edit ${noun}`} initial={initial} branches={branches} submitLabel="Save changes" icon={<Save />} pending={pending}
      blocked={notice !== null && notice.kind !== "unsaved" && notice.kind !== "reviewing"} failure={failure} notice={message} onSubmit={(fields) => void submit(fields)} />
  )
}

/** The thread as it is now, beside the form that would replace it. */
function CurrentVersion({ thread, noun }: { thread: ThreadDetail<string>; noun: string }) {
  return (
    <section aria-label="Current version" className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
      <p>This is the {noun} as it is now. Saving replaces it with the form's fields.</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="font-medium">Title</dt><dd>{thread.title}</dd>
        <dt className="font-medium">Labels</dt><dd>{thread.labels.map((label) => label.name).join(" ") || "None"}</dd>
        {thread.target && <><dt className="font-medium">Target branch</dt><dd className="font-mono">{thread.target.name}</dd></>}
        <dt className="font-medium">Description</dt><dd><pre className="whitespace-pre-wrap font-mono text-xs">{thread.description_text || "None"}</pre></dd>
      </dl>
    </section>
  )
}
