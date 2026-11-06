import { Link, useLocation } from "react-router"
import { EmptyState, FailureState, Pager } from "@/components/listing"
import { commitRoute, commitsRoute } from "@/lib/commits"
import { commitDiffRoute, diffParams, displayPath, entryFileRoute, getCommitDiff, type CommitDiff, type DiffEntry, type DiffLine } from "@/lib/diff"
import { repoRoute, type EncodedPath, type RefId, type RepoLocator } from "@/lib/repo"
import { useResource } from "@/lib/resource"

// A commit's diff against its first parent (`…/commits/<id>/diff`), a window
// of Haxy's diff pane at a time (`?cursor=`), optionally narrowed to one
// file (`?path=`, an encoded path read from the raw query string). Everything
// it shows lives in the URL, so refresh, back/forward and shared links
// rebuild it.

const linkClass = "text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"

function repoKey(repo: RepoLocator): string {
  return repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
}

/** `…/commits/<id>/diff`: one window of a commit's diff. */
export function CommitDiffView({ repo, id, refId }: { repo: RepoLocator; id: string; refId: RefId | null }) {
  const location = useLocation()
  const { path, cursor } = diffParams(location.search)
  const diff = useResource(`diff ${repoKey(repo)} ${id} ${path} ${cursor}`, (signal) => getCommitDiff(repo, id, { path, cursor }, { signal }))
  const allFiles = commitDiffRoute(repo, id, refId)

  return (
    <article aria-labelledby="diff-heading" className="mt-6 min-w-0">
      <p className="text-sm"><Link to={commitRoute(repo, id, refId)} className={linkClass}>Back to the commit</Link></p>
      <h2 id="diff-heading" className="mt-3 text-xl font-semibold">Changes in commit <code className="font-mono">{id.slice(0, 10)}</code></h2>
      {diff.kind === "failed" && (
        diff.error.code === "not_found" ? (
          <EmptyState title="No such commit">{diff.error.message} <Link to={commitsRoute(repo, refId)} className={linkClass}>Open the history</Link></EmptyState>
        ) : diff.error.code === "validation" && cursor ? (
          <EmptyState title="This page of the changes is gone">{diff.error.message} <Link to={commitDiffRoute(repo, id, refId, { path })} className={linkClass}>Back to the first page</Link></EmptyState>
        ) : diff.error.code === "validation" && path ? (
          <EmptyState title="This path can't be shown">{diff.error.message} <Link to={allFiles} className={linkClass}>Show all files</Link></EmptyState>
        ) : (
          <FailureState title="Couldn't load the changes" error={diff.error} onRetry={diff.reload} />
        )
      )}
      {diff.kind === "loaded" && <DiffWindow repo={repo} refId={refId} diff={diff.data} cursor={cursor} allFiles={allFiles} />}
    </article>
  )
}

function DiffWindow({ repo, refId, diff, cursor, allFiles }: { repo: RepoLocator; refId: RefId | null; diff: CommitDiff; cursor: string; allFiles: string }) {
  const filter = diff.path
  return (
    <>
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>
          {diff.parent
            ? <>Compared with its parent <Link to={commitRoute(repo, diff.parent, refId)} className={`font-mono ${linkClass}`}>{diff.parent.slice(0, 10)}</Link></>
            : "A root commit: every file it holds is added."}
        </span>
        <Link to={repoRoute(repo, "", `commit:${diff.commit}`)} className={linkClass}>Browse files at this commit</Link>
      </p>
      {filter !== null && (
        <p role="status" aria-label="Path filter" className="mt-4 text-sm">
          Showing changes to <code className="font-mono break-all">{displayPath(filter)}</code>. <Link to={allFiles} className={linkClass}>Show all files</Link>
        </p>
      )}
      {diff.items.length === 0 ? (
        // cut short before any entry: whatever it would have held was never read
        diff.truncated ? <EmptyState title="These changes are incomplete">Haxy couldn't read this far into the diff: it is too large. <Link to={allFiles} className={linkClass}>Back to the start</Link></EmptyState>
          : cursor ? <EmptyState title="No more changes"><Link to={commitDiffRoute(repo, diff.commit, refId, { path: filter ?? "" })} className={linkClass}>Back to the first page</Link></EmptyState>
          : filter !== null ? <EmptyState title="No changes to this file">This commit doesn't change it. <Link to={allFiles} className={linkClass}>Show all files</Link></EmptyState>
          : <EmptyState title="No changes">This commit changes no files.</EmptyState>
      ) : (
        <DiffFiles items={diff.items} filtered={filter !== null} fileRoute={(entry) => entryFileRoute(repo, diff, entry)} onlyRoute={(path) => commitDiffRoute(repo, diff.commit, refId, { path })} />
      )}
      {diff.truncated && (
        <p role="status" aria-label="Truncated diff" className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-2 text-sm">
          The rest of this diff is too large for Haxy to read, so it ends here.
        </p>
      )}
      <Pager page={diff.page} search="" cursor={cursor} noun="Diff" base={commitDiffRoute(repo, diff.commit, refId, { path: filter ?? "" })} />
    </>
  )
}

