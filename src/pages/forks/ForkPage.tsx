import { Link, useLocation, useParams, type RouteObject } from "react-router"
import { GitFork } from "lucide-react"
import { FailureState, UnavailableState } from "@/components/listing"
import { RepoFiles } from "@/components/RepoFiles"
import { RepoRefs } from "@/components/RepoRefs"
import { FileFinder } from "@/components/finder/FileFinder"
import { useSession } from "@/app/session"
import { commitsRoute } from "@/lib/commits"
import { forkRoute, getFork, type ForkSection, type ForkSummary } from "@/lib/forks"
import { routePath, routeRef, sourceKey, type ForkLocator, type RefKind } from "@/lib/repo"
import { useResource } from "@/lib/resource"
import { CommitsSection } from "@/pages/commits/CommitsSection"
import { DeleteFork } from "./DeleteFork"
import { ForkAbout } from "./ForkAbout"
import { ForkDiffView } from "./ForkDiff"

const linkClass = "text-primary underline-offset-4 hover:underline"

type Section = ForkSection | "find" | RefKind

const tabLabels: Record<ForkSection, string> = { patch: "Patch", files: "Files", commits: "Commits", diff: "Diff", delete: "Delete" }

function tabRoute(fork: ForkLocator, tab: ForkSection): string {
  return tab === "commits" ? commitsRoute(fork) : forkRoute(fork, tab)
}

function currentTab(section: Section): ForkSection {
  if (section === "find" || section === "branch" || section === "tag") return "files"
  return section
}

/** The fork's sections, as the TUI's fork page has them; Delete for its forker only. */
function Tabs({ fork, summary, section }: { fork: ForkLocator; summary: ForkSummary; section: Section }) {
  const tabs: ForkSection[] = summary.actions.delete.available ? ["patch", "files", "commits", "diff", "delete"] : ["patch", "files", "commits", "diff"]
  const current = currentTab(section)
  return (
    <nav aria-label="Fork" className="mt-4 flex flex-wrap gap-1 border-b">
      {tabs.map((tab) => (
        <Link key={tab} to={tabRoute(fork, tab)} aria-current={tab === current ? "page" : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === current ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
          {tabLabels[tab]}
        </Link>
      ))}
    </nav>
  )
}

function Header({ fork, summary }: { fork: ForkLocator; summary: ForkSummary }) {
  return (
    <header>
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <GitFork size={15} aria-hidden />
        Fork <Link to={`/users/${encodeURIComponent(fork.forker)}`} className={linkClass}>{fork.forker}</Link>/{fork.name}
      </p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{summary.title}</h1>
    </header>
  )
}

function Body({ fork, summary, section }: { fork: ForkLocator; summary: ForkSummary; section: Section }) {
  const location = useLocation()
  const viewer = useSession().viewer?.name ?? null
  switch (section) {
    case "patch": return <ForkAbout summary={summary} />
    case "files": return <div className="mt-6"><RepoFiles repo={fork} refId={routeRef(location.search)} name={fork.name} path={routePath(fork, location.pathname)} clone={[]} /></div>
    case "commits": return <CommitsSection repo={fork} />
    case "diff": return <ForkDiffView fork={fork} />
    case "delete": return <DeleteFork fork={fork} summary={summary} viewer={viewer} />
    case "find": return <FileFinder repo={fork} />
    case "branch":
    case "tag": return <div className="mt-6"><RepoRefs repo={fork} kind={section} /></div>
  }
}

function NotFound({ fork }: { fork: ForkLocator }) {
  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight">Fork not found</h1>
      <p className="mt-3 text-muted-foreground">There is no fork <strong>{fork.forker}/{fork.name}</strong> with this id that you can see.</p>
      <Link to={`/users/${encodeURIComponent(fork.forker)}`} className={`mt-6 inline-block text-sm ${linkClass}`}>Browse {fork.forker}'s forks</Link>
    </section>
  )
}

/**
 * A fork: `/forks/<forker>/<name>/<id>` shows what it proposes and its patch,
 * with its files (`…/files/<path>`), commits (`…/commits/…`), diff (`…/diff`)
 * and, for its forker, its deletion (`…/delete`). Read again on every
 * navigation, so a push or a deletion elsewhere shows.
 */
export function ForkPage({ section = "patch" }: { section?: Section }) {
  const params = useParams()
  const location = useLocation()
  const fork: ForkLocator = { kind: "fork", forker: params.forker ?? "", name: params.name ?? "", id: params.id ?? "" }
  const summary = useResource(`fork ${sourceKey(fork)}`, (signal) => getFork(fork, { signal }), location.pathname + location.search + location.key)
  switch (summary.kind) {
    case "failed":
      if (summary.error.code === "not_found") return <NotFound fork={fork} />
      if (summary.error.code === "unsupported") return <UnavailableState title="Fork">Local mode has no forks.</UnavailableState>
      return <FailureState title="Couldn't load this fork" error={summary.error} onRetry={summary.reload} />
    case "loaded":
      return (
        <>
          <Header fork={fork} summary={summary.data} />
          <Tabs fork={fork} summary={summary.data} section={section} />
          <Body fork={fork} summary={summary.data} section={section} />
        </>
      )
  }
}

const base = "forks/:forker/:name/:id"

/** The fork routes, for the app's router. */
export const forkRoutes: RouteObject[] = [
  { path: base, element: <ForkPage /> },
  { path: `${base}/files/*`, element: <ForkPage section="files" /> },
  { path: `${base}/commits/*`, element: <ForkPage section="commits" /> },
  { path: `${base}/diff`, element: <ForkPage section="diff" /> },
  { path: `${base}/delete`, element: <ForkPage section="delete" /> },
  { path: `${base}/find`, element: <ForkPage section="find" /> },
  { path: `${base}/branches`, element: <ForkPage section="branch" /> },
  { path: `${base}/tags`, element: <ForkPage section="tag" /> },
]
