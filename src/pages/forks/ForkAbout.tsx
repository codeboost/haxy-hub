import type { ReactNode } from "react"
import { Link } from "react-router"
import { ForkCommands } from "@/pages/patches/drafts/ForkCommands"
import { forkPatchRoute, type ForkSummary } from "@/lib/forks"
import { repoRoute } from "@/lib/repo"

const linkClass = "text-primary underline-offset-4 hover:underline"

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:gap-4">
      <dt className="w-32 shrink-0 text-sm font-medium text-muted-foreground">{term}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  )
}

function countText(count: number | null): string {
  if (count === null) return "Commit count unavailable"
  return `${count} ${count === 1 ? "commit" : "commits"}`
}

function patchText(summary: ForkSummary): string {
  if (summary.patch) return summary.patch.kind === "draft" ? "Open the draft" : "Open the patch"
  if (!summary.target) return "Its patch went with the repository."
  return summary.draft ? "A draft only its author can open." : "Its patch isn't there any more."
}

/** What the fork proposes and where it stands: its target, its patch, and what was pushed to it. */
function Facts({ summary }: { summary: ForkSummary }) {
  const patchRoute = forkPatchRoute(summary)
  const target = summary.target
  return (
    <dl className="divide-y rounded-xl border bg-card">
      <Row term="Status">{summary.draft ? "Draft" : "Published"}</Row>
      <Row term="Target">
        {target
          ? <>Branch <code className="font-mono">{summary.target_branch.name}</code> of <Link to={repoRoute({ kind: "server", owner: target.owner, name: target.name })} className={linkClass}>{target.owner}/{target.name}</Link></>
          : "A deleted repository"}
      </Row>
      <Row term="Patch">{patchRoute ? <Link to={patchRoute} className={linkClass}>{patchText(summary)}</Link> : patchText(summary)}</Row>
      <Row term="Pushed"><span aria-label="Commit count">{countText(summary.commit_count)}</span>, at <code className="font-mono">{summary.head.slice(0, 10)}</code></Row>
    </dl>
  )
}

/** Why a fork whose target was deleted can still be read, and what can still be done with it. */
function TargetDeleted() {
  return (
    <section aria-label="Target deleted" className="mt-4 rounded-xl border px-4 py-3 text-sm">
      <p className="font-medium">The repository this fork was made from has been deleted.</p>
      <p className="mt-1 text-muted-foreground">
        Only you can see the fork now. You can still browse its files, commits and diff, clone it or fetch its changes, and delete it,
        but it can't be pushed to, published or merged any more.
      </p>
    </section>
  )
}

/** The fork's own page: what it proposes, its patch, and its Git commands. */
export function ForkAbout({ summary }: { summary: ForkSummary }) {
  return (
    <>
      <section aria-label="About this fork" className="mt-6">
        <Facts summary={summary} />
      </section>
      {summary.target === null && <TargetDeleted />}
      {summary.commands.length > 0
        ? <ForkCommands commands={summary.commands} noun="fork" />
        : <p className="mt-6 text-sm text-muted-foreground">Haxy offers no Git commands for this fork: the server has no SSH access, or its patch has been merged.</p>}
    </>
  )
}
