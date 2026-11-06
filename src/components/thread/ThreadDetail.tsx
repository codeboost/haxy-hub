import { useState, type ReactNode } from "react"
import { Link, useLocation } from "react-router"
import { ArrowLeft, MessageSquare } from "lucide-react"
import { FailureState } from "@/components/listing"
import { Markdown } from "@/components/Markdown"
import { linkTarget } from "@/lib/markdown"
import type { RepoLocator } from "@/lib/repo"
import { useSession } from "@/app/session"
import { useResource } from "@/lib/resource"
import { getThread, threadsRoute, type ThreadDetail, type WriteViewer } from "@/lib/threads"
import { linkClass, type ThreadConfig } from "./config"
import { ThreadActions } from "./ThreadActions"
import { AuthorName, Instant, LabelLinks, SectionUnavailable } from "./ThreadParts"
import { RefreshFailed, ThreadComments, useKept } from "./ThreadComments"
import { ThreadAssignees } from "@/components/assignees/ThreadAssignees"
import { ThreadAttachments } from "@/components/attachments/ThreadAttachments"
import { readsThen, useAnswerClock, useThreadAnswers, type AnswerClock } from "@/components/assignees/useThreadAnswers"
import { ThreadNotifications, useCommentsShown } from "@/components/notifications/ThreadNotifications"
import { withNotification, type NotificationRead } from "@/lib/notifications"
import type { ConflictKind } from "@/lib/conflicts"
import { ConflictBanner } from "@/pages/conflicts/ConflictBanner"

function Field({ title, children }: { title: string; children: ReactNode }) {
  const id = `thread-${title.toLowerCase()}`
  return (
    <section aria-labelledby={id} className="mt-6">
      <h3 id={id} className="mb-2 text-sm font-semibold">{title}</h3>
      {children}
    </section>
  )
}

function Body<Status extends string>({ repo, config, loaded, readStartedAt, clock, viewer, revalidate, notification, stateAt, reload }: { repo: RepoLocator; config: ThreadConfig<Status>; loaded: ThreadDetail<Status>; readStartedAt: number; clock: AnswerClock; viewer: WriteViewer; revalidate(): void; notification: NotificationRead; stateAt: number; reload(): void }) {
  // what the changes on this page answered with, over reads that started before them
  const answers = useThreadAnswers(loaded, readStartedAt, clock)
  const { thread } = answers
  // each answer also reads the thread again in the background: an answer
  // sets only what its change owns, so what another client changed meanwhile
  // shows once that read (which started after the answer) lands
  const onChanged = (value: ThreadDetail<Status>) => { answers.onChanged(value); revalidate() }
  const onAssigneesChanged = (value: ThreadDetail<Status>) => { answers.onAssigneesChanged(value); revalidate() }
  const onAttachmentsChanged = (value: ThreadDetail<Status>) => { answers.onAttachmentsChanged(value); revalidate() }
  // a read that settles an unknown outcome is ordered by when it started, then read again in the background too
  const reads = <T,>(apply: (value: T, startedAt: number) => void) => readsThen(clock, apply, revalidate)
  // assigning someone may notify them (yourself, say): the panel reads its state again after each assignee change
  const [assigneeChanges, setAssigneeChanges] = useState(0)
  // the comments the page has shown, so it acknowledges only after showing them
  const shown = useCommentsShown(stateAt)
  const listOf = (search: string) => threadsRoute(repo, config.kind, config.statuses, thread.status, { search })
  return (
    <article className="mt-6">
      <Link to={threadsRoute(repo, config.kind, config.statuses, thread.status)} className={`inline-flex items-center gap-1 text-sm ${linkClass}`}>
        <ArrowLeft size={14} aria-hidden />{config.statusLabels[thread.status]} {config.plural.toLowerCase()}
      </Link>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight">{thread.title}</h2>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        {/* a kind with one list (discussions) has no status to show */}
        {config.statuses.length > 1 && <span className="rounded-full border px-2 py-0.5 text-xs font-medium text-foreground">{config.statusLabels[thread.status]}</span>}
        <span>Opened <Instant value={thread.created_at} /> by <AuthorName author={thread.author} /></span>
        <span className="inline-flex items-center gap-1"><MessageSquare size={14} aria-hidden />{thread.comment_count} {thread.comment_count === 1 ? "comment" : "comments"}</span>
      </div>
      <ThreadActions repo={repo} config={config} thread={thread} viewer={viewer} onChanged={onChanged} reads={reads(answers.onRead)} />
      {thread.conflicted && <ConflictBanner repo={repo} kind={config.kind as ConflictKind} id={thread.id} noun={config.noun.toLowerCase()} />}
      {thread.labels.length > 0 && <Field title="Labels"><div className="flex flex-wrap gap-1"><LabelLinks labels={thread.labels} to={listOf} /></div></Field>}
      <ThreadAssignees repo={repo} config={config} thread={thread} viewer={viewer} onChanged={(value) => { onAssigneesChanged(value); setAssigneeChanges((count) => count + 1) }}
        reads={reads((value: ThreadDetail<Status>, startedAt) => { answers.onAssigneesRead(value, startedAt); setAssigneeChanges((count) => count + 1) })} />
      <ThreadNotifications repo={repo} config={config} thread={thread.id} viewer={viewer} read={notification} readStartedAt={readStartedAt} clock={clock} onRetry={reload} refresh={assigneeChanges}
        comments={shown.comments} />
      <Field title="Description">
        <div className="rounded-xl border bg-card p-4 sm:p-6">
          {thread.description.length === 0 ? <p className="text-muted-foreground">No description.</p> : <Markdown blocks={thread.description} resolveLink={(destination) => linkTarget(destination, repo.kind === "local")} />}
        </div>
      </Field>
      <ThreadAttachments repo={repo} config={config} thread={thread} viewer={viewer} onChanged={onAttachmentsChanged} reads={reads(answers.onAttachmentsRead)} />
      <ThreadComments repo={repo} config={config} thread={thread.id} {...shown.commentReads} />
    </article>
  )
}

