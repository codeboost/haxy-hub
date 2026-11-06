import { Link, useLocation } from "react-router"
import { EmptyState, FailureState, LoadingState, Pager } from "@/components/listing"
import { linkClass } from "@/components/thread/config"
import { commitRoute } from "@/lib/commits"
import { diffParams, displayPath } from "@/lib/diff"
import { diffPatchParam, getRevisionDiff, revisionCommitsRoute, revisionDiffRoute, revisionFilesRoute, revisionRef, type RevisionDiff } from "@/lib/patches"
import { repoRoute, type RepoLocator } from "@/lib/repo"
import { useResource } from "@/lib/resource"
import { threadRoute, threadsRoute } from "@/lib/threads"
import { DiffFiles } from "@/pages/commits/CommitDiff"
import { patchThreads } from "./config"

// A patch revision's diff (`…/patches/revisions/<id>/diff`): the tree of the
// commit it was based on against its source commit's, as the TUI's patch
// diff shows it, so what the target had before is left out. A window at a
// time (`?cursor=`), optionally narrowed to one file (`?path=`, an encoded
// path read from the raw query string); `?patch=` is the patch it was opened
// from. Everything it shows lives in the URL, so refresh, back/forward and
// shared links rebuild it.

function repoKey(repo: RepoLocator): string {
  return repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
}

export function RevisionDiffView({ repo, revision }: { repo: RepoLocator; revision: string }) {
  const location = useLocation()
  const { path, cursor } = diffParams(location.search)
  const patch = diffPatchParam(location.search)
  const diff = useResource(`revision diff ${repoKey(repo)} ${revision} ${path} ${cursor}`, (signal) => getRevisionDiff(repo, revision, { path, cursor }, { signal }), location.key)
  const allFiles = revisionDiffRoute(repo, revision, { patch })

  return (
    <article aria-labelledby="diff-heading" className="mt-6 min-w-0">
      <p className="text-sm">
        {patch
          ? <Link to={threadRoute(repo, "patches", patch)} className={linkClass}>Back to the patch</Link>
          : <Link to={threadsRoute(repo, "patches", patchThreads.statuses, "open")} className={linkClass}>All patches</Link>}
      </p>
      <h2 id="diff-heading" className="mt-3 text-xl font-semibold">Changes in revision <code className="font-mono">{revision.slice(0, 10)}</code></h2>
      {diff.kind === "loading" && <LoadingState>Loading the changes…</LoadingState>}
      {diff.kind === "failed" && (
        diff.error.code === "not_found" ? (
          <EmptyState title="No such revision">{diff.error.message}</EmptyState>
        ) : diff.error.code === "validation" && cursor ? (
          <EmptyState title="This page of the changes is gone">{diff.error.message} <Link to={revisionDiffRoute(repo, revision, { patch, path })} className={linkClass}>Back to the first page</Link></EmptyState>
        ) : diff.error.code === "validation" && path ? (
          <EmptyState title="This path can't be shown">{diff.error.message} <Link to={allFiles} className={linkClass}>Show all files</Link></EmptyState>
        ) : (
          <FailureState title="Couldn't load the changes" error={diff.error} onRetry={diff.reload} />
        )
      )}
      {diff.kind === "loaded" && <DiffWindow repo={repo} patch={patch} diff={diff.data} cursor={cursor} allFiles={allFiles} />}
    </article>
  )
}

function DiffWindow({ repo, patch, diff, cursor, allFiles }: { repo: RepoLocator; patch: string | null; diff: RevisionDiff; cursor: string; allFiles: string }) {
  const filter = diff.path
  const ref = revisionRef(diff.revision)
  // a removed file is read as the base had it; anything else as the revision has it
  const fileRoute = (entry: { path: string; status: string }) => entry.status === "removed"
    ? (diff.base === null ? null : repoRoute(repo, entry.path, `commit:${diff.base}`))
    : repoRoute(repo, entry.path, ref)
  return (
    <>
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>
          {diff.base
            ? <>Compared with the commit it was based on, <Link to={commitRoute(repo, diff.base)} className={`font-mono ${linkClass}`}>{diff.base.slice(0, 10)}</Link></>
            : "Based on a branch without commits: every file it holds is added."}
        </span>
        <Link to={revisionFilesRoute(repo, diff.revision)} className={linkClass}>Browse files at this revision</Link>
        <Link to={revisionCommitsRoute(repo, diff.revision)} className={linkClass}>Commits in this revision</Link>
      </p>
      {filter !== null && (
        <p role="status" aria-label="Path filter" className="mt-4 text-sm">
          Showing changes to <code className="font-mono break-all">{displayPath(filter)}</code>. <Link to={allFiles} className={linkClass}>Show all files</Link>
        </p>
      )}
      {diff.items.length === 0 ? (
        // cut short before any entry: whatever it would have held was never read
        diff.truncated ? <EmptyState title="These changes are incomplete">Haxy couldn't read this far into the diff: it is too large. <Link to={allFiles} className={linkClass}>Back to the start</Link></EmptyState>
          : cursor ? <EmptyState title="No more changes"><Link to={revisionDiffRoute(repo, diff.revision, { patch, path: filter ?? "" })} className={linkClass}>Back to the first page</Link></EmptyState>
          : filter !== null ? <EmptyState title="No changes to this file">This revision doesn't change it. <Link to={allFiles} className={linkClass}>Show all files</Link></EmptyState>
          : <EmptyState title="No changes">This revision changes no files: its source commit's files are the ones it was based on.</EmptyState>
      ) : (
        <DiffFiles items={diff.items} filtered={filter !== null} fileRoute={fileRoute} onlyRoute={(entryPath) => revisionDiffRoute(repo, diff.revision, { patch, path: entryPath })} />
      )}
      {diff.truncated && (
        <p role="status" aria-label="Truncated diff" className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-2 text-sm">
          The rest of this diff is too large for Haxy to read, so it ends here.
        </p>
      )}
      <Pager page={diff.page} search="" cursor={cursor} noun="Diff" base={revisionDiffRoute(repo, diff.revision, { patch, path: filter ?? "" })} />
    </>
  )
}
