import { useState, type ReactNode } from "react"
import { Link, useLocation } from "react-router"
import { ArrowLeft, FileCode2, GitCommitHorizontal, GitCompareArrows, MessageSquare, TriangleAlert } from "lucide-react"
import { FailureState, LoadingState } from "@/components/listing"
import { Markdown } from "@/components/Markdown"
import { linkClass } from "@/components/thread/config"
import { RefreshFailed, ThreadComments, useKept } from "@/components/thread/ThreadComments"
import { AuthorName, Instant, LabelLinks, SectionUnavailable } from "@/components/thread/ThreadParts"
import { ThreadAttachments } from "@/components/attachments/ThreadAttachments"
import { readsThen, useAnswerClock, useAttachmentAnswers, useChangeAnswers, type AnswerClock, type ThreadReads } from "@/components/assignees/useThreadAnswers"
import { ThreadActions } from "@/components/thread/ThreadActions"
import { useWriteGates } from "@/components/thread/writeGate"
import { PatchMerge } from "@/components/patches/PatchMerge"
import { asPatchThread, patchOf } from "@/lib/patchThread"
import { ThreadNotifications, useCommentsShown } from "@/components/notifications/ThreadNotifications"
import { useSession } from "@/app/session"
import { commitRoute } from "@/lib/commits"
import { linkTarget } from "@/lib/markdown"
import { withNotification, type NotificationRead } from "@/lib/notifications"
import { getPatch, revisionCommitsRoute, revisionDiffRoute, revisionFilesRoute, revisionRef, type MergeResult, type PatchDetail, type PatchStatus } from "@/lib/patches"
import { repoRoute, type RepoLocator } from "@/lib/repo"
import { useResource } from "@/lib/resource"
import { threadsRoute, type ThreadDetail, type WriteViewer } from "@/lib/threads"
import type { Attached } from "@/lib/attachments"
import { patchThreads } from "./config"

const config = patchThreads

const writers = ["status", "merge"] as const

/**
 * `<repo>/patches/<id>`: one patch, as the TUI's patch detail shows it —
 * where its commits come from and go to, the revision it proposes with its
 * commit count, whether it changes anything, whether Haxy would merge it —
 * with links to review that revision's files, commits and diff, then the
 * viewer's notifications, its description, attachments and comments, and
 * the actions the viewer may take on it, as a thread page shows them
 * (`ThreadDetailView`). Every navigation reads it
 * again, so a revision pushed from another client shows; a refresh that fails
 * keeps the page.
 */
export function PatchDetailView({ repo, id, unavailable }: { repo: RepoLocator; id: string; unavailable: string | null }) {
  const { viewer, viewerKey } = useSession()
  const location = useLocation()
  const key = repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
  // orders the background reads against the answers to attachment changes
  const clock = useAnswerClock()
  // bumped after each answer to a change on the page, to read the patch again
  const [revalidations, setRevalidations] = useState(0)
  const resourceKey = `patch ${key} ${id} ${viewerKey}`
  const read = useResource(resourceKey, (signal) => {
    const startedAt = clock.now
    // with the viewer's notification state, read first, so the page shows (and acknowledges) the two together
    return withNotification(repo, config.kind, id, viewer?.name ?? null, signal, () => getPatch(repo, id, { signal }))
      .then(({ data, notification, stateAt }) => ({ data, notification, stateAt, startedAt }))
  }, `${location.key} ${revalidations}`)
  const patch = useKept(read, resourceKey)
  switch (patch.kind) {
    case "loading":
      return <LoadingState>Loading the patch…</LoadingState>
    case "failed":
      if (patch.error.code === "not_found") {
        if (unavailable) return <SectionUnavailable>{unavailable}</SectionUnavailable>
        return (
          <section className="mt-6">
            <h2 className="text-2xl font-semibold tracking-tight">Patch not found</h2>
            <p className="mt-2 text-muted-foreground">There is no patch with this id in this repository. It may have been removed.</p>
            <Link to={threadsRoute(repo, "patches", config.statuses, "open")} className={`mt-4 inline-block text-sm ${linkClass}`}>All open patches</Link>
          </section>
        )
      }
      return <FailureState title="Couldn't load this patch" error={patch.error} onRetry={read.reload} />
    case "loaded":
      return (
        <>
          {patch.refreshFailed && <div className="mt-6"><RefreshFailed title="Couldn't refresh this patch" error={patch.refreshFailed} onRetry={read.reload} /></div>}
          <Body repo={repo} loaded={patch.data.data} readStartedAt={patch.data.startedAt} clock={clock} viewer={viewer?.name ?? null}
            revalidate={() => setRevalidations((value) => value + 1)} notification={patch.data.notification} stateAt={patch.data.stateAt} reload={read.reload} />
        </>
      )
  }
}

