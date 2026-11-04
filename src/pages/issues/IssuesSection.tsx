import type { ThreadConfig } from "@/components/thread/config"
import { ThreadSection } from "@/components/thread/ThreadSection"
import type { RepoLocator, RepoSection } from "@/lib/repo"
import type { IssueStatus } from "@/lib/threads"

export const issueThreads: ThreadConfig<IssueStatus> = {
  kind: "issues",
  noun: "Issue",
  plural: "Issues",
  statuses: ["open", "closed"],
  statusLabels: { open: "Open", closed: "Closed" },
}

/**
 * A repository's issues: `<repo>/issues[/closed|/labels|/<id>]`. The issues
 * are always requested, since another client may have turned them on or off
 * since `sections` was read. When Haxy answers not found and the repository's
 * sections (read again on each navigation) lack issues, they are turned off,
 * as the TUI then has no issues tab.
 */
export function IssuesSection({ repo, sections, tail }: { repo: RepoLocator; sections: RepoSection[]; tail: string }) {
  const unavailable = sections.includes("issues") ? null : "Issues are turned off for this repository."
  return <ThreadSection repo={repo} config={issueThreads} tail={tail} unavailable={unavailable} />
}
