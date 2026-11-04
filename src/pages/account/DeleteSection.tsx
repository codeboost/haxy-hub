import { useRef, useState, type FormEvent } from "react"
import { useNavigate } from "react-router"
import { LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FailureMessage, TextField, failureOf, type Failure } from "@/components/form"
import { useSession } from "@/app/session"
import { deleteAccount } from "@/lib/account"
import type { Count } from "@/lib/api"
import { listUserRepos } from "@/lib/discovery"
import { useResource } from "@/lib/resource"

function repositoryCount(count: Count): string | null {
  switch (count.kind) {
    case "exact": return count.value === 1 ? "You own 1 repository." : `You own ${count.value} repositories.`
    case "at_least": return `You own at least ${count.value} repositories.`
    case "unknown": return null
  }
}

/**
 * Deletes the viewer's account behind Haxy's safeguards: the account name typed
 * exactly, and the password. Says what goes with it first.
 */
export function DeleteSection({ name }: { name: string }) {
  const { changeSession } = useSession()
  const navigate = useNavigate()
  const repos = useResource(`delete repos ${name}`, (signal) => listUserRepos(name, { page_size: 1 }, { signal }))
  const [confirm, setConfirm] = useState("")
  const [password, setPassword] = useState("")
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const passwordInput = useRef<HTMLInputElement>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    setFailure(null)
    try {
      await changeSession(() => deleteAccount(name, { confirm, password }))
      await navigate("/", { replace: true })
    } catch (error) {
      // Keep the typed name, never the password. When the outcome is unknown
      // the session is read again (by changeSession): a deleted account shows
      // as signed out.
      setPassword("")
      setFailure(failureOf(error, "Deleting the account failed."))
      setPending(false)
      passwordInput.current?.focus()
    }
  }

  const count = repos.kind === "loaded" ? repositoryCount(repos.data.page.count) : null
  return (
    <section aria-labelledby="delete-heading" className="max-w-xl rounded-xl border border-destructive/40 p-6">
      <h2 id="delete-heading" className="text-xl font-semibold text-destructive">Delete account</h2>
      <div className="mt-3 space-y-2 text-sm text-muted-foreground">
        <p>
          This permanently deletes the account <strong className="text-foreground">{name}</strong> and every repository and fork you own, with all of their
          history, issues, discussions and patches. {count}
        </p>
        <p>You won't be able to log in again, your SSH keys stop working, and this can't be undone.</p>
      </div>
      <form className="mt-5 max-w-sm space-y-4" onSubmit={submit} noValidate>
        {failure && <FailureMessage failure={failure} />}
        <TextField label={`Type ${name} to confirm`} name="confirm" value={confirm} onValue={setConfirm} error={failure?.fields.confirm}
          autoComplete="off" autoCapitalize="none" spellCheck={false} required />
        <TextField ref={passwordInput} label="Password" name="password" type="password" value={password} onValue={setPassword} error={failure?.fields.password}
          autoComplete="current-password" required />
        <Button type="submit" variant="destructive" disabled={pending}>
          {pending && <LoaderCircle className="animate-spin" />}
          Permanently delete this account
        </Button>
      </form>
    </section>
  )
}
