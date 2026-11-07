import { Link } from "react-router"
import { ArrowLeft } from "lucide-react"
import { useSession } from "@/app/session"
import { FailureState } from "@/components/listing"
import { linkClass } from "@/components/thread/config"
import { SectionUnavailable } from "@/components/thread/ThreadParts"
import { getConflict, type ConflictKind } from "@/lib/conflicts"
import type { RepoLocator } from "@/lib/repo"
import { useResource } from "@/lib/resource"
import { threadRoute } from "@/lib/threads"
import { ResolveForm } from "./ResolveForm"

/**
 * `<repo>/<kind>/<id>/conflict`: one thread's metadata conflict, both sides
 * of each conflicted field and description chunk with who wrote them, and
 * the form that resolves it. A patch's code conflicts are its mergeability,
 * never shown here.
 */
export function ConflictPage({ repo, kind, noun, id, unavailable }: { repo: RepoLocator; kind: ConflictKind; noun: string; id: string; unavailable: string | null }) {
  const { viewer, viewerKey } = useSession()
  const key = repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
  const answer = useResource(`conflict ${kind} ${key} ${id} ${viewerKey}`, (signal) => getConflict(repo, kind, id, { signal }))
  const lower = noun.toLowerCase()
  const back = <Link to={threadRoute(repo, kind, id)} className={`inline-flex items-center gap-1 text-sm ${linkClass}`}><ArrowLeft size={14} aria-hidden />Back to the {lower}</Link>
  switch (answer.kind) {
    case "failed":
      if (answer.error.code === "not_found" && unavailable) return <SectionUnavailable>{unavailable}</SectionUnavailable>
      if (answer.error.code === "not_found") return <section className="mt-6"><h2 className="text-2xl font-semibold tracking-tight">{noun} not found</h2><p className="mt-2 text-muted-foreground">There is no {lower} with this id in this repository. It may have been removed.</p></section>
      return <FailureState title="Couldn't load the conflict" error={answer.error} onRetry={answer.reload} />
    case "loaded": {
      const { thread, conflict, actions } = answer.data
      return (
        <section className="mt-6">
          {back}
          <h2 className="mt-3 text-2xl font-semibold tracking-tight">Resolve metadata conflict</h2>
          <p className="mt-1 text-muted-foreground">{thread.title}</p>
          {conflict === null ? (
            <p role="status" className="mt-4 rounded-xl border border-dashed p-6 text-center text-muted-foreground">This {lower} has no metadata conflict to resolve.</p>
          ) : (
            <>
              <p className="mt-4 max-w-3xl text-sm text-muted-foreground">
                This {lower}'s details were edited differently on two hosts. Until it's resolved, it keeps the current values. Choose what each conflicted field should hold; the resolution is recorded as one event and syncs like any other.
              </p>
              <ResolveForm key={conflict.revision} repo={repo} kind={kind} noun={lower} id={id} conflict={conflict} resolve={actions.resolve} viewer={viewer?.name ?? null} reload={answer.reload} />
            </>
          )}
        </section>
      )
    }
  }
}
