import type { ReactNode } from "react"
import { Link, useLocation } from "react-router"
import { ArrowLeft } from "lucide-react"
import { FailureState } from "@/components/listing"
import { Markdown } from "@/components/Markdown"
import { linkClass } from "@/components/thread/config"
import { RefreshFailed, useKept } from "@/components/thread/ThreadComments"
import { Instant, SectionUnavailable } from "@/components/thread/ThreadParts"
import { useSession } from "@/app/session"
import { draftsRoute, getDraft, type DraftDetail } from "@/lib/drafts"
import { linkTarget } from "@/lib/markdown"
import { repoRoute, type RepoLocator } from "@/lib/repo"
import { useResource } from "@/lib/resource"
import { DraftActions } from "./DraftActions"
import { ForkCommands } from "./ForkCommands"
import { forkOf, forkRoute } from "@/lib/forks"

/**
 * `<repo>/patches/drafts/<id>`: one of the viewer's drafts — what it would
 * propose, the fork it lives in with the Git commands for it (as the TUI
 * offers them), its description — and what its author may do: edit, publish
 * or remove it. Every navigation reads it again, so a push to the fork shows;
 * a refresh that fails keeps the page.
 */
export function DraftDetailView({ repo, id, unavailable }: { repo: RepoLocator; id: string; unavailable: string | null }) {
  const { viewer, viewerKey } = useSession()
  const location = useLocation()
  const key = repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
  const resourceKey = `draft ${key} ${id} ${viewerKey}`
  const read = useResource(resourceKey, (signal) => getDraft(repo, id, { signal }), location.key)
  const draft = useKept(read, resourceKey)
  switch (draft.kind) {
    case "failed":
      if (draft.error.code === "not_found") {
        if (unavailable) return <SectionUnavailable>{unavailable}</SectionUnavailable>
        return (
          <section className="mt-6">
            <h2 className="text-2xl font-semibold tracking-tight">Draft not found</h2>
            <p className="mt-2 text-muted-foreground">You have no draft with this id in this repository. It may have been published or removed.</p>
            <Link to={draftsRoute(repo)} className={`mt-4 inline-block text-sm ${linkClass}`}>Your drafts</Link>
          </section>
        )
      }
      return <FailureState title="Couldn't load this draft" error={draft.error} onRetry={read.reload} />
    case "loaded":
      return (
        <>
          {draft.refreshFailed && <div className="mt-6"><RefreshFailed title="Couldn't refresh this draft" error={draft.refreshFailed} onRetry={read.reload} /></div>}
          <Body repo={repo} draft={draft.data} viewer={viewer?.name ?? null} />
        </>
      )
  }
}

function Body({ repo, draft, viewer }: { repo: RepoLocator; draft: DraftDetail; viewer: string | null }) {
  return (
    <article className="mt-6">
      <Link to={draftsRoute(repo)} className={`inline-flex items-center gap-1 text-sm ${linkClass}`}><ArrowLeft size={14} aria-hidden />Your drafts</Link>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight">{draft.title}</h2>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <span aria-label="Status" className="rounded-full border px-2 py-0.5 text-xs font-medium text-foreground">Draft</span>
        <span>Started <Instant value={draft.created_at} /></span>
        <span>Only you see it until you publish it.</span>
      </div>
      <DraftActions repo={repo} draft={draft} viewer={viewer} />
      {draft.labels.length > 0 && <Field title="Labels"><p className="text-sm">{draft.labels.join(" ")}</p></Field>}
      <Proposal repo={repo} draft={draft} />
      {draft.commands.length > 0 ? <ForkCommands commands={draft.commands} noun="draft" />
        : <Field title="Git"><p className="text-sm text-muted-foreground">This server offers no SSH access, so the fork can't be pushed to or fetched with Git.</p></Field>}
      <Field title="Description">
        <div className="rounded-xl border bg-card p-4 sm:p-6">
          {draft.description.length === 0 ? <p className="text-muted-foreground">No description.</p> : <Markdown blocks={draft.description} resolveLink={(destination) => linkTarget(destination, false)} />}
        </div>
      </Field>
    </article>
  )
}

function Field({ title, children }: { title: string; children: ReactNode }) {
  const id = `draft-${title.toLowerCase().replace(/\s+/g, "-")}`
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

/** What the draft would propose: its fork, its target, and what was pushed to the fork. */
function Proposal({ repo, draft }: { repo: RepoLocator; draft: DraftDetail }) {
  const { revision } = draft
  return (
    <Field title="Proposal">
      <dl className="divide-y rounded-xl border bg-card">
        <Row term="Source">
          Your fork <span className="font-mono">{draft.fork.owner}/{draft.fork.name}</span>{" "}
          <Link to={forkRoute(forkOf(draft.fork, draft.id))} className={linkClass}>Browse the fork</Link>
        </Row>
        <Row term="Target">Branch <Link to={repoRoute(repo, "", draft.target.id)} className={`font-mono ${linkClass}`}>{draft.target.name}</Link></Row>
        <Row term="Revision">
          {revision === null ? "Nothing has been pushed yet." : (
            <span className="flex flex-col gap-1">
              <span>Source commit <code className="font-mono">{revision.source_commit.slice(0, 10)}</code></span>
              <span aria-label="Commit count">{revision.commit_count === null ? "Commit count unavailable" : `${revision.commit_count} ${revision.commit_count === 1 ? "commit" : "commits"}`}</span>
            </span>
          )}
        </Row>
        {draft.no_changes && <Row term="Changes"><span role="status" aria-label="No changes">No changes: the target branch is already at the fork's patch branch.</span></Row>}
      </dl>
    </Field>
  )
}
