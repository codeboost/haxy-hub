import { useState } from "react"
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router"
import { GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, Search, Tag } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState, FailureState, LoadingState, Pager } from "@/components/listing"
import { AuthorName, Instant } from "@/components/thread/ThreadParts"
import { commitRoute, commitsRoute, commitsView, getCommit, listCommits, type CommitPerson, type CommitStats, type CommitSummary, type History } from "@/lib/commits"
import { refsRoute, repoRoute, routeRef, type ReadRef, type RefId, type RepoLocator } from "@/lib/repo"
import { useResource } from "@/lib/resource"

// A repository's commit history at the default branch or the URL's `?ref=`,
// a page at a time (`?cursor=`), with Haxy's indexed commit search
// (`?search=`) where it has an index, and one commit's whole message
// (`…/commits/<id>`). Everything a view shows lives in the URL, so refresh,
// back/forward and shared links rebuild it.

const linkClass = "text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"

function repoKey(repo: RepoLocator): string {
  return repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
}

/** `<repo>/commits[/<id>]`: the history, or one commit. */
export function CommitsSection({ repo }: { repo: RepoLocator }) {
  const location = useLocation()
  // the router's own split after `…/commits/`, which matches the route
  // however the URL spells its segments (`%61lice`, `COMMITS`); a commit id
  // is plain hex, so its decoding changes nothing
  const view = commitsView(useParams()["*"] ?? "")
  const refId = routeRef(location.search)
  switch (view.kind) {
    case "history": return <HistoryView repo={repo} refId={refId} />
    case "commit": return <CommitView key={view.id} repo={repo} id={view.id} refId={refId} />
    case "unknown": return <EmptyState title="Page not found">There is no such commits page. <Link to={commitsRoute(repo)} className={linkClass}>Open the history</Link></EmptyState>
  }
}

const kindLabels: Record<ReadRef["kind"], string> = { branch: "Branch", tag: "Tag", commit: "Commit", revision: "Patch revision" }

/** Which ref the history is read at, and where else to go from it. */
function HistoryRef({ repo, refId, read }: { repo: RepoLocator; refId: RefId | null; read: ReadRef }) {
  const Icon = read.kind === "branch" ? GitBranch : read.kind === "tag" ? Tag : read.kind === "commit" ? GitCommitHorizontal : GitPullRequest
  return (
    <section aria-label="Ref" className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <span className="flex min-w-0 items-center gap-2">
        <Icon size={16} aria-hidden className="shrink-0 text-muted-foreground" />
        <span>{kindLabels[read.kind]}{" "}<code className="font-mono font-semibold break-all">{read.name ?? read.id.slice(read.id.indexOf(":") + 1)}</code></span>
      </span>
      <Link to={repoRoute(repo, "", refId)} className={linkClass}>Browse files</Link>
      <Link to={refsRoute(repo, read.kind === "tag" ? "tag" : "branch")} className={linkClass}>Branches and tags</Link>
      {refId !== null && <Link to={commitsRoute(repo)} className={linkClass}>Default branch</Link>}
    </section>
  )
}

/** The search box, which searches at the ref Haxy names (a commit's history is searched on the default branch). */
function CommitSearchForm({ repo, searchRef, search }: { repo: RepoLocator; searchRef: RefId; search: string }) {
  const navigate = useNavigate()
  const [value, setValue] = useState(search)
  return (
    <form
      role="search"
      className="mt-4 flex max-w-xl gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        // a new search starts from the first page; an empty one is the plain history
        void navigate(commitsRoute(repo, searchRef, { search: value.trim() }))
      }}
    >
      <label className="sr-only" htmlFor="commit-search">Search commits</label>
      <input
        id="commit-search"
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Words in commit messages"
        className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      />
      <Button type="submit" variant="outline"><Search />Search</Button>
    </form>
  )
}

function SearchState({ repo, refId, history, search }: { repo: RepoLocator; refId: RefId | null; history: History; search: string }) {
  if (!history.search.available) {
    return <p role="status" aria-label="Commit search" className="mt-4 text-sm text-muted-foreground">Commit search is unavailable here. {history.search.reason.message}</p>
  }
  return (
    <>
      <CommitSearchForm key={search} repo={repo} searchRef={history.search.ref} search={search} />
      {history.query !== null && (
        <p role="status" aria-label="Active search" className="mt-3 text-sm text-muted-foreground">
          Showing commits matching “{history.query}”. <Link to={commitsRoute(repo, refId)} className={linkClass}>Show the whole history</Link>
        </p>
      )}
    </>
  )
}

