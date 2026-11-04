import { Link } from "react-router"
import { MessageSquare, TriangleAlert } from "lucide-react"
import { EmptyState, FailureState, LoadingState, Pager } from "@/components/listing"
import type { Count } from "@/lib/api"
import type { RepoLocator } from "@/lib/repo"
import { useResource } from "@/lib/resource"
import { listThreadLabels, listThreads, threadLabelsRoute, threadRoute, threadsRoute, type ThreadSummary } from "@/lib/threads"
import { countText, linkClass, type ThreadConfig } from "./config"
import { AssigneeLinks, AuthorName, FilterSummary, Instant, LabelLinks, SectionUnavailable, ThreadSearchForm, ThreadTabs } from "./ThreadParts"

function repoKey(repo: RepoLocator): string {
  return repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
}

function ThreadRow<Status extends string>({ repo, config, thread }: { repo: RepoLocator; config: ThreadConfig<Status>; thread: ThreadSummary<Status> }) {
  // a row's labels and assignees lead to the list of its own status
  const listOf = (search: string) => threadsRoute(repo, config.kind, config.statuses, thread.status, { search })
  return (
    <li className="px-4 py-3">
      <Link to={threadRoute(repo, config.kind, thread.id)} className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">{thread.title}</Link>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>Opened <Instant value={thread.created_at} /> by <AuthorName author={thread.author} /></span>
        {thread.comment_count > 0 && <span className="inline-flex items-center gap-1"><MessageSquare size={12} aria-hidden />{thread.comment_count} {thread.comment_count === 1 ? "comment" : "comments"}</span>}
        {thread.conflicted && <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400"><TriangleAlert size={12} aria-hidden />Conflict</span>}
        {thread.assignees.length > 0 && <span className="flex flex-wrap items-center gap-1">Assigned to <AssigneeLinks assignees={thread.assignees} to={listOf} /></span>}
        {thread.labels.length > 0 && <span className="flex flex-wrap gap-1"><LabelLinks labels={thread.labels} to={listOf} /></span>}
      </div>
    </li>
  )
}

/** One status's list of threads: tabs with counts, Haxy's search, the window and its pager. */
export function ThreadListView<Status extends string>({ repo, config, status, search, cursor, unavailable }: { repo: RepoLocator; config: ThreadConfig<Status>; status: Status; search: string; cursor: string; unavailable: string | null }) {
  const threads = useResource(`${config.kind} ${repoKey(repo)} ${status} ${search} ${cursor}`, (signal) => listThreads(repo, config.kind, { status, search, cursor }, { signal }))
  if (threads.kind === "failed" && threads.error.code === "not_found" && unavailable) return <SectionUnavailable>{unavailable}</SectionUnavailable>
  const statusLabel = config.statusLabels[status]
  const listName = `${statusLabel} ${config.plural.toLowerCase()}`
  const firstPage = threadsRoute(repo, config.kind, config.statuses, status, { search })
  return (
    <>
      <ThreadTabs repo={repo} config={config} current={status} search={search} counts={threads.kind === "loaded" ? threads.data.counts : undefined} />
      <ThreadSearchForm key={search} label={`Search ${config.plural.toLowerCase()}`} search={search} target={(term) => threadsRoute(repo, config.kind, config.statuses, status, { search: term })} />
      {threads.kind === "loading" && <LoadingState>Loading {config.plural.toLowerCase()}…</LoadingState>}
      {threads.kind === "failed" && (
        threads.error.code === "validation" && cursor ? (
          // a page link outlived its list (the thread it started at changed)
          <EmptyState title="This page is no longer available"><Link to={firstPage} className={linkClass}>Back to the first page</Link></EmptyState>
        ) : (
          <FailureState title={`Couldn't load ${config.plural.toLowerCase()}`} error={threads.error} onRetry={threads.reload} />
        )
      )}
      {threads.kind === "loaded" && (
        <>
          <FilterSummary filters={threads.data.filters} noun={listName} />
          {threads.data.items.length === 0 ? (
            cursor ? <EmptyState title={`No more ${listName}`}><Link to={firstPage} className={linkClass}>Back to the first page</Link></EmptyState>
              : <EmptyState title={search ? `No ${listName} match this search` : `No ${listName}`} />
          ) : (
            <>
              <ul aria-label={listName} className="mt-4 divide-y rounded-xl border bg-card">
                {threads.data.items.map((thread) => <ThreadRow key={thread.id} repo={repo} config={config} thread={thread} />)}
              </ul>
              <Pager page={threads.data.page} search={search} cursor={cursor} noun={config.plural} base={threadsRoute(repo, config.kind, config.statuses, status)} />
            </>
          )}
        </>
      )}
    </>
  )
}

/** How many labels there are; a listing Haxy stopped counting says it is incomplete. */
function LabelCount({ count }: { count: Count }) {
  if (count.kind === "unknown") return null
  const text = countText({ kind: "exact", value: count.value })
  return (
    <p role="status" aria-label="Label count" className="mt-3 text-sm text-muted-foreground">
      {count.kind === "exact" ? `${text} ${count.value === 1 ? "label" : "labels"}.` : `At least ${text} labels. Haxy lists no more than these, so some labels aren't shown.`}
    </p>
  )
}

/** Every label the repository's threads use, each leading to the first status's list filtered by it. */
export function ThreadLabelsView<Status extends string>({ repo, config, search, cursor, unavailable }: { repo: RepoLocator; config: ThreadConfig<Status>; search: string; cursor: string; unavailable: string | null }) {
  const labels = useResource(`${config.kind} labels ${repoKey(repo)} ${search} ${cursor}`, (signal) => listThreadLabels(repo, config.kind, { search, cursor }, { signal }))
  if (labels.kind === "failed" && labels.error.code === "not_found" && unavailable) return <SectionUnavailable>{unavailable}</SectionUnavailable>
  return (
    <>
      <ThreadTabs repo={repo} config={config} current="labels" search={search} />
      <ThreadSearchForm key={search} label={`Search ${config.plural.toLowerCase()}`} search={search} target={(term) => threadLabelsRoute(repo, config.kind, { search: term })} />
      {labels.kind === "loading" && <LoadingState>Loading labels…</LoadingState>}
      {labels.kind === "failed" && <FailureState title="Couldn't load labels" error={labels.error} onRetry={labels.reload} />}
      {labels.kind === "loaded" && (
        labels.data.items.length === 0 ? (
          <EmptyState title="No labels">{`No ${config.noun.toLowerCase()} has a label yet.`}</EmptyState>
        ) : (
          <>
            <LabelCount count={labels.data.page.count} />
            <ul aria-label="Labels" className="mt-4 flex flex-wrap gap-2">
              {labels.data.items.map((label) => (
                <li key={label.name}>
                  <Link to={threadsRoute(repo, config.kind, config.statuses, config.statuses[0], { search: label.search })} className="inline-flex rounded-full border px-3 py-1 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">{label.name}</Link>
                </li>
              ))}
            </ul>
            <Pager page={labels.data.page} search={search} cursor={cursor} noun="Labels" base={threadLabelsRoute(repo, config.kind)} />
          </>
        )
      )}
    </>
  )
}
