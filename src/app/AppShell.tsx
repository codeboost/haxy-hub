import { Link, NavLink, Outlet } from "react-router"
import { GitBranch, LoaderCircle, RefreshCw, Unplug } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useConnection } from "@/app/connection"
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
  { to: "/", label: "Home", end: true },
  { to: "/connection", label: "Connection", end: false },
]

function MainNav() {
  return (
    <nav aria-label="Main" className="flex items-center gap-1">
      {navItems.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            `rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${isActive ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  )
}

/** The layout route: header with navigation and mode, and the routed page once connected. */
export function AppShell() {
  const { check } = useConnection()
  return (
    <div className="min-h-screen">
      <header className="border-b bg-card">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-4 sm:px-10">
          <div className="flex items-center gap-4 sm:gap-8">
            <Link to="/" aria-label="Haxy Hub home" className="flex items-center gap-3">
              <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground"><GitBranch size={21} /></span>
              <span className="hidden text-xl font-bold tracking-tight sm:inline">haxy<span className="text-primary">.</span></span>
            </Link>
            <MainNav />
          </div>
          <ModeIndicator />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-10 sm:px-10 sm:py-16">
        {check === null ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="animate-spin" size={16} /> Connecting to Haxy…</p>
        ) : check.kind === "connected" ? <Outlet /> : <ConnectionProblem check={check} />}
      </main>
    </div>
  )
}
