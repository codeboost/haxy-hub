import { Link, useLocation } from "react-router"
import { FailureState } from "@/components/listing"
import { useSession } from "@/app/session"
import type { RepoLocator } from "@/lib/repo"
import { getSettings, type AdminRepo } from "@/lib/repoAdmin"
import { useResource } from "@/lib/resource"
import { loginPath } from "@/lib/session"
import { BranchesSettings } from "./BranchesSettings"
import { DeleteRepo } from "./DeleteRepo"
import { GeneralSettings } from "./GeneralSettings"
import { MembersSettings } from "./MembersSettings"
import { adminRoute, linkClass, type AdminPage } from "./shared"

const pages: Array<{ page: AdminPage; label: string }> = [
  { page: "", label: "General" },
  { page: "members", label: "Members" },
  { page: "branches", label: "Branches" },
  { page: "delete", label: "Delete" },
]

/**
 * A repository's administration, which only its owners reach:
 * `<repo>/settings[/members|/branches|/delete]`. Server mode only. The
 * settings are read again on each navigation, so a role another owner took
 * away shows on the next one; Haxy checks every change again when it lands.
 */
export function SettingsSection({ repo, tail }: { repo: RepoLocator; tail: string }) {
  if (repo.kind === "local") {
    return <p role="status" className="mt-6 max-w-xl text-muted-foreground">Local mode has no accounts or members, so there are no repository settings to manage here.</p>
  }
  const page = pages.find((each) => each.page === tail.replace(/\/+$/, ""))
  if (!page) {
    return (
      <section className="mt-6">
        <h2 className="text-2xl font-semibold tracking-tight">Page not found</h2>
        <Link to={adminRoute(repo)} className={`mt-4 inline-block text-sm ${linkClass}`}>Repository settings</Link>
      </section>
    )
  }
  return <Administration repo={repo} page={page.page} />
}

function Administration({ repo, page }: { repo: AdminRepo; page: AdminPage }) {
  const { viewer } = useSession()
  const location = useLocation()
  const settings = useResource(`repo settings ${repo.owner}/${repo.name} ${viewer?.name ?? ""}`, (signal) => getSettings(repo, { signal }), location.key)

  if (settings.kind === "failed") {
    switch (settings.error.code) {
      case "unauthenticated":
        return (
          <p className="mt-6 text-muted-foreground">
            <Link to={loginPath(location.pathname + location.search)} className={linkClass}>Log in</Link> to manage this repository.
          </p>
        )
      case "forbidden":
        return <p role="status" className="mt-6 text-muted-foreground">Only the repository's owners can manage it.</p>
      case "not_found":
        return <p role="status" className="mt-6 text-muted-foreground">There is no repository with this name that you can see.</p>
      default:
        return <FailureState title="Couldn't load the settings" error={settings.error} onRetry={settings.reload} />
    }
  }
  // a form is loaded for, and its writes bound to, the viewer it was read for
  if (!viewer) return null
  const data = settings.data
  return (
    <div className="mt-6 grid gap-8 md:grid-cols-[11rem_1fr]">
      <nav aria-label="Settings pages" className="flex flex-row flex-wrap gap-1 md:flex-col">
        {pages.map((each) => (
          <Link key={each.page} to={adminRoute(repo, each.page)} aria-current={each.page === page ? "page" : undefined}
            className={`rounded-md px-3 py-1.5 text-sm ${each.page === page ? "bg-accent font-medium" : ""} ${each.page === "delete" ? "text-destructive" : each.page === page ? "" : "text-muted-foreground hover:text-foreground"}`}>
            {each.label}
          </Link>
        ))}
      </nav>
      <div className="min-w-0">
        {page === "" && <GeneralSettings key={viewer.name} repo={repo} viewer={viewer.name} settings={data} />}
        {page === "members" && <MembersSettings key={viewer.name} repo={repo} viewer={viewer.name} mainOwner={data.main_owner} />}
        {page === "branches" && <BranchesSettings key={viewer.name} repo={repo} viewer={viewer.name} />}
        {page === "delete" && <DeleteRepo key={viewer.name} repo={repo} viewer={viewer.name} settings={data} />}
      </div>
    </div>
  )
}
