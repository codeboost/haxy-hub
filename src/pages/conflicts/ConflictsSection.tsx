import { Link } from "react-router"
import { TriangleAlert } from "lucide-react"
import { useSession } from "@/app/session"
import { EmptyState, FailureState, Pager, useListParams } from "@/components/listing"
import { linkClass, type ThreadConfig } from "@/components/thread/config"
import { AuthorName, Instant, SectionUnavailable, ThreadTabs } from "@/components/thread/ThreadParts"
import { conflictRoute, conflictsRoute, listConflicts, type ConflictKind, type ConflictView } from "@/lib/conflicts"
import type { RepoLocator } from "@/lib/repo"
import { useResource } from "@/lib/resource"
import { threadRoute, type ThreadSummary } from "@/lib/threads"
import { ConflictPage } from "./ConflictPage"

/**
 * A thread section's conflict pages: `<repo>/<kind>/conflicts` lists the
 * threads with unresolved metadata conflicts, and `<repo>/<kind>/<id>/conflict`
 * shows one thread's conflict and resolves it.
 */
export function ConflictsSection<Status extends string>({ repo, config, view, unavailable }: { repo: RepoLocator; config: ThreadConfig<Status>; view: ConflictView; unavailable: string | null }) {
  const kind = config.kind as ConflictKind
  if (view.kind === "conflict") return <ConflictPage key={view.id} repo={repo} kind={kind} noun={config.noun} id={view.id} unavailable={unavailable} />
  return <ConflictsList repo={repo} config={config} kind={kind} unavailable={unavailable} />
}

function repoKey(repo: RepoLocator): string {
  return repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
}

function ConflictsList<Status extends string>({ repo, config, kind, unavailable }: { repo: RepoLocator; config: ThreadConfig<Status>; kind: ConflictKind; unavailable: string | null }) {
  const { cursor } = useListParams()
  const { viewerKey } = useSession()
  const conflicts = useResource(`conflicts ${kind} ${repoKey(repo)} ${cursor} ${viewerKey}`, (signal) => listConflicts(repo, kind, { cursor }, { signal }))
  if (conflicts.kind === "failed" && conflicts.error.code === "not_found" && unavailable) return <SectionUnavailable>{unavailable}</SectionUnavailable>
  const plural = config.plural.toLowerCase()
  const firstPage = conflictsRoute(repo, kind)
  return (
    <>
      <ThreadTabs repo={repo} config={config} current="conflicts" search="" />
      <p className="mt-4 max-w-3xl text-sm text-muted-foreground">
        {config.plural} whose details were edited differently on two hosts, which Haxy merged without choosing between them. Each keeps this host's values until someone resolves it.
      </p>
      {conflicts.kind === "failed" && (
        conflicts.error.code === "validation" && cursor
          ? <EmptyState title="This page is no longer available"><Link to={firstPage} className={linkClass}>Back to the first page</Link></EmptyState>
          : <FailureState title="Couldn't load the conflicts" error={conflicts.error} onRetry={conflicts.reload} />
      )}
      {conflicts.kind === "loaded" && (
        conflicts.data.items.length === 0 ? (
          <EmptyState title={`No ${plural} with metadata conflicts`} />
        ) : (
          <>
            <ul aria-label={`Conflicted ${plural}`} className="mt-4 divide-y rounded-xl border bg-card">
              {conflicts.data.items.map((thread) => <ConflictRow key={thread.id} repo={repo} kind={kind} noun={config.noun} thread={thread} />)}
            </ul>
            <Pager page={conflicts.data.page} search="" cursor={cursor} noun="Conflicts" base={firstPage} />
          </>
        )
      )}
    </>
  )
}

function ConflictRow({ repo, kind, noun, thread }: { repo: RepoLocator; kind: ConflictKind; noun: string; thread: ThreadSummary<string> }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-3">
      <div>
        <Link to={conflictRoute(repo, kind, thread.id)} className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">{thread.title}</Link>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1"><TriangleAlert size={12} aria-hidden />Conflict</span>
          <span>Opened <Instant value={thread.created_at} /> by <AuthorName author={thread.author} /></span>
        </div>
      </div>
      <Link to={threadRoute(repo, kind, thread.id)} className={`text-sm ${linkClass}`}>View {noun.toLowerCase()}</Link>
    </li>
  )
}
