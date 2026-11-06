import { Link } from "react-router"
import { TriangleAlert } from "lucide-react"
import { linkClass } from "@/components/thread/config"
import { conflictRoute, type ConflictKind } from "@/lib/conflicts"
import type { RepoLocator } from "@/lib/repo"

/** A thread page's notice that its details have an unresolved metadata conflict, with the way to resolve it. */
export function ConflictBanner({ repo, kind, id, noun }: { repo: RepoLocator; kind: ConflictKind; id: string; noun: string }) {
  return (
    <p className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-2 text-sm">
      <TriangleAlert size={16} aria-hidden />Concurrent edits to this {noun} conflict; the values shown are this server's.
      <Link to={conflictRoute(repo, kind, id)} className={linkClass}>Resolve the conflict</Link>
    </p>
  )
}
