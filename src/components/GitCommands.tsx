import { useState } from "react"
import { ChevronDown, Code2, Copy } from "lucide-react"
import { Popover } from "radix-ui"
import { Button } from "@/components/ui/button"
import type { GitCommand } from "@/lib/repo"

const protocolLabel = { http: "HTTP", ssh: "SSH" } as const

/**
 * Git commands from the backend (built from its public transport settings),
 * each with a button that copies it to the clipboard.
 */
export function CommandList({ title, commands, purpose, framed = true }: { title: string; commands: GitCommand[]; purpose: string; framed?: boolean }) {
  const [copied, setCopied] = useState<{ command: string; ok: boolean } | null>(null)
  const copy = (command: string) => {
    navigator.clipboard.writeText(command).then(
      () => setCopied({ command, ok: true }),
      () => setCopied({ command, ok: false }),
    )
  }
  const headingId = `commands-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
  return (
    <section aria-labelledby={headingId} className={framed ? "mt-6 rounded-xl border bg-card p-4" : "p-3"}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={headingId} className="text-sm font-semibold">{title}</h2>
        <p role="status" className="text-xs text-muted-foreground">{copied ? (copied.ok ? "Copied" : "Couldn't copy; select the command instead.") : ""}</p>
      </div>
      <ul className="mt-3 space-y-2">
        {commands.map((command) => (
          <li key={command.command} className="flex items-start gap-2">
            <span className="mt-1.5 w-10 shrink-0 text-xs font-medium text-muted-foreground">{protocolLabel[command.protocol]}</span>
            <pre className="min-w-0 flex-1 overflow-x-auto rounded-md bg-secondary px-3 py-1.5 font-mono text-xs whitespace-pre-wrap break-all">{command.command}</pre>
            <Button variant="outline" size="icon-sm" aria-label={`Copy ${protocolLabel[command.protocol]} ${purpose} command`} onClick={() => copy(command.command)}>
              <Copy />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** A Code button that opens the clone commands. */
export function CloneButton({ commands }: { commands: GitCommand[] }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button size="sm"><Code2 />Code<ChevronDown /></Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="z-50 w-[36rem] max-w-[calc(100vw-2rem)] rounded-lg border bg-popover text-popover-foreground shadow-lg">
          <CommandList title="Clone" commands={commands} purpose="clone" framed={false} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
