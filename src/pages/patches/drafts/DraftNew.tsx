import { useState, type ReactNode } from "react"
import { Link, useLocation, useNavigate } from "react-router"
import { ArrowLeft, GitFork, Plus, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormMessage, failureOf, type Failure } from "@/components/form"
import { FailureState, LoadingState } from "@/components/listing"
import { useBranchChoices } from "@/components/thread/BranchFields"
import { linkClass } from "@/components/thread/config"
import { SectionUnavailable } from "@/components/thread/ThreadParts"
import { ThreadForm } from "@/components/thread/ThreadForm"
import { useSession } from "@/app/session"
import { ApiError } from "@/lib/api"
import { draftFieldsOf, draftRoute, draftState, draftsRoute, listDrafts, startDraft } from "@/lib/drafts"
import type { BranchChoices } from "@/lib/patches"
import type { RepoLocator } from "@/lib/repo"
import { useResource } from "@/lib/resource"
import { loginPath } from "@/lib/session"
import { newThreadId, newThreadRoute, threadRoute, type ThreadFields, type WriteViewer } from "@/lib/threads"
import { useLatest } from "@/pages/settings/shared"
import { patchThreads } from "../config"

/**
 * `<repo>/patches/drafts/new`: starts a patch with a new fork of the
 * repository, for a viewer Haxy says may (the drafts list's `create` action;
 * Haxy checks again when the fork is made). Copying the repository can take a
 * while, so the request has no proxy timeout.
 */
export function DraftNewView({ repo, unavailable }: { repo: RepoLocator; unavailable: string | null }) {
  const { viewer, viewerKey } = useSession()
  const location = useLocation()
  const key = repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
  const drafts = useResource(`drafts new ${key} ${viewerKey}`, (signal) => listDrafts(repo, { page_size: 1 }, { signal }))
  const branches = useBranchChoices(repo, patchThreads, viewerKey)
  const header = (
    <>
      <Link to={newThreadRoute(repo, "patches")} className={`inline-flex items-center gap-1 text-sm ${linkClass}`}><ArrowLeft size={14} aria-hidden />New patch from a branch</Link>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight">New patch with a new fork</h2>
      <p className="mt-2 text-sm text-muted-foreground">Haxy copies the repository into a fork of your own, where you push your commits. The patch stays your draft until you publish it.</p>
    </>
  )
  if (drafts.kind === "loading") return <LoadingState>Loading…</LoadingState>
  if (drafts.kind === "failed") {
    if (drafts.error.code === "not_found" && unavailable) return <SectionUnavailable>{unavailable}</SectionUnavailable>
    if (drafts.error.code === "unauthenticated") return <section className="mt-6">{header}<p className="mt-3 text-muted-foreground"><Link to={loginPath(location.pathname + location.search)} className={linkClass}>Log in</Link> to start a patch.</p></section>
    return <FailureState title="Couldn't open a new draft" error={drafts.error} onRetry={drafts.reload} />
  }
  const { create } = drafts.data.actions
  let body: ReactNode
  if (!create.available) body = <p className="mt-3 text-muted-foreground">{create.reason.message}</p>
  else if (branches?.kind === "loading") body = <LoadingState>Loading the branches…</LoadingState>
  else if (branches?.kind === "failed") body = <FailureState title="Couldn't load the branches" error={branches.error} onRetry={branches.reload} />
  else if (branches?.kind === "loaded") body = <StartForm key={viewerKey} repo={repo} viewer={viewer?.name ?? null} branches={branches.data} />
  return <section className="mt-6">{header}{body}</section>
}

/**
 * A start whose outcome is unknown, or that Haxy refused because the form's
 * id is taken: the patch and then the draft are looked up by that id. A
 * patch under it means the draft was started and published since (from
 * another tab); a draft, that it was started;
 * missing after an unknown outcome, the same submission can be sent again
 * (Haxy refuses a second draft under the id); missing once the id is known
 * taken, it was started and removed since.
 */
type Uncertain = { cause: string; taken: boolean; check: "checking" | "created" | "published" | "missing" | "removed" | "unchecked" }

