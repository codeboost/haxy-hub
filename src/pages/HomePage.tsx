import { useConnection } from "@/app/connection"

export function HomePage() {
  const { check } = useConnection()
  const mode = check?.kind === "connected" ? check.status.mode : null
  return (
    <>
      <p className="mb-5 text-xs font-semibold tracking-[0.2em] text-primary uppercase">Your code. Your forge.</p>
      <h1 className="max-w-xl text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">Haxy Hub</h1>
      <p className="mt-5 max-w-lg text-lg leading-relaxed text-muted-foreground">
        {mode === "local"
          ? "Connected to Haxy serving a local repository. Server accounts, notifications and administration are not available in local mode."
          : "Connected to a multi-user Haxy server."}
      </p>
      <p className="mt-3 max-w-lg text-sm text-muted-foreground">Repository, issue and patch screens are not implemented yet.</p>
    </>
  )
}
