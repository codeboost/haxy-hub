/**
 * Discussions: a repository's conversations outside issue tracking, read and
 * written through haxy's src/api/discussions.zig (the routes and shapes of
 * the issue routes, see `@/lib/threads`). A discussion has what the TUI shows
 * of it: a title, labels, a description, its author and its comments. It has
 * no status, assignees or field conflicts, and the TUI lists discussions in
 * one list, "recent" (most recently active first).
 *
 * The shared thread pieces read every kind as issues are shaped, so
 * `@/lib/threads` passes discussion answers through `asThreadList` and
 * `asThreadDetail`: the TUI's one list stands in for a status, and the
 * assignees and status changes a discussion doesn't have are never offered.
 */
import type { ActionAvailability, Page } from "@/lib/api"
import type { ThreadDetail, ThreadFilters, ThreadList, ThreadListActions, ThreadPaths, ThreadSummary } from "@/lib/threads"

/** The TUI's one list of discussions, which the shared thread pieces read as a status. */
export type DiscussionList = "recent"
export const discussionLists = ["recent"] as const satisfies readonly DiscussionList[]

export type DiscussionSummary = Omit<ThreadSummary<DiscussionList>, "status" | "assignees" | "conflicted">

export type DiscussionDetail = DiscussionSummary & {
  description: ThreadDetail<DiscussionList>["description"]
  description_text: string
  revision: string
  actions: Record<"edit" | "remove", ActionAvailability>
}

export type DiscussionPage = Page<DiscussionSummary> & { actions: ThreadListActions; filters: ThreadFilters }

const noSuch: ActionAvailability = { available: false, reason: { code: "unsupported", message: "Discussions have no status or assignees." } }

// wired once the discussion routes serve attachments
const noAttachments: ActionAvailability = { available: false, reason: { code: "unsupported", message: "Discussions don't take attachments here yet." } }

function asThread(discussion: DiscussionSummary): ThreadSummary<DiscussionList> {
  return { ...discussion, status: "recent", assignees: [], conflicted: false }
}

/** A page of discussions as the shared thread list reads one. */
export function asThreadList(page: DiscussionPage): ThreadList<DiscussionList> {
  return { ...page, items: page.items.map(asThread), status: "recent", counts: { recent: page.page.count } }
}

/** A discussion as the shared thread page reads one. */
export function asThreadDetail(discussion: DiscussionDetail): ThreadDetail<DiscussionList> {
  return { ...discussion, ...asThread(discussion), actions: { ...discussion.actions, set_status: noSuch, assign: noSuch, attach: noAttachments }, attachments: [], attachment_limits: { max_bytes: 0, max_name_bytes: 0 } }
}

/**
 * Haxy's own discussion paths, for `hubPathForThreadPath`: `<repo>/discussions[/recent|/labels][/search:<s>]`,
 * `<repo>/discussions/new`, `<repo>/discuss:<id>[/edit|/description]` and
 * `<repo>/discuss:<id>/comment:<c>` open the matching Hub pages.
 */
export const discussionPaths: ThreadPaths = { kind: "discussions", segment: "discuss", statuses: discussionLists }