/**
 * A diff window's entries, each file's under its path, with where to read
 * the file (`fileRoute`) and, unless the window is `filtered` already, the
 * diff narrowed to it (`onlyRoute`). Commit and revision diffs share it.
 */
export function DiffFiles({ items, filtered, fileRoute, onlyRoute }: { items: DiffEntry[]; filtered: boolean; fileRoute(entry: DiffEntry): string | null; onlyRoute(path: EncodedPath): string }) {
  return (
    <section aria-label="Changes" className="mt-4 flex min-w-0 flex-col gap-4">
      {groups(items).map((group, index) => (
        <FileChanges key={`${index} ${group[0].path}`} entries={group} filtered={filtered} file={fileRoute(group[0])} only={onlyRoute(group[0].path)} />
      ))}
    </section>
  )
}

/** Consecutive entries of one file (its hunks), together. */
function groups(entries: DiffEntry[]): DiffEntry[][] {
  const out: DiffEntry[][] = []
  for (const entry of entries) {
    const last = out[out.length - 1]
    if (last && last[0].path === entry.path) last.push(entry)
    else out.push([entry])
  }
  return out
}

const statusLabels: Record<DiffEntry["status"], string> = { added: "Added", removed: "Removed", changed: "Changed" }
const statusClasses: Record<DiffEntry["status"], string> = {
  added: "border-green-600/40 text-green-700 dark:text-green-400",
  removed: "border-red-600/40 text-red-700 dark:text-red-400",
  changed: "border-border text-muted-foreground",
}

/** One file's entries in a window, under its path. */
function FileChanges({ entries, filtered, file, only }: { entries: DiffEntry[]; filtered: boolean; file: string | null; only: string }) {
  const first = entries[0]
  const shown = displayPath(first.path)
  return (
    <section aria-label={shown} className="min-w-0 rounded-xl border bg-card">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-sm">
        <code className="min-w-0 font-mono font-medium break-all">{shown}</code>
        <span className={`rounded-full border px-2 py-0.5 text-xs ${statusClasses[first.status]}`}>{statusLabels[first.status]}</span>
        <span className="ml-auto flex flex-wrap gap-x-3">
          {file && <Link to={file} className={linkClass}>View file</Link>}
          {!filtered && <Link to={only} className={linkClass}>Only this file</Link>}
        </span>
      </header>
      {entries.map((entry, index) => <EntryBody key={index} entry={entry} shown={shown} />)}
    </section>
  )
}

function Placeholder({ children }: { children: string }) {
  return <p className="px-4 py-3 text-sm text-muted-foreground">{children}</p>
}

function EntryBody({ entry, shown }: { entry: DiffEntry; shown: string }) {
  switch (entry.kind) {
    case "file": return <Placeholder>{entry.status === "added" ? "A new file; open it to read it." : "The file was removed; open it to read what it held."}</Placeholder>
    case "binary": return <Placeholder>Binary file not shown: Haxy doesn't diff files that aren't UTF-8 text or that pass its text limits, such as a line of 10,000 bytes or more.</Placeholder>
    case "too_large": return <Placeholder>This change is too large for Haxy to diff.</Placeholder>
    case "hunk": return <Hunk lines={entry.lines} path={shown} />
  }
}

const lineClasses: Record<DiffLine["kind"], string> = {
  context: "",
  added: "bg-green-500/10",
  removed: "bg-red-500/10",
}
const prefixes: Record<DiffLine["kind"], string> = { context: " ", added: "+", removed: "-" }

/** How a line reads aloud: what happened to it, its number and its text. */
function lineLabel(line: DiffLine): string {
  switch (line.kind) {
    case "added": return `Added, line ${line.new_number}: ${line.text}`
    case "removed": return `Removed, line ${line.old_number}: ${line.text}`
    case "context": return `Line ${line.new_number}: ${line.text}`
  }
}

/** A hunk's lines, which scroll sideways inside their own box rather than widening the page. */
function Hunk({ lines, path }: { lines: DiffLine[]; path: EncodedPath }) {
  return (
    <div className="max-w-full overflow-x-auto border-t first:border-t-0">
      <table aria-label={`Changes to ${path}`} className="w-max min-w-full border-collapse font-mono text-xs leading-5">
        <tbody>
          {lines.map((line, index) => (
            <tr key={index} aria-label={lineLabel(line)} className={lineClasses[line.kind]}>
              <td className="w-px px-2 text-right text-muted-foreground select-none">{line.old_number ?? ""}</td>
              <td className="w-px px-2 text-right text-muted-foreground select-none">{line.new_number ?? ""}</td>
              <td className="w-px pl-2 select-none">{prefixes[line.kind]}</td>
              <td className="pr-4 whitespace-pre">{line.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
