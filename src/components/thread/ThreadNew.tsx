import { useRef, useState, type ReactNode } from "react"
import { Link, useLocation, useNavigate } from "react-router"
import { ArrowLeft, Plus, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormMessage, failureOf, type Failure } from "@/components/form"
import { FailureState } from "@/components/listing"
import { useSession } from "@/app/session"
import { ApiError } from "@/lib/api"
import type { RepoLocator } from "@/lib/repo"
import { useResource } from "@/lib/resource"
import { loginPath } from "@/lib/session"
import { createThread, findThread, listThreads, newThreadId, threadRoute, threadsRoute, type ThreadFields, type WriteViewer } from "@/lib/threads"
import { linkClass, type ThreadConfig } from "./config"
import { SectionUnavailable } from "./ThreadParts"
import { ThreadForm } from "./ThreadForm"
import { useBranchChoices, type BranchOffer } from "./BranchFields"
import { useStillHere } from "@/lib/stillHere"

/**
 * `<repo>/<kind>/new`: opens a thread, for a viewer Haxy says may (the list's
 * `create` action; Haxy checks again when the thread is opened).
 */
export function ThreadNewView<Status extends string>({ repo, config, unavailable }: { repo: RepoLocator; config: ThreadConfig<Status>; unavailable: string | null }) {
  const { viewer, viewerKey } = useSession()
  const location = useLocation()
  const key = repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
  // the first list's page tells what this viewer may do; one item is enough
  const list = useResource(`${config.kind} new ${key} ${viewerKey}`, (signal) => listThreads(repo, config.kind, { status: config.statuses[0], page_size: 1 }, { signal }))
  // a patch's form chooses its branches among the repository's
  const branches = useBranchChoices(repo, config, viewerKey)
  const noun = config.noun.toLowerCase()
  const back = <Link to={threadsRoute(repo, config.kind, config.statuses, config.statuses[0])} className={`inline-flex items-center gap-1 text-sm ${linkClass}`}><ArrowLeft size={14} aria-hidden />{config.plural}</Link>
  switch (list.kind) {
    case "failed":
      if (list.error.code === "not_found" && unavailable) return <SectionUnavailable>{unavailable}</SectionUnavailable>
      return <FailureState title={`Couldn't open a new ${noun}`} error={list.error} onRetry={list.reload} />
    case "loaded": {
      const create = list.data.actions.create
      return (
        <section className="mt-6">
          {back}
          <h2 className="mt-3 text-2xl font-semibold tracking-tight">New {noun}</h2>
          {create.available && config.newAlternative && <config.newAlternative repo={repo} />}
          {create.available ? (
            branches?.kind === "failed" ? <FailureState title="Couldn't load the branches" error={branches.error} onRetry={branches.reload} />
              : <NewThreadForm key={viewerKey} repo={repo} config={config} viewer={viewer?.name ?? null} branches={branches?.kind === "loaded" ? { choices: branches.data, source: true } : undefined} />
          ) : (
            <p className="mt-3 text-muted-foreground">
              {create.reason.code === "unauthenticated"
                ? <><Link to={loginPath(location.pathname + location.search)} className={linkClass}>Log in</Link> to open {/^[aeiou]/.test(noun) ? "an" : "a"} {noun}.</>
                : create.reason.message}
            </p>
          )}
        </section>
      )
    }
  }
}

/**
 * A creation whose outcome is unknown (timeout, lost connection, internal
 * error, unreadable answer), or that Haxy refused because the form's id is
 * taken already. The form sends the id it will open the thread under, so what
 * happened can be read back exactly: a thread with that id exists; or it
 * doesn't and the same submission can be sent again — Haxy refuses a second
 * thread with that id, so a retry can't open two. Haxy's reads say not found
 * alike for a thread never opened and one removed, but once the id is known
 * to be taken (`taken`), a missing thread was opened and then removed: the
 * draft is kept for a fresh thread under a new id, if the user asks.
 */
type Uncertain = { cause: string; taken: boolean; check: "checking" | "created" | "missing" | "removed" | "unchecked" }

