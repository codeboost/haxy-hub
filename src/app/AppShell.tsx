import { Link, NavLink, Outlet } from "react-router"
import { GitBranch, LoaderCircle, RefreshCw, Unplug } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useConnection } from "@/app/connection"
import { SessionProvider, useSession } from "@/app/session"
import { ViewerControls } from "@/app/ViewerControls"
import { NotificationsLink } from "@/app/NotificationsLink"
import type { BackendCheck } from "@/lib/connection"

function modeLabel(check: BackendCheck | null): string {
  if (!check) return "Connecting…"
  switch (check.kind) {
    case "connected": return check.status.mode === "server" ? "Server mode" : "Local mode"
    case "unreachable": return "Offline"
    case "incompatible": return "Incompatible"
  }
}

function ModeIndicator() {
  const { check } = useConnection()
  const tone = check?.kind === "connected" ? "bg-emerald-600" : check ? "bg-destructive" : "animate-pulse bg-amber-500"
  return (
    <p aria-label="Backend" className="flex items-center gap-2 rounded-full border px-3 py-1 text-xs text-muted-foreground">
      <span aria-hidden className={`size-2 rounded-full ${tone}`} />
      {modeLabel(check)}
    </p>
  )
}

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

function MainNav() {
  const { check } = useConnection()
  // Local mode has no forge-wide pages, and a server has no single repository;
  // their routes say so if opened directly.
  const mode = check?.kind === "connected" ? check.status.mode : "server"
  return (
    <nav aria-label="Main" className="flex flex-wrap items-center gap-1">
      {navItems.filter((item) => item.only === null || item.only === mode).map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            `rounded-md px-2.5 py-1.5 text-sm sm:px-3 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${isActive ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  )
}

/** The layout route: header with navigation, mode and viewer, and the routed page once connected. */
export function AppShell() {
  return <SessionProvider><Shell /></SessionProvider>
}

function Shell() {
  const { check } = useConnection()
  const { ready, viewerKey } = useSession()
  return (
    <div className="min-h-screen">
      <header className="border-b bg-card">
        {/* Wraps onto more rows on narrow screens instead of overflowing. */}
        <div className="mx-auto flex min-h-16 max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-10">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:gap-x-8">
            <Link to="/" aria-label="Haxy Hub home" className="flex items-center gap-3">
              <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground"><GitBranch size={21} /></span>
              <span className="hidden text-xl font-bold tracking-tight sm:inline">haxy<span className="text-primary">.</span></span>
            </Link>
            <MainNav />
          </div>
          <div className="flex items-center gap-3">
            <NotificationsLink />
            <ViewerControls />
            <ModeIndicator />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-10 sm:px-10 sm:py-16">
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
  )
}
