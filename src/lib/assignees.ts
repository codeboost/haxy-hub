/**
 * Assigning people to a thread and unassigning them, through haxy's
 * src/api/assignees.zig, which writes through the TUI's own operations
 * (`thread_write.assign`/`unassign`): who may, and how a name or email
 * resolves, are Haxy's rules. Each write is bound to the viewer its page was
 * loaded for, and none is retried automatically.
 */
import { ApiError, requestJson, type EventId } from "@/lib/api"
import type { RepoLocator } from "@/lib/repo"
import { apiBase, type ThreadAssignee, type ThreadDetail, type ThreadKind, type WriteViewer } from "@/lib/threads"

function assigneesPath(repo: RepoLocator, kind: ThreadKind, id: EventId): string {
  return `${apiBase(repo, kind)}/${encodeURIComponent(id)}/assignees`
}

/**
 * Assigns `assignee` (an account name, or an email; local mode takes emails
 * only) and resolves to the thread with them. Someone already assigned is
 * `conflict` keyed by `assignee` (see `alreadyAssigned`).
 */
export function assignThread<Status extends string>(repo: RepoLocator, kind: ThreadKind, id: EventId, viewer: WriteViewer, assignee: string): Promise<ThreadDetail<Status>> {
  return requestJson(assigneesPath(repo, kind, id), {
    method: "POST",
    viewer,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assignee }),
  })
}

/** Unassigns the assignee whose assignment `assignment` names; `not_found` when they aren't assigned (any more). */
export function unassignThread<Status extends string>(repo: RepoLocator, kind: ThreadKind, id: EventId, viewer: WriteViewer, assignment: EventId): Promise<ThreadDetail<Status>> {
  return requestJson(`${assigneesPath(repo, kind, id)}/${encodeURIComponent(assignment)}`, { method: "DELETE", viewer })
}

/** Whether Haxy refused an assignment because the person is assigned already. */
export function alreadyAssigned(error: unknown): boolean {
  return error instanceof ApiError && error.code === "conflict" && "assignee" in error.fieldErrors
}

/** How an assignee is shown: their account's name, else their email. */
export function assigneeName(assignee: ThreadAssignee): string {
  return assignee.name ?? assignee.email ?? ""
}

/**
 * The assignee `typed` names, judging by what is shown: an account's name or
 * an email as typed. Null when none matches, which doesn't mean the person
 * isn't assigned: an email that belongs to an account shows as its name.
 */
export function assigneeNamed(assignees: ThreadAssignee[], typed: string): ThreadAssignee | null {
  const text = typed.trim()
  return assignees.find((assignee) => assignee.name === text || assignee.email === text) ?? null
}
