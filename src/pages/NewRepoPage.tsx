import { useId, useRef, useState, type FormEvent, type ReactNode } from "react"
import { Link, useLocation, useNavigate, useSearchParams } from "react-router"
import { LoaderCircle, Plus, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FailureMessage, FormMessage, TextField, failureOf, type Failure } from "@/components/form"
import { UnavailableState } from "@/components/listing"
import { useConnection } from "@/app/connection"
import { useSession } from "@/app/session"
import { ApiError } from "@/lib/api"
import type { RepoAccess } from "@/lib/discovery"
import { repoRoute } from "@/lib/repo"
import { createRepo, hashFormats, repoExists, type HashFormat } from "@/lib/repoCreate"
import { loginPath } from "@/lib/session"
import { useStillHere } from "@/lib/stillHere"

const linkClass = "font-medium underline underline-offset-4"

/** `/repos/new`: creates a repository for the signed-in viewer, empty or as a copy of one they can read. */
export function NewRepoPage() {
  const { check } = useConnection()
  const { viewer } = useSession()
  const location = useLocation()

  if (check?.kind === "connected" && check.status.mode === "local") {
    return <UnavailableState title="New repository">Local mode serves a single repository without accounts, so it can't create others.</UnavailableState>
  }
  if (!viewer) {
    return (
      <section className="max-w-md">
        <h1 className="text-2xl font-semibold tracking-tight">New repository</h1>
        <p className="mt-3 text-muted-foreground">
          <Link to={loginPath(location.pathname + location.search)} className="text-primary underline-offset-4 hover:underline">Log in</Link> to create a repository.
        </p>
      </section>
    )
  }
  return <NewRepoForm viewer={viewer.name} />
}

type Choice<T extends string> = { value: T; label: string; hint: string }

const accessChoices: Choice<RepoAccess>[] = [
  { value: "private", label: "Private", hint: "Only you and the members you add can see it." },
  { value: "public", label: "Public", hint: "Anyone can see and clone it." },
]

const hashLabels: Record<HashFormat, Choice<HashFormat>> = {
  sha1: { value: "sha1", label: "SHA-1", hint: "Works with every Git client." },
  sha256: { value: "sha256", label: "SHA-256", hint: "Needs Git 2.29 or later, and Git hosts that support it." },
}

