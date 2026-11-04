import type { Count } from "@/lib/api"
import type { ThreadKind } from "@/lib/threads"

/**
 * What distinguishes one kind of thread (issues; later discussions and
 * patches) for the shared thread components: its API/route segment, its
 * names, and its statuses in tab order (the first is the kind's default list).
 */
export type ThreadConfig<Status extends string> = {
  kind: ThreadKind
  /** Singular and plural nouns, capitalised for headings: "Issue", "Issues". */
  noun: string
  plural: string
  statuses: readonly Status[]
  statusLabels: Record<Status, string>
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
