import { Link, useLocation } from "react-router"
import { File } from "lucide-react"
import { EmptyState, FailureState, Pager, SearchForm, useListParams } from "@/components/listing"
import { findFiles, findRoute, type FindAnswer } from "@/lib/finder"
import { displaySegment, parentPath, pathSegments, repoRoute, routeRef, type ReadRef, type RefId, type RepoLocator } from "@/lib/repo"
import { useResource } from "@/lib/resource"

// Finding files by name at a ref, from Haxy's file index, as the TUI's files
// tab finds them. The ref, the search and the page live in the URL
// (`…/find?ref=<id>&search=…&cursor=…`). A result opens the file at the same
// ref; a view Haxy hasn't indexed says why rather than listing nothing.

const linkClass = "text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"

const refNouns: Record<ReadRef["kind"], string> = { branch: "branch", tag: "tag", commit: "commit", revision: "patch revision" }

function repoKey(repo: RepoLocator): string {
  return repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
}

function refLabel(ref: ReadRef): string {
  return ref.name ?? ref.id.slice(ref.id.indexOf(":") + 1)
}

/** The ref searched, and the way back to its files. */
function RefLine({ repo, refId, read }: { repo: RepoLocator; refId: RefId | null; read: ReadRef }) {
  return (
    <p className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <span>Finding files at {refNouns[read.kind]} <code className="font-mono font-semibold break-all">{refLabel(read)}</code></span>
      <Link to={repoRoute(repo, "", refId)} className={linkClass}>Browse files</Link>
    </p>
  )
}

function Results({ repo, refId, answer, search, cursor }: { repo: RepoLocator; refId: RefId | null; answer: Extract<FindAnswer, { kind: "indexed" }>; search: string; cursor: string }) {
  const count = answer.page.count
  if (answer.items.length === 0) {
    // a later page can be empty when the branch moved since its link was made
    return cursor ? (
      <EmptyState title="No more files"><Link className={linkClass} to={findRoute(repo, refId, { search })}>Back to the first page</Link></EmptyState>
    ) : (
      <EmptyState title={`No files match “${search}”`}>Names are matched from their start; ASCII letters match in either case.</EmptyState>
    )
  }
  return (
    <>
      {count.kind !== "unknown" && (
        <p role="status" aria-label="Result count" className="mt-6 text-sm text-muted-foreground">
          {count.kind === "at_least" ? `${count.value.toLocaleString("en-US")}+ files match; Haxy lists the first ${count.value.toLocaleString("en-US")}. Type more of the name to narrow them.` : `${count.value.toLocaleString("en-US")} ${count.value === 1 ? "file matches" : "files match"}.`}
        </p>
      )}
      <ul aria-label="Found files" className="mt-4 divide-y rounded-xl border bg-card">
        {answer.items.map((item) => {
          const dir = parentPath(item.path)
          return (
            <li key={item.path}>
              <Link to={repoRoute(repo, item.path, refId)} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                <File size={16} aria-hidden className="shrink-0 self-center text-muted-foreground" />
                <span className="font-mono font-medium break-all">{item.name}</span>
                {dir && <span className="font-mono text-xs break-all text-muted-foreground">{pathSegments(dir).map(displaySegment).join("/")}</span>}
              </Link>
            </li>
          )
        })}
      </ul>
      <Pager page={answer.page} search={search} cursor={cursor} noun="Found files" base={findRoute(repo, refId)} />
    </>
  )
}

/** Why a view has no file index, in its own words for each case. */
function Unindexed({ repo, refId, answer }: { repo: RepoLocator; refId: RefId | null; answer: Exclude<FindAnswer, { kind: "indexed" }> }) {
  const browse = <Link to={repoRoute(repo, "", refId)} className={linkClass}>Browse its files</Link>
  if (answer.kind === "no_index") {
    return (
      <EmptyState title="This branch has no file index">
        Haxy indexes a branch's files when commits are pushed to it, and no index covers the latest commit of <code className="font-mono">{refLabel(answer.ref)}</code>. {browse} instead.
      </EmptyState>
    )
  }
  if (answer.reason === "repository") {
    return (
      <EmptyState title="This repository can't be searched by file name">
        Haxy keeps file indexes only for its own (xit) repositories, and this is a Git repository. {browse} instead.
      </EmptyState>
    )
  }
  return (
    <EmptyState title={`Files can't be found by name at a ${refNouns[answer.ref.kind]}`}>
      Haxy indexes branches only. {browse}, or <Link to={findRoute(repo)} className={linkClass}>find files on the default branch</Link>.
    </EmptyState>
  )
}

/** The file finder for `repo`, at the URL's ref. */
export function FileFinder({ repo }: { repo: RepoLocator }) {
  const location = useLocation()
  // not the search params, which have decoded the ref
  const refId = routeRef(location.search)
  const { search, cursor } = useListParams()
  const answer = useResource(`find ${repoKey(repo)} ${refId} ${search} ${cursor}`, (signal) => findFiles(repo, { ref: refId, search, cursor }, { signal }))
  return (
    <section aria-labelledby="finder-heading" className="mt-6">
      <h2 id="finder-heading" className="text-lg font-semibold">Find a file</h2>
      {answer.kind === "failed" && (
        answer.error.code === "not_found" ? (
          <EmptyState title="Nothing here at this ref">{answer.error.message} <Link to={findRoute(repo)} className={linkClass}>Find files on the default branch</Link></EmptyState>
        ) : answer.error.code === "validation" && answer.error.fieldError("ref") ? (
          <EmptyState title="This isn't a ref Haxy knows how to read">{answer.error.fieldError("ref")} <Link to={findRoute(repo)} className={linkClass}>Find files on the default branch</Link></EmptyState>
        ) : (
          <FailureState title="Couldn't find files" error={answer.error} onRetry={answer.reload} />
        )
      )}
      {answer.kind === "loaded" && (
        <>
          <RefLine repo={repo} refId={refId} read={answer.data.ref} />
          {answer.data.kind === "indexed" ? (
            <>
              <div className="mt-4">
                {/* file names may start or end with spaces, so the search is sent as typed */}
                <SearchForm key={search} label="Find files by name" search={search} exact base={findRoute(repo, refId)} />
              </div>
              {search ? (
                <Results repo={repo} refId={refId} answer={answer.data} search={search} cursor={cursor} />
              ) : (
                <p className="mt-6 text-sm text-muted-foreground">Type the start of a file name. ASCII letters match in either case.</p>
              )}
            </>
          ) : (
            <Unindexed repo={repo} refId={refId} answer={answer.data} />
          )}
        </>
      )}
    </section>
  )
}
