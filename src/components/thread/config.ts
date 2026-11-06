import type { ComponentType } from "react"
import type { Count, RequestOptions } from "@/lib/api"
import type { BranchChoices } from "@/lib/patches"
import type { RepoLocator } from "@/lib/repo"
import type { ThreadKind } from "@/lib/threads"

/**
 * What distinguishes one kind of thread (issues, discussions, patches)
 * for the shared thread components: its API/route segment, its
 * names, and its statuses in tab order (the first is the kind's default list;
 * discussions have one list, "recent", and no status).
 */
export type ThreadConfig<Status extends string> = {
  kind: ThreadKind
  /** Singular and plural nouns, capitalised for headings: "Issue", "Issues". */
  noun: string
  plural: string
  statuses: readonly Status[]
  statusLabels: Record<Status, string>
  /** The status a thread's button moves it to from each status, with the button's label ("Close issue"). */
  statusChanges: Partial<Record<Status, { to: Status; label: string }>>
  /** The search box's hint, when the kind's threads can't be searched by every filter (discussions have no assignees). */
  searchPlaceholder?: string
  /**
   * When set, the kind's forms also choose branches (patches): the source a
   * new thread proposes from and its target, among those this reads.
   */
  branches?: { load(repo: RepoLocator, options: Pick<RequestOptions, "signal">): Promise<BranchChoices> }
  /** Another way to open a thread, offered beside the new thread's form (a patch with a new fork). */
  newAlternative?: ComponentType<{ repo: RepoLocator }>
}

/** A count as a tab shows it: "22", "1000+" when counting stopped there, nothing when unknown. */
export function countText(count: Count | undefined): string {
  if (!count) return ""
  switch (count.kind) {
    case "exact": return count.value.toLocaleString("en-US")
    case "at_least": return `${count.value.toLocaleString("en-US")}+`
    case "unknown": return ""
  }
}

export const linkClass = "text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
