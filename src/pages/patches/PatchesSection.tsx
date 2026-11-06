import { Link } from "react-router"
import { linkClass } from "@/components/thread/config"
import { ThreadSection } from "@/components/thread/ThreadSection"
import { draftView } from "@/lib/drafts"
import { patchStatuses, revisionView } from "@/lib/patches"
import type { RepoLocator, RepoSection } from "@/lib/repo"
import { threadView, threadsRoute } from "@/lib/threads"
import { patchThreads } from "./config"
import { DraftsLink, DraftsSection } from "./drafts/DraftsSection"
import { PatchDetailView } from "./PatchDetail"
import { RevisionDiffView } from "./RevisionDiff"

/**
 * A repository's patches: `<repo>/patches[/closed|/merged|/labels]` lists
 * them as the TUI's tabs do, `<repo>/patches/<id>` is one patch (its
 * comments under `…/<id>/comments/<comment>`), and
 * `<repo>/patches/revisions/<id>/diff` is a revision's diff; `…/new` opens a
 * branch-backed patch and `…/<id>/edit` edits one; `…/drafts` are the
 * viewer's drafts, started with a new fork. The patches are
 * always requested, since another client may have turned them on or off
 * since `sections` was read; when Haxy answers not found and the
 * repository's sections lack patches, they are turned off.
 */
export function PatchesSection({ repo, sections, tail }: { repo: RepoLocator; sections: RepoSection[]; tail: string }) {
  const unavailable = sections.includes("patches") ? null : "Patches are turned off for this repository."
  const drafts = draftView(tail)
  if (drafts !== null) return <DraftsSection repo={repo} view={drafts} unavailable={unavailable} />
  const revision = revisionView(tail)
  if (revision !== null) return <RevisionDiffView key={revision.revision} repo={repo} revision={revision.revision} />
  const view = threadView(patchStatuses, tail)
  // revisions have no page of their own
  if (tail.startsWith("revisions")) return <NoSuchPage repo={repo} />
  if (view.kind === "thread") return <PatchDetailView key={view.id} repo={repo} id={view.id} unavailable={unavailable} />
  return <>{view.kind === "list" && <DraftsLink repo={repo} />}<ThreadSection repo={repo} config={patchThreads} tail={tail} unavailable={unavailable} /></>
}

function NoSuchPage({ repo }: { repo: RepoLocator }) {
  return (
    <section className="mt-6">
      <h2 className="text-2xl font-semibold tracking-tight">Page not found</h2>
      <Link to={threadsRoute(repo, "patches", patchStatuses, "open")} className={`mt-4 inline-block text-sm ${linkClass}`}>All patches</Link>
    </section>
  )
}
