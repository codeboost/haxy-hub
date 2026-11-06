import { Link } from "react-router"
import { GitFork } from "lucide-react"
import { linkClass } from "@/components/thread/config"
import { newDraftRoute } from "@/lib/drafts"
import type { RepoLocator } from "@/lib/repo"

/** The way to start a patch with a new fork instead, beside a new patch's branch pickers; drafts live on a server only. */
export function StartForkLink({ repo }: { repo: RepoLocator }) {
  if (repo.kind === "local") return null
  return (
    <p className="mt-3 text-sm text-muted-foreground">
      No branch to propose from? <Link to={newDraftRoute(repo)} className={`inline-flex items-center gap-1 ${linkClass}`}><GitFork size={14} aria-hidden />Start with a new fork</Link> and push your commits to it.
    </p>
  )
}
