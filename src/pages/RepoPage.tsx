import { Link, useLocation, useParams, type RouteObject } from "react-router"
import { Lock } from "lucide-react"
import { CommandList } from "@/components/GitCommands"
import { EmptyState, FailureState, LoadingState, UnavailableState } from "@/components/listing"
import { RepoFiles } from "@/components/RepoFiles"
import { getRepo, repoRoute, routePath, type RepoLocator, type RepoOverview, type RepoSection } from "@/lib/repo"
import { useResource } from "@/lib/resource"

const sectionLabels: Record<RepoSection, string> = {
  files: "Files",
  commits: "Commits",
  refs: "Refs",
  discussions: "Discussions",
  issues: "Issues",
  patches: "Patches",
  events: "Events",
  undo: "Undo",
  settings: "Settings",
}

const linkClass = "text-primary underline-offset-4 hover:underline"

/** The sections Haxy offers this viewer. Only Files exists in Haxy Hub so far; the rest are listed, not linked. */
function Sections({ repo, sections }: { repo: RepoLocator; sections: RepoSection[] }) {
  return (
    <nav aria-label="Repository sections" className="mt-6 flex flex-wrap gap-1 border-b">
      {sections.map((section) =>
        section === "files" ? (
          <Link key={section} to={repoRoute(repo)} aria-current="page" className="-mb-px border-b-2 border-primary px-3 py-2 text-sm font-medium">{sectionLabels[section]}</Link>
        ) : (
          <span key={section} aria-disabled="true" title="Not available in Haxy Hub yet" className="px-3 py-2 text-sm text-muted-foreground">{sectionLabels[section]}</span>
        ),
      )}
    </nav>
  )
}

function Header({ repo, overview }: { repo: RepoLocator; overview: RepoOverview }) {
  return (
    <>
      {overview.owner !== null && (
        <p className="text-sm text-muted-foreground">
          <Link to="/users" className="hover:underline">Users</Link> / <Link to={`/users/${encodeURIComponent(overview.owner)}`} className="hover:underline">{overview.owner}</Link> /
        </p>
      )}
      <h1 className="flex flex-wrap items-center gap-3 text-3xl font-semibold tracking-tight">
        {overview.name}
        {overview.access === "private" && (
          <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground"><Lock size={12} aria-hidden />Private</span>
        )}
      </h1>
      {overview.description && <p className="mt-2 text-muted-foreground">{overview.description}</p>}
      <Sections repo={repo} sections={overview.sections} />
    </>
  )
}

function NotFound({ repo }: { repo: RepoLocator }) {
  const label = repo.kind === "local" ? "this repository" : `${repo.owner}/${repo.name}`
  return (
    <section>
      <h1 className="text-3xl font-semibold tracking-tight">Repository not found</h1>
      {/* The same words whether it is missing or hidden from this viewer. */}
      <p className="mt-3 text-muted-foreground">There is no repository <strong>{label}</strong> that you can see.</p>
      {repo.kind === "server" && <Link to={`/users/${encodeURIComponent(repo.owner)}`} className={`mt-6 inline-block text-sm ${linkClass}`}>Browse {repo.owner}'s repositories</Link>}
    </section>
  )
}

/**
 * A repository's overview and its files at the default branch: `/repos/<owner>/<name>[/files/<path>]`
 * on a server, `/repo[/files/<path>]` for the repository a local Haxy opened.
 */
export function RepoPage({ local = false }: { local?: boolean }) {
  const params = useParams()
  const repo: RepoLocator = local ? { kind: "local" } : { kind: "server", owner: params.owner ?? "", name: params.name ?? "" }
  // not params["*"], which the router has already percent-decoded
  const path = routePath(repo, useLocation().pathname)
  const key = repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
  const overview = useResource(`repo ${key}`, (signal) => getRepo(repo, { signal }))

  switch (overview.kind) {
    case "loading":
      return <LoadingState>Loading the repository…</LoadingState>
    case "failed":
      if (overview.error.code === "not_found") return <NotFound repo={repo} />
      if (overview.error.code === "unsupported") {
        return local ? (
          <UnavailableState title="Repository">This server hosts many repositories. <Link to="/users" className={linkClass}>Find one on its owner's page</Link>.</UnavailableState>
        ) : (
          <UnavailableState title="Repository">Local mode serves only the repository Haxy opened. <Link to="/repo" className={linkClass}>Open the repository</Link></UnavailableState>
        )
      }
      return (
        <>
          <h1 className="text-3xl font-semibold tracking-tight">{repo.kind === "local" ? "Repository" : repo.name}</h1>
          <FailureState title="Couldn't load this repository" error={overview.error} onRetry={overview.reload} />
        </>
      )
    case "loaded": {
      const data = overview.data
      return (
        <>
          <Header repo={repo} overview={data} />
          {data.empty ? (
            <>
              <EmptyState title="This repository is empty">
                {data.default_branch ? <>Its default branch, <code className="font-mono">{data.default_branch}</code>, has no commits yet.</> : "It has no commits yet."}
              </EmptyState>
              {data.remote && <CommandList title="Push an existing repository" commands={[data.remote]} purpose="remote" />}
            </>
          ) : (
            <>
              {data.clone.length > 0 && <CommandList title="Clone" commands={data.clone} purpose="clone" />}
              <RepoFiles repo={repo} name={data.name} path={path} />
            </>
          )}
        </>
      )
    }
  }
}

/** The repository routes, for the app's router. */
export const repoRoutes: RouteObject[] = [
  { path: "repo", element: <RepoPage local /> },
  { path: "repo/files/*", element: <RepoPage local /> },
  { path: "repos/:owner/:name", element: <RepoPage /> },
  { path: "repos/:owner/:name/files/*", element: <RepoPage /> },
]