function NewThreadForm<Status extends string>({ repo, config, viewer, branches }: { repo: RepoLocator; config: ThreadConfig<Status>; viewer: WriteViewer; branches?: BranchOffer }) {
  const navigate = useNavigate()
  // one id for everything this form submits: every attempt is the same creation
  const [id, setId] = useState(newThreadId)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [uncertain, setUncertain] = useState<Uncertain | null>(null)
  const noun = config.noun.toLowerCase()

  // A request still running when the form goes away finishes without
  // touching the page the user is on now; an answer to a superseded attempt
  // or check changes nothing.
  const mounted = useStillHere()
  const generation = useRef(0)
  const begin = () => ++generation.current
  const isLatest = (started: number) => mounted.current && started === generation.current

  async function check(cause: string, taken: boolean) {
    const started = begin()
    setUncertain({ cause, taken, check: "checking" })
    let found: Uncertain["check"]
    try {
      found = (await findThread(repo, config.kind, id)) !== null ? "created" : taken ? "removed" : "missing"
    } catch {
      found = "unchecked"
    }
    if (isLatest(started)) setUncertain({ cause, taken, check: found })
  }

  // the draft, as a thread of its own under a new id
  function startAfresh() {
    begin()
    setId(newThreadId())
    setUncertain(null)
  }

  async function submit(fields: ThreadFields) {
    // a retry is offered only once a check found the thread missing
    if (pending || (uncertain !== null && uncertain.check !== "missing")) return
    const started = begin()
    setPending(true)
    setFailure(null)
    try {
      await createThread<Status>(repo, config.kind, viewer, id, fields)
      if (isLatest(started)) await navigate(threadRoute(repo, config.kind, id))
    } catch (error) {
      if (!isLatest(started)) return
      setPending(false)
      // the id is this form's own: taken means an earlier attempt opened it,
      // which may have been removed since
      if (error instanceof ApiError && error.code === "conflict" && error.fieldError("id") !== undefined) {
        await check(uncertain?.cause ?? error.message, true)
        return
      }
      const failed = failureOf(error, `Opening the ${noun} failed.`)
      if (failed.unknown) await check(failed.cause, false)
      else {
        setUncertain(null)
        setFailure(failed)
      }
    }
  }

  const notice = uncertain && <UnknownOutcome repo={repo} config={config} id={id} uncertain={uncertain} onCheck={() => void check(uncertain.cause, uncertain.taken)} onAfresh={startAfresh} />
  return (
    <ThreadForm config={config} label={`New ${noun}`} initial={{ title: "", labels: "", description: "", ...(branches ? { source: "", target: branches.choices.defaultTarget ?? "" } : {}) }}
      branches={branches} submitLabel={`Open ${noun}`} icon={<Plus />}
      pending={pending} blocked={uncertain !== null && uncertain.check !== "missing"} failure={failure} notice={notice} onSubmit={(fields) => void submit(fields)} />
  )
}

function UnknownOutcome<Status extends string>({ repo, config, id, uncertain, onCheck, onAfresh }: { repo: RepoLocator; config: ThreadConfig<Status>; id: string; uncertain: Uncertain; onCheck(): void; onAfresh(): void }) {
  const noun = config.noun.toLowerCase()
  const lead = `Haxy couldn't confirm what happened to this request (${uncertain.cause}).`
  const checkAgain = <Button type="button" variant="outline" size="sm" className="mt-2 flex" onClick={onCheck}><RefreshCw />Check again</Button>
  let body: ReactNode
  switch (uncertain.check) {
    case "checking":
      body = <>{lead} Checking whether the {noun} was opened…</>
      break
    case "created":
      body = <>The {noun} was opened. <Link to={threadRoute(repo, config.kind, id)} className="font-medium underline underline-offset-4">Open the {noun}</Link></>
      break
    case "removed":
      body = (
        <>
          The {noun} was opened and then removed (perhaps by someone else), so there is nothing to open. Your draft is kept below.
          <Button type="button" variant="outline" size="sm" className="mt-2 flex" onClick={onAfresh}><Plus />Open it as a new {noun}</Button>
        </>
      )
      break
    case "missing":
      body = <>{lead} Haxy has no {noun} from it, so nothing was opened. Submit again to open it; Haxy won't open it twice.</>
      break
    case "unchecked":
      body = <>{lead} Haxy couldn't say whether the {noun} was opened either, so check before trying again.{checkAgain}</>
      break
  }
  return <FormMessage kind={uncertain.check === "created" ? "success" : "error"}><span>{body}</span></FormMessage>
}
