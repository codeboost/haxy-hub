import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useConnection } from "@/app/connection"

export function ConnectionPage() {
  const { check, checking, retry } = useConnection()
  if (check?.kind !== "connected") return null
  const { status } = check
  return (
    <section className="max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">Connection</h1>
      <p className="mt-3 text-muted-foreground">Haxy Hub reaches Haxy through its own server, which proxies <code>/api/</code> requests to the configured backend.</p>
      <dl className="mt-8 grid grid-cols-[max-content_1fr] gap-x-8 gap-y-3 rounded-xl border bg-card p-6 text-sm shadow-sm">
        <dt className="text-muted-foreground">Status</dt>
        <dd>Connected</dd>
        <dt className="text-muted-foreground">Mode</dt>
        <dd>{status.mode === "server" ? "Server (multi-user)" : "Local (single repository)"}</dd>
        <dt className="text-muted-foreground">API version</dt>
        <dd>{status.api_version}</dd>
      </dl>
      <Button className="mt-6" variant="outline" onClick={retry} disabled={checking}>
        <RefreshCw className={checking ? "animate-spin" : ""} />
        {checking ? "Checking…" : "Check again"}
      </Button>
    </section>
  )
}
