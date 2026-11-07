import { CommandList } from "@/components/GitCommands"
import type { ForkCommand } from "@/lib/drafts"

const purposes: Record<ForkCommand["action"], { title: string; purpose: string }> = {
  push: { title: "Push to this {noun} from an existing repository", purpose: "push" },
  clone: { title: "Clone this {noun}", purpose: "clone" },
  merge: { title: "Merge this {noun} locally", purpose: "merge" },
}

/**
 * The Git commands for the fork a draft (or a patch published from one)
 * lives in, as the server's transport settings build them, each to copy.
 */
export function ForkCommands({ commands, noun }: { commands: ForkCommand[]; noun: "draft" | "patch" | "fork" }) {
  return (
    <>
      {commands.map((command) => (
        <CommandList key={command.action} title={purposes[command.action].title.replace("{noun}", noun)} commands={[command]} purpose={purposes[command.action].purpose} />
      ))}
    </>
  )
}
