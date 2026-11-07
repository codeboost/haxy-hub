import { useEffect, useRef, useState, type FormEvent } from "react"
import { useNavigate } from "react-router"
import { LoaderCircle, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FailureMessage, TextField, failureOf, type Failure } from "@/components/form"
import { ViewerChangedError } from "@/lib/api"
import { deleteFork, forkConfirmText, forkExistsFor, type ForkSummary } from "@/lib/forks"
import type { ForkLocator } from "@/lib/repo"
import { useWrite } from "@/pages/settings/shared"
import { UnknownOutcome, type Uncertain } from "@/pages/settings/DeleteRepo"

function userPage(fork: ForkLocator): string {
  return `/users/${encodeURIComponent(fork.forker)}`
}

/** A deletion and the checks that settle it, one at a time; an unknown outcome is settled by reading the fork again. */
function useDeletion(fork: ForkLocator, viewer: string) {
  const navigate = useNavigate()
  const [failure, setFailure] = useState<Failure | null>(null)
  const [uncertain, setUncertain] = useState<Uncertain | null>(null)
  const write = useWrite<never>()

  async function probe(cause: string, current: () => boolean) {
    setUncertain({ cause, check: "checking" })
    let found: Uncertain
    try {
      found = { cause, check: (await forkExistsFor(fork, viewer)) ? "exists" : "gone" }
    } catch (error) {
      found = error instanceof ViewerChangedError ? { cause, check: "viewer", failure: failureOf(error, ""), now: error.viewer } : { cause, check: "unchecked" }
    }
    if (current()) setUncertain(found)
  }

  function run(fields: { confirm: string; password: string }, onRefused: () => void) {
    if (uncertain !== null && uncertain.check !== "exists") return
    void write.start(async (current) => {
      setFailure(null)
      setUncertain(null)
      try {
        await deleteFork(fork, viewer, fields)
        if (current()) void navigate(userPage(fork), { replace: true })
      } catch (error) {
        if (!current()) return
        onRefused()
        const failed = failureOf(error, "Deleting the fork failed.")
        if (failed.unknown) await probe(failed.cause, current)
        else setFailure(failed)
      }
    })
  }

  const check = () => { if (uncertain) void write.start((current) => probe(uncertain.cause, current)) }
  return { failure, uncertain, busy: write.busy, run, check }
}

/** The deletion form: `forker:name` typed exactly and the forker's password, then the fork goes. */
function DeleteForm({ fork, viewer }: { fork: ForkLocator; viewer: string }) {
  const confirmText = forkConfirmText(fork)
  const [confirm, setConfirm] = useState("")
  const [password, setPassword] = useState("")
  const passwordInput = useRef<HTMLInputElement>(null)
  const { failure, uncertain, busy, run, check } = useDeletion(fork, viewer)

  useEffect(() => {
    if (failure && !busy) passwordInput.current?.focus()
  }, [failure, busy])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // keep the typed name, never the password
    run({ confirm, password }, () => setPassword(""))
  }

  return (
    <form aria-label="Delete fork" className="mt-5 max-w-sm space-y-4" onSubmit={submit} noValidate>
      {failure && <FailureMessage failure={failure} />}
      {uncertain && <UnknownOutcome uncertain={uncertain} userPage={userPage(fork)} back="Back to your forks" label="The fork" onCheck={check} />}
      <fieldset disabled={busy} className="space-y-4 disabled:opacity-60">
        <TextField label={`Type ${confirmText} to confirm`} name="confirm" value={confirm} onValue={setConfirm} error={failure?.fields.confirm}
          autoComplete="off" autoCapitalize="none" spellCheck={false} />
        <TextField ref={passwordInput} label="Password" name="password" type="password" value={password} onValue={setPassword} error={failure?.fields.password}
          autoComplete="current-password" />
      </fieldset>
      {uncertain?.check !== "gone" && (
        <Button type="submit" variant="destructive" disabled={busy || (uncertain !== null && uncertain.check !== "exists")}>
          {busy ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
          Permanently delete this fork
        </Button>
      )}
    </form>
  )
}

/**
 * Deletes the fork behind Haxy's safeguards (`ui.Delete.perform`): its forker
 * only, with `forker:name` typed exactly and their password. Says first what
 * goes with it.
 */
export function DeleteFork({ fork, summary, viewer }: { fork: ForkLocator; summary: ForkSummary; viewer: string | null }) {
  const deletion = summary.actions.delete
  return (
    <section aria-labelledby="delete-fork-heading" className="mt-6 max-w-xl rounded-xl border border-destructive/40 p-6">
      <h2 id="delete-fork-heading" className="text-xl font-semibold text-destructive">Delete fork</h2>
      <div className="mt-3 space-y-2 text-sm text-muted-foreground">
        <p>
          This permanently deletes the fork <strong className="text-foreground">{fork.forker}/{fork.name}</strong> and everything pushed to it.
          {summary.draft ? " Its draft goes with it." : " Its patch stays, but can't be merged or pushed to any more."}
        </p>
        <p>Copies people have already cloned keep what they hold. This can't be undone.</p>
      </div>
      {!deletion.available || viewer === null
        ? <p role="status" className="mt-5 text-sm">{deletion.available ? "Log in as the fork's owner to delete it." : deletion.reason.message}</p>
        : <DeleteForm fork={fork} viewer={viewer} />}
    </section>
  )
}