function countText(history: History): string | null {
  const count = history.page.count
  if (count.kind === "unknown") return null
  const value = count.value.toLocaleString("en-US")
  return `${count.kind === "at_least" ? `${value}+` : value} ${count.value === 1 ? "commit" : "commits"}`
}

function HistoryView({ repo, refId }: { repo: RepoLocator; refId: RefId | null }) {
  const [params] = useSearchParams()
  const search = params.get("search") ?? ""
  const cursor = params.get("cursor") ?? ""
  const history = useResource(`commits ${repoKey(repo)} ${refId} ${search} ${cursor}`, (signal) => listCommits(repo, { ref: refId, search, cursor }, { signal }))

  return (
    <section aria-labelledby="commits-heading">
      <h2 id="commits-heading" className="sr-only">History</h2>
      {history.kind === "loading" && <LoadingState>Loading the history…</LoadingState>}
      {history.kind === "failed" && (
        history.error.code === "not_found" ? (
          refId === null ? <EmptyState title="No commits yet">{history.error.message}</EmptyState>
            : <EmptyState title="No such ref">{history.error.message} <Link to={commitsRoute(repo)} className={linkClass}>Show the default branch's history</Link></EmptyState>
        ) : history.error.code === "unsupported" && search ? (
          // a search Haxy can't run here: unavailable, which isn't the same as no matches
          <EmptyState title="Commit search is unavailable">{history.error.message} <Link to={commitsRoute(repo, refId)} className={linkClass}>Show the history</Link></EmptyState>
        ) : history.error.code === "validation" && cursor ? (
          <EmptyState title="This page of the history is gone">{history.error.message} <Link to={commitsRoute(repo, refId, { search })} className={linkClass}>Back to the first page</Link></EmptyState>
        ) : (
          <FailureState title="Couldn't load the history" error={history.error} onRetry={history.reload} />
        )
      )}
      {history.kind === "loaded" && (
        <>
          <HistoryRef repo={repo} refId={refId} read={history.data.ref} />
          <SearchState repo={repo} refId={refId} history={history.data} search={search} />
          {countText(history.data) && <p className="mt-4 text-sm text-muted-foreground">{countText(history.data)}</p>}
          {!history.data.history.available ? (
            // not an empty history: Haxy doesn't hold these commits
            <EmptyState title="This history is unavailable">{history.data.history.reason.message}</EmptyState>
          ) : history.data.items.length === 0 ? (
            history.data.query !== null ? <EmptyState title={`No commits match “${history.data.query}”`}>Words match from their start, in any order.</EmptyState>
              : cursor ? <EmptyState title="No more commits"><Link className={linkClass} to={commitsRoute(repo, refId)}>Back to the first page</Link></EmptyState>
              : <EmptyState title="No commits" />
          ) : (
            <ol aria-label="Commits" className="mt-4 divide-y rounded-xl border bg-card">
              {history.data.items.map((commit) => <CommitRow key={commit.id} repo={repo} refId={refId} commit={commit} />)}
            </ol>
          )}
          <Pager page={history.data.page} search={search} cursor={cursor} noun="History" base={commitsRoute(repo, refId)} />
        </>
      )}
    </section>
  )
}

function Person({ person, role }: { person: CommitPerson; role: string }) {
  return <span>{role} <AuthorName author={person} /></span>
}

/** Haxy's statistics as the TUI's stats box shows them: counts that aren't zero, and the byte delta always. */
function statsParts(stats: CommitStats): string[] {
  const plural = (count: number, noun: string) => `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`
  const bytes = stats.bytes_added - stats.bytes_removed
  const parts: Array<[number, string, string]> = [
    [stats.lines_added, "line", "added"],
    [stats.lines_changed, "line", "changed"],
    [stats.lines_removed, "line", "removed"],
  ]
  const files: Array<[number, string, string]> = [
    [stats.files_added, "file", "added"],
    [stats.files_changed, "file", "changed"],
    [stats.files_removed, "file", "removed"],
  ]
  return [
    ...parts.filter(([count]) => count !== 0).map(([count, noun, verb]) => `${plural(count, noun)} ${verb}`),
    `${plural(Math.abs(bytes), "byte")} ${bytes >= 0 ? "added" : "removed"}`,
    ...files.filter(([count]) => count !== 0).map(([count, noun, verb]) => `${plural(count, noun)} ${verb}`),
  ]
}

