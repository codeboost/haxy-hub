import { Link, NavLink, Outlet } from "react-router"
import { GitBranch, LoaderCircle, RefreshCw, Unplug } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useConnection } from "@/app/connection"
import { SessionProvider, useSession } from "@/app/session"
import { ViewerControls } from "@/app/ViewerControls"
import { NotificationsLink } from "@/app/NotificationsLink"
import type { BackendCheck } from "@/lib/connection"
import { RepoHeaderProvider, useRepoHeader } from "@/app/repoHeader"
import { RepoBreadcrumb, RepoTabs } from "@/app/RepoBar"

function ConnectionProblem({ check }: { check: Exclude<BackendCheck, { kind: "connected" }> }) {
  const { checking, retry } = useConnection()
  const title = check.kind === "unreachable" ? "Can't reach Haxy" : "Incompatible Haxy backend"
  return (
    <section aria-labelledby="connection-problem" className="max-w-2xl rounded-xl border bg-card p-6 shadow-sm">
      <div className="flex gap-4">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-secondary text-primary"><Unplug size={21} /></span>
        <div role="alert">
          <h1 id="connection-problem" className="text-lg font-semibold">{title}</h1>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{check.message}</p>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border-t pt-5">
        <p className="text-xs text-muted-foreground">Start or update Haxy, then retry.</p>
        <Button variant="outline" onClick={retry} disabled={checking}>
          <RefreshCw className={checking ? "animate-spin" : ""} />
          {checking ? "Checking…" : "Retry"}
        </Button>
      </div>
    </section>
  )
}

const navItems = [
  { to: "/", label: "Home", end: true, only: null },
  { to: "/repo", label: "Repository", end: false, only: "local" },
  { to: "/about", label: "About", end: false, only: "server" },
  { to: "/users", label: "Users", end: false, only: "server" },
  { to: "/connection", label: "Connection", end: false, only: null },
] as const

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-2.5 py-1 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${isActive ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`

function MainNav() {
  const { check } = useConnection()
  // Local mode has no forge-wide pages, and a server has no single repository;
  // their routes say so if opened directly.
  const mode = check?.kind === "connected" ? check.status.mode : "server"
  return (
    <nav aria-label="Main" className="flex flex-wrap items-center gap-1">
      {navItems.filter((item) => item.only === null || item.only === mode).map((item) => (
        <NavLink key={item.to} to={item.to} end={item.end} className={navLinkClass}>{item.label}</NavLink>
      ))}
    </nav>
  )
}

/** Inside a repository the header names it instead of listing the main pages; Users stays one click away on a server. */
function RepoNav() {
  const { check } = useConnection()
  if (check?.kind !== "connected" || check.status.mode !== "server") return null
  return (
    <nav aria-label="Main" className="flex items-center">
      <NavLink to="/users" className={navLinkClass}>Users</NavLink>
    </nav>
  )
}

function Header() {
  const repo = useRepoHeader()
  return (
    <header className="border-b bg-card">
      <div className="mx-auto max-w-5xl px-4 sm:px-10">
        {/* Wraps onto more rows on narrow screens instead of overflowing. */}
        <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 py-2">
          <Link to="/" aria-label="Haxy Hub home" className="flex shrink-0 items-center gap-2">
            <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground"><GitBranch size={16} /></span>
            <span className="hidden text-lg font-bold tracking-tight sm:inline">haxy<span className="text-primary">.</span></span>
          </Link>
          {repo ? <RepoBreadcrumb info={repo} /> : <div className="sm:ml-3"><MainNav /></div>}
          <div className="ml-auto flex items-center gap-1">
            {repo && <RepoNav />}
            <NotificationsLink />
            <ViewerControls />
          </div>
        </div>
        {repo && <RepoTabs info={repo} />}
      </div>
    </header>
  )
}

/** The layout route: header with navigation (or the open repository) and viewer, and the routed page once connected. */
export function AppShell() {
  return <SessionProvider><Shell /></SessionProvider>
}

function Shell() {
  const { check } = useConnection()
  const { ready, viewerKey } = useSession()
  return (
    <RepoHeaderProvider>
      <div className="min-h-screen">
        <Header />
        <main className="mx-auto max-w-5xl px-4 py-8 sm:px-10">
          {check === null ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="animate-spin" size={16} /> Connecting to Haxy…</p>
          ) : check.kind !== "connected" ? <ConnectionProblem check={check} /> : !ready ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="animate-spin" size={16} /> Loading…</p>
          ) : (
            // Keyed by viewer: logging out or switching accounts discards every
            // page's viewer-specific state.
            <Outlet key={viewerKey} />
          )}
        </main>
      </div>
    </RepoHeaderProvider>
  )
}
