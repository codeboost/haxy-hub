import { useState, type ReactNode } from "react"
import { Link, useLocation } from "react-router"
import { FailureState } from "@/components/listing"
import { Markdown } from "@/components/Markdown"
import { linkTarget } from "@/lib/markdown"
import type { RepoLocator } from "@/lib/repo"
import { useSession } from "@/app/session"
import { useResource } from "@/lib/resource"
import { getThread, threadsRoute, type FilterLink, type ThreadDetail, type WriteViewer } from "@/lib/threads"
import { linkClass, type ThreadConfig } from "./config"
import { ThreadActions } from "./ThreadActions"
import { LabelLinks, SectionUnavailable } from "./ThreadParts"
import { OpeningPost, ThreadHeader } from "./ThreadHeader"
import { ThreadPanel } from "./ThreadPanel"
import { RefreshFailed, ThreadComments, useKept } from "./ThreadComments"
import { ThreadAssignees } from "@/components/assignees/ThreadAssignees"
import { ThreadAttachments } from "@/components/attachments/ThreadAttachments"
import { readsThen, useAnswerClock, useThreadAnswers, type AnswerClock } from "@/components/assignees/useThreadAnswers"
import { ThreadNotifications, useCommentsShown } from "@/components/notifications/ThreadNotifications"
import { withNotification, type NotificationRead } from "@/lib/notifications"
import type { ConflictKind } from "@/lib/conflicts"
import { ConflictBanner } from "@/pages/conflicts/ConflictBanner"

function Description({ repo, blocks }: { repo: RepoLocator; blocks: ThreadDetail<string>["description"] }) {
  if (blocks.length === 0) return <p className="text-muted-foreground">No description.</p>
  return <Markdown blocks={blocks} resolveLink={(destination) => linkTarget(destination, repo.kind === "local")} />
}

function Labels({ labels, to }: { labels: FilterLink[]; to(search: string): string }) {
  return (
    <ThreadPanel id="thread-labels" title="Labels" frame="sidebar">
      {labels.length === 0 ? <p className="text-sm text-muted-foreground">None yet</p> : <div className="flex flex-wrap gap-1"><LabelLinks labels={labels} to={to} /></div>}
    </ThreadPanel>
  )
}

/** The page's two columns: the thread's posts, and its details beside them (below them on a small screen). */
function Columns({ main, details }: { main: ReactNode; details: ReactNode }) {
  return (
    <div className="mt-6 grid gap-8 md:grid-cols-[minmax(0,1fr)_15rem]">
      <div className="min-w-0">{main}</div>
      <aside aria-label="Details" className="divide-y self-start text-sm md:sticky md:top-6">{details}</aside>
    </div>
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
  const main = (
    <>
      <OpeningPost config={config} thread={thread}><Description repo={repo} blocks={thread.description} /></OpeningPost>
      <div className="sm:pl-11"><ThreadComments repo={repo} config={config} thread={thread.id} title="Conversation" {...shown.commentReads} /></div>
    </>
  )
  const details = (
    <>
      <Labels labels={thread.labels} to={listOf} />
      <ThreadAssignees repo={repo} config={config} thread={thread} viewer={viewer} frame="sidebar" onChanged={(value) => { onAssigneesChanged(value); setAssigneeChanges((count) => count + 1) }}
        reads={reads((value: ThreadDetail<Status>, startedAt) => { answers.onAssigneesRead(value, startedAt); setAssigneeChanges((count) => count + 1) })} />
      <ThreadAttachments repo={repo} config={config} thread={thread} viewer={viewer} frame="sidebar" onChanged={onAttachmentsChanged} reads={reads(answers.onAttachmentsRead)} />
      <ThreadNotifications repo={repo} config={config} thread={thread.id} viewer={viewer} read={notification} readStartedAt={readStartedAt} clock={clock} onRetry={reload} refresh={assigneeChanges}
        comments={shown.comments} frame="sidebar" />
    </>
  )
  return (
    <article className="mt-6">
      <ThreadHeader config={config} thread={thread} back={threadsRoute(repo, config.kind, config.statuses, thread.status)}
        actions={<ThreadActions repo={repo} config={config} thread={thread} viewer={viewer} onChanged={onChanged} reads={reads(answers.onRead)} className="max-w-md" />} />
      {thread.conflicted && <ConflictBanner repo={repo} kind={config.kind as ConflictKind} id={thread.id} noun={config.noun.toLowerCase()} />}
      <Columns main={main} details={details} />
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
