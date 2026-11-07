import { useRef, useState, type FormEvent, type MouseEvent } from "react"
import { Link, useNavigate } from "react-router"
import { LoaderCircle, UserPlus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FailureMessage, FormMessage, TextField, failureOf, type Failure } from "@/components/form"
import { ApiError } from "@/lib/api"
import { alreadyAssigned, assignThread, assigneeName, assigneeNamed, unassignThread } from "@/lib/assignees"
import type { RepoLocator } from "@/lib/repo"
import { findThread, threadsRoute, type ThreadAssignee, type ThreadDetail, type WriteViewer } from "@/lib/threads"
import { readStart, type ThreadReads } from "@/components/assignees/useThreadAnswers"
import { useWrite } from "@/pages/settings/shared"
import { Unresolved } from "@/pages/settings/Unresolved"
import { linkClass, type ThreadConfig } from "@/components/thread/config"
import { ThreadPanel, type PanelFrame } from "@/components/thread/ThreadPanel"
import { Avatar } from "@/components/Avatar"

const chipClass = "inline-flex items-center rounded-full border text-xs"
const chipLinkClass = "rounded-full px-2 py-0.5 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"

/** The assignees, each with their avatar, linking to what they are assigned. */
function AssigneeList({ assignees, noun, to }: { assignees: ThreadAssignee[]; noun: string; to(search: string): string }) {
  if (assignees.length === 0) return <p className="text-sm text-muted-foreground">Nobody is assigned to this {noun}.</p>
  return (
    <ul aria-label="Assigned" className="space-y-1.5">
      {assignees.map((assignee) => {
        const name = assigneeName(assignee)
        return (
          <li key={assignee.id} className="flex min-w-0 items-center gap-2 text-sm">
            <Avatar name={name} size="sm" /><Link to={to(assignee.search)} className={`truncate ${linkClass}`}>{name}</Link>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * A write whose outcome Haxy couldn't confirm, and that reading the thread
 * couldn't settle either; or a write known to be done (`done` says how)
 * whose thread couldn't be read again, so the assignees shown may be stale.
 */
type Unknown =
  | { action: "assign"; typed: string; cause: string }
  | { action: "unassign"; assignee: ThreadAssignee; cause: string }
  | { action: "refresh"; done: string }

function unresolvedMessage(unknown: Unknown): string {
  if (unknown.action === "refresh") return `${unknown.done} Haxy couldn't be reached to show the assignees as they are now; check again before changing them.`
  return `Haxy couldn't confirm what happened to this request (${unknown.cause}), and couldn't be reached to check. Check again before changing the assignees.`
}

/**
 * A thread's assignees, each by account name or else by email, linking to
 * the list of what they are assigned (Haxy's `assignee:` filter); and, when
 * Haxy says the viewer may assign people (`actions.assign`), a way to assign
 * someone by account name or email (email only in local mode) and to
 * unassign each. Haxy checks again when a write runs.
 *
 * An outcome Haxy couldn't confirm is settled by reading the thread again
 * before anything else is offered. Assigning someone already assigned, or
 * unassigning someone no longer assigned, right after such an outcome means
 * the earlier attempt landed, so it settles as done rather than as an error.
 * Whenever the read that would show the assignees as they are fails, the
 * controls hold until "Check again" gets an answer. Answers update only the
 * assignees (see `useThreadAnswers`).
 */
export function ThreadAssignees<Status extends string>({ repo, config, thread, viewer, onChanged, reads, frame = "section" }: {
  repo: RepoLocator
  config: ThreadConfig<Status>
  thread: ThreadDetail<Status>
  viewer: WriteViewer
  /** The thread as Haxy answered a change. */
  onChanged(thread: ThreadDetail<Status>): void
  /** Where a read that settles an outcome goes, ordered by when it started. */
  reads: ThreadReads<ThreadDetail<Status>>
  /** In the sidebar, the assignees show as a list, with the controls behind a toggle. */
  frame?: PanelFrame
}) {
  const navigate = useNavigate()
  const write = useWrite<Unknown>()
  const [typed, setTyped] = useState("")
  const [failure, setFailure] = useState<Failure | null>(null)
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null)
  // what an attempt whose outcome was unknown tried, so its retry can settle it
  const uncertain = useRef<{ action: "assign"; typed: string } | { action: "unassign"; id: string } | null>(null)

  const canAssign = thread.actions.assign.available
  if (!canAssign && thread.assignees.length === 0) return null
  const local = repo.kind === "local"
  const noun = config.noun.toLowerCase()
  const listRoute = threadsRoute(repo, config.kind, config.statuses, thread.status)
  // an assignee's link leads to the list of this thread's status, filtered by them
  const listOf = (search: string) => threadsRoute(repo, config.kind, config.statuses, thread.status, { search })
  // a click that continues a double (or triple) click; keyboard activation is 0
  const repeated = (event: MouseEvent) => event.detail > 1

  /** Reads the thread again and shows it: "gone" when it no longer exists, null when Haxy couldn't say. */
  async function reread(current: () => boolean): Promise<ThreadDetail<Status> | "gone" | null> {
    const startedAt = readStart(reads.clock)
    try {
      const now = await findThread<Status>(repo, config.kind, thread.id)
      if (!current()) return null
      if (now === null) {
        void navigate(listRoute)
        return "gone"
      }
      reads.onRead(now, startedAt)
      return now
    } catch {
      return null
    }
  }

  /** What a read after an unknown outcome says; false when Haxy couldn't say. */
  async function settle(unknown: Unknown, current: () => boolean): Promise<boolean> {
    const now = await reread(current)
    if (now === null) return false
    if (now === "gone" || !current()) return true
    if (unknown.action === "refresh") {
      setNotice({ kind: "success", text: unknown.done })
    } else if (unknown.action === "assign") {
      const found = assigneeNamed(now.assignees, unknown.typed)
      if (found) {
        uncertain.current = null
        setTyped("")
        setNotice({ kind: "success", text: `${assigneeName(found)} is assigned.` })
      } else {
        uncertain.current = { action: "assign", typed: unknown.typed }
        setNotice({ kind: "error", text: `Haxy couldn't confirm whether ${unknown.typed} was assigned (${unknown.cause}). The assignees shown are as Haxy has them now; assigning again is safe.` })
      }
    } else if (now.assignees.some((assignee) => assignee.id === unknown.assignee.id)) {
      uncertain.current = { action: "unassign", id: unknown.assignee.id }
      setNotice({ kind: "error", text: `Haxy couldn't confirm what happened to this request (${unknown.cause}). ${assigneeName(unknown.assignee)} is still assigned; unassign them again to try once more.` })
    } else {
      uncertain.current = null
      setNotice({ kind: "success", text: `${assigneeName(unknown.assignee)} is no longer assigned.` })
    }
    return true
  }

  /** Runs a write; an unknown outcome is settled by reading the thread, or left unresolved. */
  async function run(attempt: Exclude<Unknown, { action: "refresh" }>, send: () => Promise<ThreadDetail<Status>>, settled: (error: unknown) => boolean, current: () => boolean) {
    setFailure(null)
    setNotice(null)
    try {
      const updated = await send()
      if (!current()) return
      uncertain.current = null
      onChanged(updated)
      if (attempt.action === "assign") setTyped("")
    } catch (error) {
      if (!current()) return
      if (settled(error)) {
        // the attempt before this one landed after all: say so, and show
        // the thread as it is; until it can be read, hold the controls
        uncertain.current = null
        if (attempt.action === "assign") setTyped("")
        const refresh: Unknown = { action: "refresh", done: attempt.action === "assign" ? `${attempt.typed} is assigned.` : `${assigneeName(attempt.assignee)} is no longer assigned.` }
        if (!(await settle(refresh, current)) && current()) write.setUnresolved(refresh)
        return
      }
      const failed = failureOf(error, attempt.action === "assign" ? "Assigning failed." : "Unassigning failed.")
      if (!failed.unknown) return setFailure(failed)
      const unknown = { ...attempt, cause: failed.cause }
      if (!(await settle(unknown, current)) && current()) write.setUnresolved(unknown)
    }
  }

  function assign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = typed.trim()
    void write.start((current) => run(
      { action: "assign", typed: text, cause: "" },
      () => assignThread<Status>(repo, config.kind, thread.id, viewer, text),
      (error) => alreadyAssigned(error) && uncertain.current?.action === "assign" && uncertain.current.typed === text,
      current,
    ))
  }

  function unassign(assignee: ThreadAssignee) {
    void write.start((current) => run(
      { action: "unassign", assignee, cause: "" },
      () => unassignThread<Status>(repo, config.kind, thread.id, viewer, assignee.id),
      // not assigned (any more): what was asked, which the read shows
      (error) => error instanceof ApiError && error.code === "not_found",
      current,
    ))
  }

  const check = () => write.check(async (unknown, current) => {
    if (await settle(unknown, current)) write.setUnresolved(null)
  })

  return (
    <ThreadPanel id="thread-assignees" title="Assignees" frame={frame} edit={canAssign ? "Edit assignees" : undefined}
      compact={<AssigneeList assignees={thread.assignees} noun={noun} to={listOf} />}>
      {thread.assignees.length === 0
        ? <p className="text-sm text-muted-foreground">Nobody is assigned to this {noun}.</p>
        : (
          <ul aria-label="Assigned" className="flex flex-wrap gap-1">
            {thread.assignees.map((assignee) => {
              const name = assigneeName(assignee)
              return (
                <li key={assignee.id} className={chipClass}>
                  <Link to={listOf(assignee.search)} className={chipLinkClass}>{name}</Link>
                  {canAssign && (
                    <button type="button" aria-label={`Unassign ${name}`} title={`Unassign ${name}`} disabled={write.blocked}
                      className="mr-1 rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
                      onClick={(event) => { if (!repeated(event)) unassign(assignee) }}>
                      <X size={12} aria-hidden />
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      {canAssign && (
        <form aria-label="Assign someone" className="mt-3 max-w-md space-y-3" onSubmit={assign} noValidate>
          {failure && <FailureMessage failure={failure} />}
          {notice && <FormMessage kind={notice.kind}>{notice.text}</FormMessage>}
          {write.unresolved && (
            <Unresolved pending={write.busy} onCheck={() => void check()} message={unresolvedMessage(write.unresolved)} />
          )}
          <fieldset disabled={write.blocked} className="disabled:opacity-60">
            <TextField label="Assign" name="assignee" value={typed} onValue={setTyped} error={failure?.fields.assignee}
              placeholder={local ? "email" : "username or email"} autoComplete="off" autoCapitalize="none" spellCheck={false}
              hint={local ? "An email address: local mode has no accounts." : "An account name, or an email address for someone without an account."} />
          </fieldset>
          {/* the later clicks of a double click are ignored, even once the first one's answer has cleared the form */}
          <Button type="submit" variant="outline" size="sm" disabled={write.blocked} onClick={(event) => { if (repeated(event)) event.preventDefault() }}>
            {write.busy ? <LoaderCircle className="animate-spin" /> : <UserPlus />}Assign
          </Button>
        </form>
      )}
    </ThreadPanel>
  )
}