/** A labelled group of radio buttons that shows its field error beside it. */
export function RadioGroup<T extends string>({ legend, name, choices, value, onValue, disabled, error, hint }: {
  legend: string
  name: string
  choices: Choice<T>[]
  value: T
  onValue(value: T): void
  disabled?: boolean
  error?: string
  hint?: ReactNode
}) {
  const id = useId()
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(" ")
  return (
    <fieldset aria-describedby={describedBy || undefined} aria-invalid={error ? true : undefined} disabled={disabled} className="disabled:opacity-60">
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="mt-1.5 space-y-2">
        {choices.map((choice) => (
          <label key={choice.value} className="flex items-start gap-2.5 text-sm">
            <input type="radio" name={name} value={choice.value} checked={value === choice.value} onChange={() => onValue(choice.value)}
              aria-describedby={`${id}-${choice.value}`} className="mt-0.5 accent-primary" />
            <span>
              <span className="font-medium">{choice.label}</span>
              <span id={`${id}-${choice.value}`} className="block text-xs text-muted-foreground">{choice.hint}</span>
            </span>
          </label>
        ))}
      </div>
      {hint && <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      {error && <p id={`${id}-error`} className="mt-1 text-xs text-destructive">{error}</p>}
    </fieldset>
  )
}

/**
 * A creation whose outcome is unknown (timeout, lost connection, internal
 * error, unreadable answer). The name is the operation's identity — a second
 * creation with it is refused as taken — so what can be said is only whether
 * a repository by that name exists now, never what this attempt did: a copy
 * may still be running when the check finds nothing, and a repository that
 * already existed looks the same as one this attempt made.
 */
type Uncertain = {
  cause: string
  owner: string
  name: string
  check: "checking" | "exists" | "missing" | "unchecked"
}

function NewRepoForm({ viewer }: { viewer: string }) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [access, setAccess] = useState<RepoAccess>("private")
  const [hash, setHash] = useState<HashFormat>("sha1")
  const [copy, setCopy] = useState(params.get("copy") ?? "")
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [uncertain, setUncertain] = useState<Uncertain | null>(null)
  const copying = copy.length > 0
  // What is known is about one owner's name: editing the name (or another
  // viewer) sets it aside, and editing it back brings it back.
  const current = uncertain !== null && uncertain.owner === viewer && uncertain.name === name ? uncertain : null
  // A request still running when the form goes away (the user moved on or
  // logged out) finishes without touching the page they are on now.
  const mounted = useStillHere()

  // Bumped by every attempt and every check: an answer that arrives after a
  // newer one started (a check of an earlier name, or an earlier check of
  // this one) describes a superseded operation and changes nothing.
  const generation = useRef(0)
  const begin = () => ++generation.current
  const isLatest = (started: number) => mounted.current && started === generation.current

  async function check(subject: Uncertain) {
    const started = begin()
    setUncertain({ ...subject, check: "checking" })
    let found: Uncertain["check"]
    try {
      found = await repoExists(subject.owner, subject.name) ? "exists" : "missing"
    } catch {
      found = "unchecked"
    }
    if (isLatest(started)) setUncertain({ ...subject, check: found })
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // For the same name, a retry is offered only once a check found nothing.
    if (pending || (current !== null && current.check !== "missing")) return
    const retrying = current
    const started = begin()
    setPending(true)
    setFailure(null)
    setUncertain(null)
    try {
      const created = await createRepo(viewer, { name, description, access, hash, copy })
      if (isLatest(started)) await navigate(repoRoute({ kind: "server", owner: created.owner, name: created.name }))
    } catch (error) {
      if (!isLatest(started)) return
      setPending(false)
      // Retrying an uncertain creation, a taken name is the repository
      // existing now (perhaps the first attempt's), not a mistake in the form.
      if (retrying && error instanceof ApiError && error.code === "conflict" && error.fieldError("name") !== undefined) {
        setUncertain({ ...retrying, check: "exists" })
        return
      }
      // Every field is kept: none is secret.
      const failed = failureOf(error, "Creating the repository failed.")
      if (failed.unknown) await check({ cause: failed.cause, owner: viewer, name, check: "checking" })
      else setFailure(failed)
    }
  }

  const fields = failure?.fields ?? {}
  return (
    <section className="max-w-lg">
      <h1 className="text-2xl font-semibold tracking-tight">New repository</h1>
      <p className="mt-3 text-sm text-muted-foreground">Owned by <strong className="text-foreground">{viewer}</strong>.</p>
      <form aria-label="New repository" className="mt-8 space-y-6" onSubmit={submit} noValidate>
        {failure && <FailureMessage failure={failure} />}
        {current && <UnknownOutcome uncertain={current} onCheck={() => void check(current)} />}
        <TextField label="Name" name="name" value={name} onValue={setName} error={fields.name} autoComplete="off" autoCapitalize="none" spellCheck={false} required
          hint="Letters, digits, hyphens, underscores and dots." />
        <TextField label="Description" name="description" value={description} onValue={setDescription} error={fields.description} autoComplete="off" />
        <RadioGroup<RepoAccess> legend="Visibility" name="access" choices={accessChoices} value={access} onValue={setAccess} error={fields.access} />
        <TextField label="Copy from (optional)" name="copy" value={copy} onValue={setCopy} error={fields.copy} placeholder="owner:name"
          autoComplete="off" autoCapitalize="none" spellCheck={false}
          hint="A repository you can read, as owner:name. The copy starts with its files and history, without its issues, discussions or patches." />
        <RadioGroup<HashFormat> legend="Hash format" name="hash" choices={hashFormats.map((format) => hashLabels[format])} value={hash} onValue={setHash} error={fields.hash}
          disabled={copying} hint={copying ? "A copy keeps the hash format of the repository it copies." : undefined} />
        {current?.check !== "exists" && (
          <Button type="submit" disabled={pending || (current !== null && current.check !== "missing")}>
            {pending ? <LoaderCircle className="animate-spin" /> : <Plus />}
            Create repository
          </Button>
        )}
      </form>
    </section>
  )
}

function UnknownOutcome({ uncertain, onCheck }: { uncertain: Uncertain; onCheck(): void }) {
  const label = `${uncertain.owner}/${uncertain.name}`
  const lead = `Haxy couldn't confirm what happened to this request (${uncertain.cause}).`
  const checkAgain = <Button type="button" variant="outline" size="sm" className="mt-2 flex" onClick={onCheck}><RefreshCw />Check again</Button>
  let body: ReactNode
  switch (uncertain.check) {
    case "checking":
      body = <>{lead} Checking whether {label} exists…</>
      break
    case "exists":
      body = (
        <>
          {lead} A repository named {label} exists now (it may or may not be from this attempt).{" "}
          <Link to={repoRoute({ kind: "server", owner: uncertain.owner, name: uncertain.name })} className={linkClass}>Open {label}</Link>
        </>
      )
      break
    case "missing":
      body = <>{lead} Haxy didn't find {label}, but a copy may still be finishing. Check again, or try again: if the name is taken by then, the repository exists.{checkAgain}</>
      break
    case "unchecked":
      body = <>{lead} Haxy couldn't say whether it exists either, so check before trying again.{checkAgain}</>
      break
  }
  return <FormMessage kind="error"><p>{body}</p></FormMessage>
}
