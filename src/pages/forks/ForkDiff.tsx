import { Link, useLocation } from "react-router"
import { EmptyState, FailureState, Pager } from "@/components/listing"
import { diffParams, displayPath, type DiffEntry } from "@/lib/diff"
import { forkDiffRoute, getForkDiff, type ForkDiff } from "@/lib/forks"
import { repoRoute, sourceKey, type ForkLocator } from "@/lib/repo"
import { useResource } from "@/lib/resource"
import { DiffFiles } from "@/pages/commits/CommitDiff"

const linkClass = "text-primary underline-offset-4 hover:underline"

function entryRoute(fork: ForkLocator, diff: ForkDiff, entry: DiffEntry): string | null {
  const at = entry.status === "removed" ? diff.base : diff.head
  return at === null ? null : repoRoute(fork, entry.path, `commit:${at}`)
}

function NoEntries({ fork, diff, cursor }: { fork: ForkLocator; diff: ForkDiff; cursor: string }) {
  const allFiles = forkDiffRoute(fork)
  if (diff.truncated) return <EmptyState title="These changes are incomplete">Haxy couldn't read this far into the diff: it is too large. <Link to={allFiles} className={linkClass}>Back to the start</Link></EmptyState>
  if (cursor) return <EmptyState title="No more changes"><Link to={forkDiffRoute(fork, { path: diff.path ?? "" })} className={linkClass}>Back to the first page</Link></EmptyState>
  if (diff.path !== null) return <EmptyState title="No changes to this file">This fork doesn't change it. <Link to={allFiles} className={linkClass}>Show all files</Link></EmptyState>
  return <EmptyState title="No changes">Nothing has been pushed to this fork beyond what it was made from.</EmptyState>
}

function DiffWindow({ fork, diff, cursor }: { fork: ForkLocator; diff: ForkDiff; cursor: string }) {
  const filter = diff.path
  return (
    <>
      <p className="mt-2 text-sm text-muted-foreground">
        {diff.base ? <>Everything its patch branch adds to <code className="font-mono">{diff.base.slice(0, 10)}</code>.</> : "Everything its patch branch holds."}
      </p>
      {filter !== null && (
        <p role="status" aria-label="Path filter" className="mt-4 text-sm">
          Showing changes to <code className="font-mono break-all">{displayPath(filter)}</code>. <Link to={forkDiffRoute(fork)} className={linkClass}>Show all files</Link>
        </p>
      )}
      {diff.items.length === 0 ? <NoEntries fork={fork} diff={diff} cursor={cursor} /> : (
        <DiffFiles items={diff.items} filtered={filter !== null} fileRoute={(entry) => entryRoute(fork, diff, entry)} onlyRoute={(path) => forkDiffRoute(fork, { path })} />
      )}
      {diff.truncated && diff.items.length > 0 && (
        <p role="status" aria-label="Truncated diff" className="mt-4 rounded-lg border px-4 py-2 text-sm">The rest of this diff is too large for Haxy to read, so it ends here.</p>
      )}
      <Pager page={diff.page} search="" cursor={cursor} noun="Diff" base={forkDiffRoute(fork, { path: filter ?? "" })} />
    </>
  )
}

/** `…/diff`: one window of everything the fork adds to its base, as the TUI's fork diff tab shows it. */
export function ForkDiffView({ fork }: { fork: ForkLocator }) {
  const location = useLocation()
  const { path, cursor } = diffParams(location.search)
  const diff = useResource(`fork diff ${sourceKey(fork)} ${path} ${cursor}`, (signal) => getForkDiff(fork, { path, cursor }, { signal }))
  return (
    <article aria-labelledby="fork-diff-heading" className="mt-6 min-w-0">
      <h2 id="fork-diff-heading" className="text-xl font-semibold">Changes in this fork</h2>
      {diff.kind === "failed" && (
        diff.error.code === "validation" && cursor
          ? <EmptyState title="This page of the changes is gone">{diff.error.message} <Link to={forkDiffRoute(fork, { path })} className={linkClass}>Back to the first page</Link></EmptyState>
          : <FailureState title="Couldn't load the changes" error={diff.error} onRetry={diff.reload} />
      )}
      {diff.kind === "loaded" && <DiffWindow fork={fork} diff={diff.data} cursor={cursor} />}
    </article>
  )
}
