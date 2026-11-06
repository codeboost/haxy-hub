import type { ReactNode } from "react"
import { Link, useLocation } from "react-router"
import { ArrowLeft, FileCode2, GitCommitHorizontal, GitCompareArrows, MessageSquare, TriangleAlert } from "lucide-react"
import { FailureState, LoadingState } from "@/components/listing"
import { Markdown } from "@/components/Markdown"
import { linkClass } from "@/components/thread/config"
import { RefreshFailed, ThreadComments, useKept } from "@/components/thread/ThreadComments"
import { AuthorName, Instant, LabelLinks, SectionUnavailable } from "@/components/thread/ThreadParts"
import { useSession } from "@/app/session"
import { commitRoute } from "@/lib/commits"
import { linkTarget } from "@/lib/markdown"
import { getPatch, revisionCommitsRoute, revisionDiffRoute, revisionFilesRoute, revisionRef, type MergeResult, type PatchDetail } from "@/lib/patches"
import { repoRoute, type RepoLocator } from "@/lib/repo"
import { useResource } from "@/lib/resource"
import { threadsRoute } from "@/lib/threads"
import { patchThreads } from "./config"

const config = patchThreads

/**
 * `<repo>/patches/<id>`: one patch, as the TUI's patch detail shows it —
 * where its commits come from and go to, the revision it proposes with its
 * commit count, whether it changes anything, whether Haxy would merge it —
 * with links to review that revision's files, commits and diff, then its
 * description and comments. Every navigation reads it again, so a revision
 * pushed from another client shows; a refresh that fails keeps the page.
 */
export function PatchDetailView({ repo, id, unavailable }: { repo: RepoLocator; id: string; unavailable: string | null }) {
  const { viewerKey } = useSession()
  const location = useLocation()
  const key = repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
  const resourceKey = `patch ${key} ${id} ${viewerKey}`
  const read = useResource(resourceKey, (signal) => getPatch(repo, id, { signal }), location.key)
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
          <Body repo={repo} patch={patch.data} />
        </>
      )
  }
}

function Body({ repo, patch }: { repo: RepoLocator; patch: PatchDetail }) {
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
      {patch.conflicted && (
        <p className="mt-4 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-2 text-sm">
          <TriangleAlert size={16} aria-hidden />Concurrent edits to this patch conflict; the values shown are this server's.
        </p>
      )}
      {patch.labels.length > 0 && <Field title="Labels"><div className="flex flex-wrap gap-1"><LabelLinks labels={patch.labels} to={listOf} /></div></Field>}
      <Proposal repo={repo} patch={patch} />
      <Review repo={repo} patch={patch} />
      <Field title="Description">
        <div className="rounded-xl border bg-card p-4 sm:p-6">
          {patch.description.length === 0 ? <p className="text-muted-foreground">No description.</p> : <Markdown blocks={patch.description} resolveLink={(destination) => linkTarget(destination, repo.kind === "local")} />}
        </div>
      </Field>
      <ThreadComments repo={repo} config={config} thread={patch.id} />
    </article>
  )
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