// where a start whose outcome is unknown left the draft; `taken` says Haxy refused its id as taken
async function lookUp(repo: RepoLocator, id: string, taken: boolean): Promise<Uncertain["check"]> {
  try {
    const state = await draftState(repo, id)
    if (state === "gone") return taken ? "removed" : "missing"
    return state === "published" ? "published" : "created"
  } catch {
    return "unchecked"
  }
}

function StartForm({ repo, viewer, branches }: { repo: RepoLocator; viewer: WriteViewer; branches: BranchChoices }) {
  const navigate = useNavigate()
  const latest = useLatest()
  const [id, setId] = useState(newThreadId)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [uncertain, setUncertain] = useState<Uncertain | null>(null)

  async function check(cause: string, taken: boolean) {
    const started = latest.begin()
    setUncertain({ cause, taken, check: "checking" })
    const found = await lookUp(repo, id, taken)
    if (latest.isLatest(started)) setUncertain({ cause, taken, check: found })
  }

  async function submit(fields: ThreadFields) {
    if (pending || (uncertain !== null && uncertain.check !== "missing")) return
    const started = latest.begin()
    setPending(true)
    setFailure(null)
    try {
      await startDraft(repo, viewer, id, draftFieldsOf(fields))
      if (latest.isLatest(started)) await navigate(draftRoute(repo, id))
    } catch (error) {
      if (!latest.isLatest(started)) return
      setPending(false)
      if (error instanceof ApiError && error.code === "conflict" && error.fieldError("id") !== undefined) return void await check(uncertain?.cause ?? error.message, true)
      const failed = failureOf(error, "Starting the draft failed.")
      if (failed.unknown) await check(failed.cause, false)
      else {
        setUncertain(null)
        setFailure(failed)
      }
    }
  }

  const afresh = () => {
    latest.begin()
    setId(newThreadId())
    setUncertain(null)
  }
  const notice = uncertain && <UnknownOutcome repo={repo} id={id} uncertain={uncertain} onCheck={() => void check(uncertain.cause, uncertain.taken)} onAfresh={afresh} />
  return (
    <ThreadForm config={patchThreads} label="New draft" initial={{ title: "", labels: "", description: "", target: branches.defaultTarget ?? "" }}
      branches={{ choices: branches, source: false }} submitLabel="Start with a new fork" icon={<GitFork />}
      pending={pending} blocked={uncertain !== null && uncertain.check !== "missing"} failure={failure} notice={notice} onSubmit={(fields) => void submit(fields)} />
  )
}

function UnknownOutcome({ repo, id, uncertain, onCheck, onAfresh }: { repo: RepoLocator; id: string; uncertain: Uncertain; onCheck(): void; onAfresh(): void }) {
  const lead = `Haxy couldn't confirm what happened to this request (${uncertain.cause}).`
  const outcomes: Record<Uncertain["check"], ReactNode> = {
    checking: <>{lead} Checking whether the draft was started…</>,
    created: <>The draft was started. <Link to={draftRoute(repo, id)} className="font-medium underline underline-offset-4">Open the draft</Link></>,
    published: <>The draft was started and has been published since. <Link to={threadRoute(repo, "patches", id)} className="font-medium underline underline-offset-4">Open the patch</Link></>,
    removed: (
      <>
        The draft was started and then removed, so there is nothing to open. <Link to={draftsRoute(repo)} className="underline underline-offset-4">Your drafts</Link>
        <Button type="button" variant="outline" size="sm" className="mt-2 flex" onClick={onAfresh}><Plus />Start it as a new draft</Button>
      </>
    ),
    missing: <>{lead} Haxy has no draft from it, so nothing was started. Submit again to start it; Haxy won't start it twice.</>,
    unchecked: <>{lead} Haxy couldn't say whether the draft was started either, so check before trying again.<Button type="button" variant="outline" size="sm" className="mt-2 flex" onClick={onCheck}><RefreshCw />Check again</Button></>,
  }
  return <FormMessage kind={uncertain.check === "created" || uncertain.check === "published" ? "success" : "error"}><span>{outcomes[uncertain.check]}</span></FormMessage>
}