function Stats({ stats }: { stats: CommitStats | null }) {
  if (stats === null) return <span className="text-muted-foreground">Statistics unavailable</span>
  return <span aria-label="Statistics">{statsParts(stats).join(" · ")}</span>
}

function MergeBadge() {
  return <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"><GitMerge size={12} aria-hidden />Merge</span>
}

function CommitRow({ repo, refId, commit }: { repo: RepoLocator; refId: RefId | null; commit: CommitSummary }) {
  return (
    <li aria-label={commit.summary || commit.id} className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Link to={commitRoute(repo, commit.id, refId)} className={`font-medium break-all ${linkClass}`}>{commit.summary || "(no message)"}</Link>
        {commit.merge && <MergeBadge />}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
        <code className="font-mono">{commit.id.slice(0, 10)}</code>
        <Person person={commit.author} role="by" />
        {commit.committer && <Person person={commit.committer} role="committed by" />}
        <Instant value={commit.committed_at} />
      </div>
      <div className="mt-1 text-xs"><Stats stats={commit.stats} /></div>
    </li>
  )
}

/** One commit: who and when, its statistics, and its whole message up to Haxy's limit. */
function CommitView({ repo, id, refId }: { repo: RepoLocator; id: string; refId: RefId | null }) {
  const commit = useResource(`commit ${repoKey(repo)} ${id}`, (signal) => getCommit(repo, id, { signal }))
  const back = <Link to={commitsRoute(repo, refId)} className={linkClass}>Back to the history</Link>
  if (commit.kind === "loading") return <LoadingState>Loading the commit…</LoadingState>
  if (commit.kind === "failed") {
    return commit.error.code === "not_found"
      ? <EmptyState title="No such commit">{commit.error.message} {back}</EmptyState>
      : <FailureState title="Couldn't load the commit" error={commit.error} onRetry={commit.reload} />
  }
  const data = commit.data
  return (
    <article aria-labelledby="commit-heading" className="mt-6">
      <p className="text-sm">{back}</p>
      <h2 id="commit-heading" className="mt-3 flex flex-wrap items-center gap-2 text-xl font-semibold break-all">
        {data.summary || "(no message)"}
        {data.merge && <MergeBadge />}
      </h2>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Commit</dt>
        <dd><code className="font-mono break-all">{data.id}</code></dd>
        <dt className="text-muted-foreground">Author</dt>
        <dd><AuthorName author={data.author} /></dd>
        {data.committer && (
          <>
            <dt className="text-muted-foreground">Committer</dt>
            <dd><AuthorName author={data.committer} /></dd>
          </>
        )}
        <dt className="text-muted-foreground">Committed</dt>
        <dd><Instant value={data.committed_at} /></dd>
        <dt className="text-muted-foreground">Parent</dt>
        <dd>{data.parent ? <Link to={commitRoute(repo, data.parent, refId)} className={`font-mono ${linkClass}`}>{data.parent.slice(0, 10)}</Link> : "None (a root commit)"}</dd>
        <dt className="text-muted-foreground">Statistics</dt>
        <dd><Stats stats={data.stats} /></dd>
      </dl>
      <p className="mt-4 text-sm"><Link to={repoRoute(repo, "", `commit:${data.id}`)} className={linkClass}>Browse files at this commit</Link></p>
      {data.message_truncated && (
        <p role="status" aria-label="Truncated message" className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-2 text-sm">
          This message is longer than Haxy reads; only its start is shown.
        </p>
      )}
      <pre aria-label="Commit message" className="mt-4 overflow-x-auto rounded-xl border bg-card p-4 font-mono text-sm whitespace-pre-wrap break-words">{data.message}</pre>
    </article>
  )
}
