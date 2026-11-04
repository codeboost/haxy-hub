import { useEffect, useState } from "react"
import { ArrowUpRight, Check, GitBranch, LoaderCircle, RefreshCw, Unplug } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { getBackendStatus, type BackendStatus } from "@/lib/api"

type Connection =
  | { state: "checking" }
  | { state: "connected"; backend: BackendStatus }
  | { state: "unavailable"; message: string }

export default function App() {
  const [attempt, setAttempt] = useState(0)
  const [connection, setConnection] = useState<Connection>({ state: "checking" })

  useEffect(() => {
    const controller = new AbortController()
    getBackendStatus(controller.signal).then(
      (backend) => setConnection({ state: "connected", backend }),
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setConnection({
            state: "unavailable",
            message: error instanceof Error ? error.message : "Could not reach Haxy. Try again once the server is running.",
          })
        }
      },
    )
    return () => controller.abort()
  }, [attempt])

  function reconnect() {
    setConnection({ state: "checking" })
    setAttempt((value) => value + 1)
  }

  const connected = connection.state === "connected"
  const checking = connection.state === "checking"

  return (
    <div className="min-h-screen">
      <header className="border-b bg-card">
        <div className="mx-auto flex h-20 max-w-5xl items-center justify-between px-6 sm:px-10">
          <a href="/" aria-label="Haxy home" className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground"><GitBranch size={21} /></span>
            <span className="text-xl font-bold tracking-tight">haxy<span className="text-primary">.</span></span>
          </a>
          <span className="rounded-full border px-3 py-1 text-xs text-muted-foreground">Web preview</span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-16 sm:px-10 sm:py-24">
        <p className="mb-5 text-xs font-semibold tracking-[0.2em] text-primary uppercase">Your code. Your forge.</p>
        <h1 className="max-w-xl text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">A new home for<br />your local forge.</h1>
        <p className="mt-5 max-w-lg text-lg leading-relaxed text-muted-foreground">Haxy’s web interface starts here. Connect to your running forge to get started.</p>

        <Card className="mt-12 max-w-2xl shadow-sm">
          <CardHeader className="border-b">
            <div className="flex items-center justify-between gap-4">
              <CardTitle>Forge connection</CardTitle>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className={`size-2 rounded-full ${connected ? "bg-emerald-600" : checking ? "animate-pulse bg-amber-500" : "bg-muted-foreground"}`} />
                {connected ? "Connected" : checking ? "Checking" : "Offline"}
              </span>
            </div>
            <CardDescription>Your local Haxy server</CardDescription>
          </CardHeader>
          <CardContent className="pt-6">
            <div role="status" aria-live="polite" className="flex gap-4">
              <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-secondary text-primary">
                {checking ? <LoaderCircle className="animate-spin" size={21} /> : connected ? <Check size={21} /> : <Unplug size={21} />}
              </span>
              <div>
                <h2 className="font-medium">{connected ? "Your forge is ready" : checking ? "Connecting to your forge…" : "Waiting for your forge"}</h2>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  {connection.state === "connected" ? `Connected in ${connection.backend.mode} mode. Repository and issue screens are the next step.` : connection.state === "unavailable" ? connection.message : "Checking the connection to your Haxy server."}
                </p>
              </div>
            </div>
            <div className="mt-7 flex flex-wrap items-center justify-between gap-4 border-t pt-5">
              <p className="text-xs text-muted-foreground">Start Haxy first, then connect here.</p>
              <Button variant="outline" onClick={reconnect} disabled={checking}>
                <RefreshCw className={checking ? "animate-spin" : ""} />
                {checking ? "Checking…" : connected ? "Check again" : "Retry connection"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="mt-8 flex max-w-2xl flex-wrap items-center justify-between gap-4 text-xs text-muted-foreground">
          <p>Local-first. Built around your repository.</p>
          <Button asChild variant="link" size="sm" className="h-auto p-0 text-xs text-muted-foreground">
            <a href="https://github.com/xit-vcs" target="_blank" rel="noreferrer">Explore the project <ArrowUpRight /></a>
          </Button>
        </div>
      </main>
    </div>
  )
}
