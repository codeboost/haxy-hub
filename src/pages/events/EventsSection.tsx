import { Link } from "react-router"
import { EmptyState, FailureState, LoadingState, Pager, useListParams } from "@/components/listing"
import { countText, linkClass } from "@/components/thread/config"
import { AuthorName, Instant, SectionUnavailable } from "@/components/thread/ThreadParts"
import type { Count } from "@/lib/api"
import { eventsPage, eventsRoute, eventTargetRoute, eventViews, listEvents, type EventKind, type EventTarget, type EventView, type RepoEvent, type TransactionId } from "@/lib/events"
import type { RepoLocator } from "@/lib/repo"
import { useResource } from "@/lib/resource"

const kindLabels: Record<EventKind, string> = {
  user: "User",
  repo: "Repository",
  fork: "Fork",
  grant: "Grant",
  notify: "Notification",
  discuss: "Discussion",
  issue: "Issue",
  comment: "Comment",
  attach: "Attachment",
  assign: "Assignment",
  patchrev: "Patch revision",
  patch: "Patch",
}

const viewLabels: Record<EventView, string> = { active: "Active", removed: "Removed" }

// thread kinds by their plural, for "no Hub page" notes
const threadPlurals = { discuss: "discussions", issue: "issues", patch: "patches" } as const

function repoKey(repo: RepoLocator): string {
  return repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
}

/** An event's detail link: the Hub page of its thread or comment, or a note where Hub has none yet. */
function TargetLink({ repo, target }: { repo: RepoLocator; target: EventTarget }) {
  const route = eventTargetRoute(repo, target)
  if (route === null) return <span>No Haxy Hub page for {threadPlurals[target.thread_kind]} yet</span>
  return <Link to={route} className={linkClass}>{target.kind === "comment" ? "View comment" : "View issue"}</Link>
}

function EventRow({ repo, event }: { repo: RepoLocator; event: RepoEvent }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
      <span className="font-medium">{kindLabels[event.kind]}</span>
      <span className="text-muted-foreground">by <AuthorName author={event.author} /></span>
      {event.created_at && <span className="text-muted-foreground"><Instant value={event.created_at} /></span>}
      <span className="ml-auto text-xs text-muted-foreground">{event.target && <TargetLink repo={repo} target={event.target} />}</span>
    </li>
  )
}

function EventTabs({ repo, current, transaction, counts }: { repo: RepoLocator; current: EventView; transaction?: TransactionId; counts?: Record<EventView, Count> }) {
  const tab = (active: boolean) => `-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm ${active ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`
  return (
    <nav aria-label="Event lists" className="mt-6 flex flex-wrap gap-1 border-b">
      {eventViews.map((view) => {
        const count = countText(counts?.[view])
        return (
          <Link key={view} to={eventsRoute(repo, view, { transaction })} aria-current={current === view ? "page" : undefined} className={tab(current === view)}>
            {viewLabels[view]}
            {count && <span className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">{count}</span>}
          </Link>
        )
      })}
    </nav>
  )
}

/** One view's window of a repository's events, or of one transaction's. */
function EventListView({ repo, view, transaction, cursor }: { repo: RepoLocator; view: EventView; transaction?: TransactionId; cursor: string }) {
  const events = useResource(`events ${repoKey(repo)} ${transaction ?? ""} ${view} ${cursor}`, (signal) => listEvents(repo, { view, transaction, cursor }, { signal }))
  // not found: the viewer may not see events, or the transaction can't be shown; Haxy says which
  if (events.kind === "failed" && events.error.code === "not_found") return <SectionUnavailable>{events.error.message}</SectionUnavailable>
  const listName = `${viewLabels[view]} events`
  const firstPage = eventsRoute(repo, view, { transaction })
  return (
    <>
      {transaction !== undefined && (
        <div className="mt-6 flex flex-wrap items-baseline gap-x-4">
          <h2 className="text-2xl font-semibold tracking-tight">Transaction {transaction}</h2>
          <Link to={eventsRoute(repo, "active")} className={`text-sm ${linkClass}`}>All events</Link>
        </div>
      )}
      <EventTabs repo={repo} current={view} transaction={transaction} counts={events.kind === "loaded" ? events.data.counts : undefined} />
      {events.kind === "loading" && <LoadingState>Loading events…</LoadingState>}
      {events.kind === "failed" && (
        events.error.code === "validation" && cursor ? (
          // a page link outlived its list (the event it started at changed)
          <EmptyState title="This page is no longer available"><Link to={firstPage} className={linkClass}>Back to the first page</Link></EmptyState>
        ) : (
          <FailureState title="Couldn't load events" error={events.error} onRetry={events.reload} />
        )
      )}
      {events.kind === "loaded" && (
        events.data.items.length === 0 ? (
          cursor ? <EmptyState title={`No more ${listName.toLowerCase()}`}><Link to={firstPage} className={linkClass}>Back to the first page</Link></EmptyState>
            : <EmptyState title={`No ${listName.toLowerCase()}`} />
        ) : (
          <>
            <ul aria-label={listName} className="mt-4 divide-y rounded-xl border bg-card">
              {events.data.items.map((event) => <EventRow key={event.id} repo={repo} event={event} />)}
            </ul>
            <Pager page={events.data.page} search="" cursor={cursor} noun="Events" base={firstPage} />
          </>
        )
      )}
    </>
  )
}

/**
 * A repository's events: `<repo>/events[/removed]`, or one transaction's,
 * `<repo>/events/transactions/<id>[/removed]`, each with `?cursor=`. The
 * events are always requested, since the viewer's role may have changed
 * since the repository's sections were read; Haxy answers not found (with
 * its reason) to viewers who may not see them.
 */
export function EventsSection({ repo, tail }: { repo: RepoLocator; tail: string }) {
  const { cursor } = useListParams()
  const page = eventsPage(tail)
  if (page.kind === "unknown") {
    return (
      <section className="mt-6">
        <h2 className="text-2xl font-semibold tracking-tight">Page not found</h2>
        <Link to={eventsRoute(repo, "active")} className={`mt-4 inline-block text-sm ${linkClass}`}>All events</Link>
      </section>
    )
  }
  return <EventListView key={`${page.transaction ?? ""} ${page.view}`} repo={repo} view={page.view} transaction={page.transaction} cursor={cursor} />
}