function Body({ repo, loaded, readStartedAt, clock, viewer, revalidate, notification, stateAt, reload }: { repo: RepoLocator; loaded: PatchDetail; readStartedAt: number; clock: AnswerClock; viewer: WriteViewer; revalidate(): void; notification: NotificationRead; stateAt: number; reload(): void }) {
  const answered = usePatchAnswers(loaded, readStartedAt, clock, revalidate)
  const { patch } = answered
  // a status change and a merge never cross: each holds while the other is in flight
  const gates = useWriteGates(writers)
  // the comments the page has shown, so it acknowledges only after showing them
  const shown = useCommentsShown(stateAt)
  const listOf = (search: string) => threadsRoute(repo, "patches", config.statuses, patch.status, { search })
  return (
    <article className="mt-6">
      <Link to={threadsRoute(repo, "patches", config.statuses, patch.status)} className={`inline-flex items-center gap-1 text-sm ${linkClass}`}>
        <ArrowLeft size={14} aria-hidden />{config.statusLabels[patch.status]} patches
      </Link>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight">{patch.title}</h2>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <span aria-label="Status" className="rounded-full border px-2 py-0.5 text-xs font-medium text-foreground">{config.statusLabels[patch.status]}</span>
        <span>Opened <Instant value={patch.created_at} /> by <AuthorName author={patch.author} /></span>
        <span className="inline-flex items-center gap-1"><MessageSquare size={14} aria-hidden />{patch.comment_count} {patch.comment_count === 1 ? "comment" : "comments"}</span>
      </div>
      {/* edit, close or reopen, remove: each answer also reads the patch again in the background */}
      <ThreadActions repo={repo} config={config} thread={asPatchThread(patch)} viewer={viewer} onChanged={(value) => answered.onChanged(patchOf(value))}
        reads={answered.threadReads} gate={gates.status} />
      {patch.conflicted && (
        <p className="mt-4 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-2 text-sm">
          <TriangleAlert size={16} aria-hidden />Concurrent edits to this patch conflict; the values shown are this server's.
        </p>
      )}
      {patch.labels.length > 0 && <Field title="Labels"><div className="flex flex-wrap gap-1"><LabelLinks labels={patch.labels} to={listOf} /></div></Field>}
      <Proposal repo={repo} patch={patch} />
      {/* merging answers with the patch, which reads it again in the background too */}
      <PatchMerge repo={repo} patch={patch} viewer={viewer} onChanged={answered.onChanged} reads={answered.reads} gate={gates.merge} />
      <Review repo={repo} patch={patch} />
      {/* patches have no assignees, so nothing else on the page changes whether the viewer is notified */}
      <ThreadNotifications repo={repo} config={config} thread={patch.id} viewer={viewer} read={notification} readStartedAt={readStartedAt} clock={clock} onRetry={reload} refresh={0} comments={shown.comments} />
      <Field title="Description">
        <div className="rounded-xl border bg-card p-4 sm:p-6">
          {patch.description.length === 0 ? <p className="text-muted-foreground">No description.</p> : <Markdown blocks={patch.description} resolveLink={(destination) => linkTarget(destination, repo.kind === "local")} />}
        </div>
      </Field>
      {/* each answer also reads the patch again in the background, so what another client changed shows */}
      <ThreadAttachments repo={repo} config={config} thread={patch} viewer={viewer} onChanged={answered.onAttachmentsChanged}
        reads={answered.attachmentReads} />
      <ThreadComments repo={repo} config={config} thread={patch.id} {...shown.commentReads} />
    </article>
  )
}

/**
 * The patch as the page shows it: as the latest change of it here (a status)
 * answered, and its attachments as the latest upload or removal did, over
 * reads that started before them; each kind of change owns its fields, the
 * rest come from the read (as `useThreadAnswers` composes an issue). Every
 * answer, and every read that settles an unknown outcome (ordered by when it
 * started), is followed by a background read of the patch.
 */
function usePatchAnswers(loaded: PatchDetail, readStartedAt: number, clock: AnswerClock, revalidate: () => void) {
  const changes = useChangeAnswers(loaded, readStartedAt, clock)
  const answers = useAttachmentAnswers(loaded, readStartedAt, clock)
  const attached = answers.thread
  const patch: PatchDetail = {
    ...changes.thread,
    attachments: attached.attachments,
    attachment_limits: attached.attachment_limits,
    actions: { ...changes.thread.actions, attach: attached.actions.attach },
  }
  const reads = readsThen(clock, changes.onRead, revalidate)
  const threadReads: ThreadReads<ThreadDetail<PatchStatus>> = { clock, onRead: (value, startedAt) => reads.onRead(patchOf(value), startedAt) }
  return {
    patch,
    reads,
    threadReads,
    attachmentReads: readsThen(clock, answers.onAttachmentsRead, revalidate),
    onChanged: (value: PatchDetail) => { changes.onChanged(value); revalidate() },
    onAttachmentsChanged: (value: Attached) => { answers.onAttachmentsChanged(value); revalidate() },
  }
}

