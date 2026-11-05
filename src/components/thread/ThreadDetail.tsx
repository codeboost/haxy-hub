import { useState, type ReactNode } from "react"
import { Link } from "react-router"
import { ArrowLeft, MessageSquare, TriangleAlert } from "lucide-react"
import { FailureState, LoadingState } from "@/components/listing"
import { Markdown } from "@/components/Markdown"
import { linkTarget } from "@/lib/markdown"
import type { RepoLocator } from "@/lib/repo"
import { useSession } from "@/app/session"
import { useResource } from "@/lib/resource"
import { getThread, threadsRoute, type ThreadDetail, type WriteViewer } from "@/lib/threads"
import { linkClass, type ThreadConfig } from "./config"
import { ThreadActions } from "./ThreadActions"
import { AssigneeLinks, AuthorName, Instant, LabelLinks, SectionUnavailable } from "./ThreadParts"

function Field({ title, children }: { title: string; children: ReactNode }) {
  const id = `thread-${title.toLowerCase()}`
  return (
    <section aria-labelledby={id} className="mt-6">
      <h3 id={id} className="mb-2 text-sm font-semibold">{title}</h3>
      {children}
    </section>
  )
}

function Body<Status extends string>({ repo, config, loaded, viewer }: { repo: RepoLocator; config: ThreadConfig<Status>; loaded: ThreadDetail<Status>; viewer: WriteViewer }) {
  // what a change on this page answered with, until the page loads again
  const [changed, setChanged] = useState<{ from: ThreadDetail<Status>; thread: ThreadDetail<Status> } | null>(null)
  const thread = changed?.from === loaded ? changed.thread : loaded
  const listOf = (search: string) => threadsRoute(repo, config.kind, config.statuses, thread.status, { search })
  return (
    <article className="mt-6">
      <Link to={threadsRoute(repo, config.kind, config.statuses, thread.status)} className={`inline-flex items-center gap-1 text-sm ${linkClass}`}>
        <ArrowLeft size={14} aria-hidden />{config.statusLabels[thread.status]} {config.plural.toLowerCase()}
      </Link>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight">{thread.title}</h2>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <span className="rounded-full border px-2 py-0.5 text-xs font-medium text-foreground">{config.statusLabels[thread.status]}</span>
        <span>Opened <Instant value={thread.created_at} /> by <AuthorName author={thread.author} /></span>
        <span className="inline-flex items-center gap-1"><MessageSquare size={14} aria-hidden />{thread.comment_count} {thread.comment_count === 1 ? "comment" : "comments"}</span>
      </div>
      <ThreadActions repo={repo} config={config} thread={thread} viewer={viewer} onChanged={(updated) => setChanged({ from: loaded, thread: updated })} />
      {thread.conflicted && (
        <p className="mt-4 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-2 text-sm">
          <TriangleAlert size={16} aria-hidden />Concurrent edits to this {config.noun.toLowerCase()} conflict; the values shown are this server's.
        </p>
      )}
      {thread.labels.length > 0 && <Field title="Labels"><div className="flex flex-wrap gap-1"><LabelLinks labels={thread.labels} to={listOf} /></div></Field>}
      {thread.assignees.length > 0 && <Field title="Assignees"><div className="flex flex-wrap gap-1"><AssigneeLinks assignees={thread.assignees} to={listOf} /></div></Field>}
      <Field title="Description">
        <div className="rounded-xl border bg-card p-4 sm:p-6">
          {thread.description.length === 0 ? <p className="text-muted-foreground">No description.</p> : <Markdown blocks={thread.description} resolveLink={(destination) => linkTarget(destination, repo.kind === "local")} />}
        </div>
      </Field>
    </article>
  )
}

/** One thread's own page: its fields and whole description, independent of any list. */
export function ThreadDetailView<Status extends string>({ repo, config, id, unavailable }: { repo: RepoLocator; config: ThreadConfig<Status>; id: string; unavailable: string | null }) {
  const { viewer, viewerKey } = useSession()
  const key = repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
  // what the viewer may do is part of the answer, so another viewer reads it again
  const thread = useResource(`${config.kind} ${key} ${id} ${viewerKey}`, (signal) => getThread<Status>(repo, config.kind, id, { signal }))
  switch (thread.kind) {
    case "loading":
      return <LoadingState>Loading the {config.noun.toLowerCase()}…</LoadingState>
    case "failed":
      if (thread.error.code === "not_found") {
        if (unavailable) return <SectionUnavailable>{unavailable}</SectionUnavailable>
        return (
          <section className="mt-6">
            <h2 className="text-2xl font-semibold tracking-tight">{config.noun} not found</h2>
            <p className="mt-2 text-muted-foreground">There is no {config.noun.toLowerCase()} with this id in this repository. It may have been removed.</p>
            <Link to={threadsRoute(repo, config.kind, config.statuses, config.statuses[0])} className={`mt-4 inline-block text-sm ${linkClass}`}>All {config.statusLabels[config.statuses[0]].toLowerCase()} {config.plural.toLowerCase()}</Link>
          </section>
        )
      }
      return <FailureState title={`Couldn't load this ${config.noun.toLowerCase()}`} error={thread.error} onRetry={thread.reload} />
    case "loaded":
      return <Body repo={repo} config={config} loaded={thread.data} viewer={viewer?.name ?? null} />
  }
}
