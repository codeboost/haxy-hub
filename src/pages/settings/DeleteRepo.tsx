import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"
import { Link, useNavigate } from "react-router"
import { LoaderCircle, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FailureMessage, FormMessage, TextField, failureOf, type Failure } from "@/components/form"
import { ViewerChangedError } from "@/lib/api"
import { deleteRepo, repoExistsFor, type AdminRepo, type RepoSettings } from "@/lib/repoAdmin"
import { linkClass, useWrite } from "./shared"

/**
 * A deletion whose outcome is unknown: what can be said is only whether the
 * repository exists now, never what this attempt did.
 */
type Uncertain = { cause: string; check: "checking" | "gone" | "exists" | "unchecked" } | { cause: string; check: "viewer"; failure: Failure }

/**
 * Deletes the repository behind Haxy's safeguards (`ui.Delete.perform`): its
 * main owner only, with `owner:name` typed exactly and their password. Says
 * first what goes with it.
 */
export function DeleteRepo({ repo, viewer, settings }: { repo: AdminRepo; viewer: string; settings: RepoSettings }) {
  const navigate = useNavigate()
  const confirmText = `${repo.owner}:${repo.name}`
  const [confirm, setConfirm] = useState("")
  const [password, setPassword] = useState("")
  const [failure, setFailure] = useState<Failure | null>(null)
  const [uncertain, setUncertain] = useState<Uncertain | null>(null)
  const passwordInput = useRef<HTMLInputElement>(null)
  // the deletion and the checks that settle it run one at a time; the
  // fields take no edits meanwhile
  const write = useWrite<never>()
  const userPage = `/users/${encodeURIComponent(repo.owner)}`

  // after a refusal, back to the password, once the fields take edits again
  useEffect(() => {
    if (failure && !write.busy) passwordInput.current?.focus()
  }, [failure, write.busy])

  async function probe(cause: string, current: () => boolean) {
    setUncertain({ cause, check: "checking" })
    let found: Uncertain
    try {
      found = { cause, check: (await repoExistsFor(repo, viewer)) ? "exists" : "gone" }
    } catch (error) {
      // the probe answered for someone else: it says nothing about this deletion
      found = error instanceof ViewerChangedError ? { cause, check: "viewer", failure: failureOf(error, "") } : { cause, check: "unchecked" }
    }
    if (current()) setUncertain(found)
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // after an unknown outcome, another attempt waits until Haxy says the repository still exists
    if (uncertain !== null && uncertain.check !== "exists") return
    void write.start(async (current) => {
      setFailure(null)
      setUncertain(null)
      try {
        await deleteRepo(repo, viewer, { confirm, password })
        if (current()) void navigate(userPage, { replace: true })
      } catch (error) {
        if (!current()) return
        // keep the typed name, never the password
        setPassword("")
        const failed = failureOf(error, "Deleting the repository failed.")
        if (failed.unknown) await probe(failed.cause, current)
        else setFailure(failed)
      }
    })
  }

  const deletion = settings.actions.delete
  return (
    <section aria-labelledby="delete-heading" className="max-w-xl rounded-xl border border-destructive/40 p-6">
      <h2 id="delete-heading" className="text-xl font-semibold text-destructive">Delete repository</h2>
      <div className="mt-3 space-y-2 text-sm text-muted-foreground">
        <p>
          This permanently deletes <strong className="text-foreground">{repo.owner}/{repo.name}</strong>: its files and history, every branch and tag,
          its issues, discussions and patches, and the access it gives its members.
        </p>
        <p>Copies people have already cloned keep what they hold. This can't be undone.</p>
      </div>
      {!deletion.available ? (
        <p role="status" className="mt-5 text-sm">{deletion.reason.message}</p>
      ) : (
        <form aria-label="Delete repository" className="mt-5 max-w-sm space-y-4" onSubmit={submit} noValidate>
          {failure && <FailureMessage failure={failure} />}
          {uncertain && <UnknownOutcome uncertain={uncertain} userPage={userPage} label={`${repo.owner}/${repo.name}`} onCheck={() => void write.start((current) => probe(uncertain.cause, current))} />}
          <fieldset disabled={write.busy} className="space-y-4 disabled:opacity-60">
            <TextField label={`Type ${confirmText} to confirm`} name="confirm" value={confirm} onValue={setConfirm} error={failure?.fields.confirm}
              autoComplete="off" autoCapitalize="none" spellCheck={false} />
            <TextField ref={passwordInput} label="Password" name="password" type="password" value={password} onValue={setPassword} error={failure?.fields.password}
              autoComplete="current-password" />
          </fieldset>
          {uncertain?.check !== "gone" && (
            <Button type="submit" variant="destructive" disabled={write.busy || (uncertain !== null && uncertain.check !== "exists")}>
              {write.busy ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              Permanently delete this repository
            </Button>
          )}
        </form>
      )}
    </section>
  )
}

function UnknownOutcome({ uncertain, userPage, label, onCheck }: { uncertain: Uncertain; userPage: string; label: string; onCheck(): void }) {
  const lead = `Haxy couldn't confirm what happened to this request (${uncertain.cause}).`
  const checkAgain = <Button type="button" variant="outline" size="sm" className="mt-2 flex" onClick={onCheck}><RefreshCw />Check again</Button>
  let body: ReactNode
  switch (uncertain.check) {
    case "checking":
      body = <>{lead} Checking whether {label} still exists…</>
      break
    case "gone":
      body = <>{lead} {label} doesn't exist now. <Link to={userPage} className={linkClass}>Back to the owner's repositories</Link></>
      break
    case "exists":
      body = <>{lead} {label} still exists, so it wasn't deleted. Enter your password to try again.</>
      break
    case "unchecked":
      body = <>{lead} Haxy couldn't say whether it still exists either, so check before trying again.{checkAgain}</>
      break
    case "viewer":
      return <FailureMessage failure={uncertain.failure}>{lead} {uncertain.failure.message}</FailureMessage>
  }
  return <FormMessage kind="error"><p>{body}</p></FormMessage>
}
