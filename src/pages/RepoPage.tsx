import { Link, useLocation, useParams, type RouteObject } from "react-router"
import { Lock } from "lucide-react"
import { CommandList } from "@/components/GitCommands"
import { EmptyState, FailureState, LoadingState, UnavailableState } from "@/components/listing"
import { RepoFiles } from "@/components/RepoFiles"
import { RepoRefs } from "@/components/RepoRefs"
import { getRepo, refsRoute, repoRoute, routePath, routeRef, type RefKind, type RepoLocator, type RepoOverview, type RepoSection } from "@/lib/repo"
import { IssuesSection } from "@/pages/issues/IssuesSection"
import { FileFinder } from "@/components/finder/FileFinder"
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

/** The sections Hub shows so far, and where each starts. */
const sectionRoutes: Partial<Record<RepoSection, (repo: RepoLocator) => string>> = {
  files: (repo) => repoRoute(repo),
  refs: (repo) => refsRoute(repo, "branch"),
  issues: (repo) => `${repoRoute(repo)}/issues`,
}

/** The sections Haxy offers this viewer. Those Haxy Hub doesn't have yet are listed, not linked. */
function Sections({ repo, sections, current }: { repo: RepoLocator; sections: RepoSection[]; current: RepoSection }) {
  return (
    <nav aria-label="Repository sections" className="mt-6 flex flex-wrap gap-1 border-b">
      {sections.map((section) =>
        sectionRoutes[section] ? (
          <Link key={section} to={sectionRoutes[section](repo)} aria-current={section === current ? "page" : undefined} className={`-mb-px border-b-2 px-3 py-2 text-sm ${section === current ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{sectionLabels[section]}</Link>
        ) : (
          <span key={section} aria-disabled="true" title="Not available in Haxy Hub yet" className="px-3 py-2 text-sm text-muted-foreground">{sectionLabels[section]}</span>
        ),
      )}
    </nav>
  )
}

function Header({ repo, overview, section }: { repo: RepoLocator; overview: RepoOverview; section: RepoSection }) {
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
      <Sections repo={repo} sections={overview.sections} current={section} />
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
 * A repository's overview and its files at the default branch or the URL's
 * `?ref=`: `/repos/<owner>/<name>[/files/<path>]` on a server,
 * `/repo[/files/<path>]` for the repository a local Haxy opened; with `refs`,
 * its branches or tags (`…/branches`, `…/tags`); `section` picks another
 * section under the same header (`…/issues/…`).
 */
export function RepoPage({ local = false, section = "files", refs }: { local?: boolean; section?: "files" | "issues" | "find"; refs?: RefKind }) {
  const params = useParams()
  const location = useLocation()
  const repo: RepoLocator = local ? { kind: "local" } : { kind: "server", owner: params.owner ?? "", name: params.name ?? "" }
  // not params["*"] or the search params, which the router has already percent-decoded
  const path = routePath(repo, location.pathname)
  const refId = routeRef(location.search)
  const key = repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
  // read again on each navigation, so sections another client turned on or off show
  const overview = useResource(`repo ${key}`, (signal) => getRepo(repo, { signal }), location.pathname + location.search)

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
          <Header repo={repo} overview={data} section={refs ? "refs" : section === "find" ? "files" : section} />
          {refs ? (
            <RepoRefs repo={repo} kind={refs} />
          ) : section === "issues" ? (
            <IssuesSection repo={repo} sections={data.sections} tail={params["*"] ?? ""} />
          ) : section === "find" ? (
            <FileFinder repo={repo} />
          ) : data.empty && refId === null ? (
            // `empty` describes the default branch; an explicit ref resolves on its own
            <>
              <EmptyState title="This repository is empty">
                {data.default_branch ? <>Its default branch, <code className="font-mono">{data.default_branch}</code>, has no commits yet.</> : "It has no commits yet."}
              </EmptyState>
              {data.remote && <CommandList title="Push an existing repository" commands={[data.remote]} purpose="remote" />}
            </>
          ) : (
            <>
              {data.clone.length > 0 && <CommandList title="Clone" commands={data.clone} purpose="clone" />}
              <RepoFiles repo={repo} refId={refId} name={data.name} path={path} />
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
  { path: "repo/issues/*", element: <RepoPage local section="issues" /> },
  { path: "repos/:owner/:name", element: <RepoPage /> },
  { path: "repos/:owner/:name/files/*", element: <RepoPage /> },
  { path: "repo/branches", element: <RepoPage local refs="branch" /> },
  { path: "repo/tags", element: <RepoPage local refs="tag" /> },
  { path: "repos/:owner/:name/branches", element: <RepoPage refs="branch" /> },
  { path: "repos/:owner/:name/tags", element: <RepoPage refs="tag" /> },
  { path: "repos/:owner/:name/issues/*", element: <RepoPage section="issues" /> },
  { path: "repo/find", element: <RepoPage local section="find" /> },
  { path: "repos/:owner/:name/find", element: <RepoPage section="find" /> },
]
