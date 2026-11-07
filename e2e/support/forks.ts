import { writeFile } from "node:fs/promises"
import path from "node:path"
import type { PlaywrightWorkerArgs } from "@playwright/test"
import { writeHeaders } from "./accounts"
import type { Backend } from "./backend"
import { bob, draftsRepo } from "./drafts"
import { sshUser } from "./ssh"

type Command = { action: "push" | "clone" | "merge"; url: string }

/**
 * On a server launched with `{ ssh: true }`: bob's draft of alice's public
 * `parser`, from a new fork he pushed one commit (adding PARSER.md) to over
 * SSH. Returns everyone's request contexts, the draft's id, the fork's base
 * and head commits, and the fork's API path.
 */
export async function bobsFork(playwright: PlaywrightWorkerArgs["playwright"], backend: Backend, hubUrl: string, title = "Document the parser") {
  const { owner, other, repo } = await draftsRepo(playwright, backend, hubUrl)
  const started = await other.post(`${hubUrl}/api/v1/repos/alice/parser/patches/drafts`, {
    headers: { ...(await writeHeaders(other, hubUrl)), "Content-Type": "application/json" },
    data: { title, target: "branch:main" },
  })
  if (started.status() !== 201) throw new Error(`Starting the draft failed: HTTP ${started.status()} ${await started.text()}`)
  const draft: { id: string; commands: Command[] } = await started.json()
  const push = draft.commands.find((command) => command.action === "push")
  if (!push) throw new Error("The draft offers no push command.")
  const git = await sshUser(backend, hubUrl, other, bob.name)
  const work = await git.workTree("fork", "main", [])
  await git.git(work, "pull", "--quiet", push.url, "patch")
  const base = (await git.git(work, "rev-parse", "HEAD")).trim()
  await writeFile(path.join(work, "PARSER.md"), "How the parser works.\n")
  await git.git(work, "add", "PARSER.md")
  await git.git(work, "commit", "--quiet", "-m", "Document the parser")
  await git.git(work, "push", "--quiet", push.url, "HEAD:patch")
  const head = (await git.git(work, "rev-parse", "HEAD")).trim()
  return { owner, forker: other, repo, id: draft.id, base, head, fork: `/api/v1/forks/bobby/parser/${draft.id}` }
}
