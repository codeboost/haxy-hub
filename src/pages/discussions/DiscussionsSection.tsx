import type { ThreadConfig } from "@/components/thread/config"
import { ThreadSection } from "@/components/thread/ThreadSection"
import { discussionLists, type DiscussionList } from "@/lib/discussions"
import type { RepoLocator, RepoSection } from "@/lib/repo"

/** Discussions have the TUI's one list, "recent", and no status to change. */
export const discussionThreads: ThreadConfig<DiscussionList> = {
  kind: "discussions",
  noun: "Discussion",
  plural: "Discussions",
  statuses: discussionLists,
  statusLabels: { recent: "Recent" },
  statusChanges: {},
  searchPlaceholder: "Words, label:name",
}

/**
 * A repository's discussions: `<repo>/discussions[/labels|/new|/<id>…]`,
 * through the shared thread pieces. They are always requested, since another
 * client may have turned them on or off since `sections` was read; when Haxy
 * answers not found and the sections (read again on each navigation) lack
 * discussions, they are turned off, as the TUI then has no discussions tab.
 */
export function DiscussionsSection({ repo, sections, tail }: { repo: RepoLocator; sections: RepoSection[]; tail: string }) {
  const unavailable = sections.includes("discussions") ? null : "Discussions are turned off for this repository."
  return <ThreadSection repo={repo} config={discussionThreads} tail={tail} unavailable={unavailable} />
}