function Field({ title, children }: { title: string; children: ReactNode }) {
  const id = `patch-${title.toLowerCase().replace(/\s+/g, "-")}`
  return (
    <section aria-labelledby={id} className="mt-6">
      <h3 id={id} className="mb-2 text-sm font-semibold">{title}</h3>
      {children}
    </section>
  )
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-2 sm:flex-row sm:gap-4">
      <dt className="w-40 shrink-0 text-sm text-muted-foreground">{term}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  )
}

const mergeResults: Record<MergeResult, string> = {
  clean: "merges cleanly",
  conflict: "conflicts with the target",
  unknown: "not checked against the target yet",
}

/** What the patch proposes: its source and target, its revision, and whether Haxy would merge it. */
function Proposal({ repo, patch }: { repo: RepoLocator; patch: PatchDetail }) {
  const { source, target, revision } = patch
  const revisionRefId = revision ? revisionRef(revision.id) : null
  return (
    <Field title="Proposal">
      <dl className="divide-y rounded-xl border bg-card">
        <Row term="Source">
          {source.kind === "branch" ? (
            <>Branch <Link to={repoRoute(repo, "", source.id)} className={`font-mono ${linkClass}`}>{source.name}</Link></>
          ) : source.fork ? (
            <>The fork <span className="font-mono">{source.fork.owner}/{source.fork.name}</span></>
          ) : "A fork that has been removed"}
        </Row>
        <Row term={patch.status === "merged" ? "Merged into" : "Target"}>
          Branch <Link to={repoRoute(repo, "", target.id)} className={`font-mono ${linkClass}`}>{target.name}</Link>
        </Row>
        <Row term="Revision">
          {revision === null ? "Nothing has been pushed yet." : (
            <span className="flex flex-col gap-1">
              <span>
                Source commit{" "}
                {revisionRefId && patch.review.available && patch.merged?.method !== "squash"
                  ? <Link to={commitRoute(repo, revision.source_commit, revisionRefId)} className={`font-mono ${linkClass}`}>{revision.source_commit.slice(0, 10)}</Link>
                  : <code className="font-mono">{revision.source_commit.slice(0, 10)}</code>}
                {revision.base_commit && <> based on <code className="font-mono">{revision.base_commit.slice(0, 10)}</code></>}
              </span>
              <span aria-label="Commit count">{revision.commit_count === null ? "Commit count unavailable" : `${revision.commit_count} ${revision.commit_count === 1 ? "commit" : "commits"}`}</span>
            </span>
          )}
        </Row>
        {patch.no_changes && (
          <Row term="Changes">
            <span role="status" aria-label="No changes">No changes: the target branch is already at this revision's source commit.</span>
          </Row>
        )}
        {patch.merged && (
          <Row term="Merged">
            {patch.merged.method === "squash" ? "As one squashed commit" : "With its source commits"}
          </Row>
        )}
        <Row term="Mergeability">
          <span aria-label="Mergeability">
            {patch.mergeability.available ? (
              <span className="flex flex-col gap-1">
                <span>Merging its commits {mergeResults[patch.mergeability.source]}.</span>
                <span>Squash-merging {mergeResults[patch.mergeability.squash]}.</span>
              </span>
            ) : patch.mergeability.reason.message}
          </span>
        </Row>
      </dl>
    </Field>
  )
}

/** Links to the revision's files, commits and diff, which Haxy bounds by the revision's base. */
function Review({ repo, patch }: { repo: RepoLocator; patch: PatchDetail }) {
  const { review } = patch
  const button = "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
  const count = patch.revision?.commit_count ?? null
  return (
    <Field title="Review">
      {review.available ? (
        <nav aria-label="Review this revision" className="flex flex-wrap gap-2">
          <Link to={revisionFilesRoute(repo, review.revision)} className={button}><FileCode2 size={16} aria-hidden />Files</Link>
          <Link to={revisionCommitsRoute(repo, review.revision)} className={button}><GitCommitHorizontal size={16} aria-hidden />{count === null ? "Commits" : `Commits (${count})`}</Link>
          <Link to={revisionDiffRoute(repo, review.diff, { patch: patch.id })} className={button}><GitCompareArrows size={16} aria-hidden />{patch.status === "merged" ? "What landed" : "Diff"}</Link>
        </nav>
      ) : (
        <p role="status" aria-label="Review unavailable" className="text-sm text-muted-foreground">{review.reason.message}</p>
      )}
    </Field>
  )
}