/** One thread's own page: its fields and whole description, independent of any list. */
export function ThreadDetailView<Status extends string>({ repo, config, id, unavailable }: { repo: RepoLocator; config: ThreadConfig<Status>; id: string; unavailable: string | null }) {
  const { viewer, viewerKey } = useSession()
  const location = useLocation()
  const key = repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
  // what the viewer may do is part of the answer, so another viewer reads it
  // again; a navigation within the page (a comment posted, another comment
  // page) reads it again in the background, so its counts stay current
  const clock = useAnswerClock()
  // bumped after each answer to a change on the page, to read the thread again
  const [revalidations, setRevalidations] = useState(0)
  const resourceKey = `${config.kind} ${key} ${id} ${viewerKey}`
  const read = useResource(resourceKey, (signal) => {
    // when this read started, against the answers to this page's own changes
    const startedAt = clock.now
    // with the viewer's notification state, so the page shows (and acknowledges) the two together
    return withNotification(repo, config.kind, id, viewer?.name ?? null, signal, () => getThread<Status>(repo, config.kind, id, { signal }))
      .then(({ data, notification, stateAt }) => ({ data, notification, stateAt, startedAt }))
  }, `${location.key} ${revalidations}`)
  // once loaded, a background read that fails keeps the page (and every draft
  // in it) and says so; only the first load may replace it with a failure
  const thread = useKept(read, resourceKey)
  switch (thread.kind) {
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
      return <FailureState title={`Couldn't load this ${config.noun.toLowerCase()}`} error={thread.error} onRetry={read.reload} />
    case "loaded":
      return (
        <>
          {thread.refreshFailed && <div className="mt-6"><RefreshFailed title={`Couldn't refresh this ${config.noun.toLowerCase()}`} error={thread.refreshFailed} onRetry={read.reload} /></div>}
          <Body repo={repo} config={config} loaded={thread.data.data} readStartedAt={thread.data.startedAt} clock={clock} viewer={viewer?.name ?? null} revalidate={() => setRevalidations((value) => value + 1)} notification={thread.data.notification} stateAt={thread.data.stateAt} reload={read.reload} />
        </>
      )
  }
}
