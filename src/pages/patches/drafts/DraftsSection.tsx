import { Link, useLocation } from "react-router"
import { ArrowLeft, GitFork, NotebookPen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState, FailureState, Pager, useListParams } from "@/components/listing"
import { linkClass } from "@/components/thread/config"
import { Instant, SectionUnavailable } from "@/components/thread/ThreadParts"
import { useSession } from "@/app/session"
import { draftRoute, draftsRoute, listDrafts, newDraftRoute, type DraftSummary, type DraftView } from "@/lib/drafts"
import { patchStatuses } from "@/lib/patches"
import type { RepoLocator } from "@/lib/repo"
import { useResource } from "@/lib/resource"
import { loginPath } from "@/lib/session"
import { threadsRoute } from "@/lib/threads"
import { DraftDetailView } from "./DraftDetail"
import { DraftEditView } from "./DraftEdit"
import { DraftNewView } from "./DraftNew"

/**
 * The viewer's drafts of a repository's patches, as `<repo>/patches/drafts/<tail>`
 * names them: their list, the form that starts one with a new fork (`new`),
 * one draft, and the form that edits it (`<id>/edit`). Drafts live on a
 * server only.
 */
export function DraftsSection({ repo, view, unavailable }: { repo: RepoLocator; view: DraftView; unavailable: string | null }) {
  if (repo.kind === "local") return <SectionUnavailable>Local mode has no drafts; propose changes from a branch instead.</SectionUnavailable>
  switch (view.kind) {
    case "list":
      return <DraftListView repo={repo} unavailable={unavailable} />
    case "new":
      return <DraftNewView repo={repo} unavailable={unavailable} />
    case "draft":
      return <DraftDetailView key={view.id} repo={repo} id={view.id} unavailable={unavailable} />
    case "edit":
      return <DraftEditView key={view.id} repo={repo} id={view.id} unavailable={unavailable} />
    case "unknown":
      return (
        <section className="mt-6">
          <h2 className="text-2xl font-semibold tracking-tight">Page not found</h2>
          <Link to={draftsRoute(repo)} className={`mt-4 inline-block text-sm ${linkClass}`}>Your drafts</Link>
        </section>
      )
  }
}

/** The way to the viewer's drafts, beside a patches list, on a server where someone is signed in. */
export function DraftsLink({ repo }: { repo: RepoLocator }) {
  const { viewer } = useSession()
  if (repo.kind === "local" || !viewer) return null
  return <Link to={draftsRoute(repo)} className={`mt-4 inline-flex items-center gap-1 text-sm ${linkClass}`}><NotebookPen size={14} aria-hidden />Your drafts</Link>
}

function DraftRow({ repo, draft }: { repo: RepoLocator; draft: DraftSummary }) {
  return (
    <li className="px-4 py-3">
      <Link to={draftRoute(repo, draft.id)} className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">{draft.title}</Link>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>Started <Instant value={draft.created_at} /></span>
        <span>Into <span className="font-mono">{draft.target.name}</span></span>
        <span>{draft.revision === null ? "Nothing pushed yet" : `${draft.revision.commit_count ?? "?"} ${draft.revision.commit_count === 1 ? "commit" : "commits"} pushed`}</span>
        {draft.labels.length > 0 && <span>{draft.labels.join(" ")}</span>}
      </div>
    </li>
  )
}

function DraftListView({ repo, unavailable }: { repo: RepoLocator; unavailable: string | null }) {
  const { viewerKey } = useSession()
  const location = useLocation()
  const { cursor } = useListParams()
  const key = repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
  const drafts = useResource(`drafts ${key} ${cursor} ${viewerKey}`, (signal) => listDrafts(repo, { cursor }, { signal }), location.key)
  const back = <Link to={threadsRoute(repo, "patches", patchStatuses, "open")} className={`inline-flex items-center gap-1 text-sm ${linkClass}`}><ArrowLeft size={14} aria-hidden />Patches</Link>
  const heading = <><div className="mt-6">{back}</div><h2 className="mt-3 text-2xl font-semibold tracking-tight">Your drafts</h2></>
  switch (drafts.kind) {
    case "failed":
      if (drafts.error.code === "not_found" && unavailable) return <SectionUnavailable>{unavailable}</SectionUnavailable>
      if (drafts.error.code === "unauthenticated") return <>{heading}<p className="mt-3 text-muted-foreground"><Link to={loginPath(location.pathname + location.search)} className={linkClass}>Log in</Link> to see your drafts.</p></>
      if (drafts.error.code === "validation" && cursor) return <>{heading}<EmptyState title="This page is no longer available"><Link to={draftsRoute(repo)} className={linkClass}>Back to the first page</Link></EmptyState></>
      return <>{heading}<FailureState title="Couldn't load your drafts" error={drafts.error} onRetry={drafts.reload} /></>
    case "loaded": {
      const { create } = drafts.data.actions
      return (
        <>
          {heading}
          <p className="mt-2 text-sm text-muted-foreground">Patches you started with a new fork. Only you see them until you publish them.</p>
          {create.available
            ? <Button asChild size="sm" className="mt-4"><Link to={newDraftRoute(repo)}><GitFork />Start with a new fork</Link></Button>
            : <p className="mt-4 text-sm text-muted-foreground">{create.reason.message}</p>}
          {drafts.data.items.length === 0 ? <EmptyState title={cursor ? "No more drafts" : "No drafts"} /> : (
            <>
              <ul aria-label="Your drafts" className="mt-4 divide-y rounded-xl border bg-card">
                {drafts.data.items.map((draft) => <DraftRow key={draft.id} repo={repo} draft={draft} />)}
              </ul>
              <Pager page={drafts.data.page} search="" cursor={cursor} noun="Drafts" base={draftsRoute(repo)} />
            </>
          )}
        </>
      )
    }
  }
}
