import { useEffect, useState, type FormEvent } from "react"
import { useLocation, useNavigate } from "react-router"
import { LoaderCircle, RefreshCw, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FailureMessage, FormMessage, TextField, failureOf, type Failure } from "@/components/form"
import type { RepoAccess } from "@/lib/discovery"
import { changeSettings, getSettings, type AdminRepo, type RepoSettings, type SettingsChange, type ThreadRole } from "@/lib/repoAdmin"
import { RadioGroup } from "@/pages/NewRepoPage"
import { lostAccess, useLeaveSettings, useWrite } from "./shared"
import { Unresolved } from "./Unresolved"

type Choice<T extends string> = { value: T; label: string; hint: string }

const accessChoices: Choice<RepoAccess>[] = [
  { value: "private", label: "Private", hint: "Only owners and the members they add can see it." },
  { value: "public", label: "Public", hint: "Anyone can see and clone it." },
]

const roleChoices: Choice<ThreadRole>[] = [
  { value: "nobody", label: "Nobody", hint: "Turned off: the section is hidden." },
  { value: "members", label: "Members", hint: "Owners and members." },
  { value: "anybody", label: "Anybody", hint: "Anyone signed in who can read the repository." },
]

const threadKinds = [
  { field: "discuss_role", legend: "Who can start discussions" },
  { field: "issue_role", legend: "Who can open issues" },
  { field: "patch_role", legend: "Who can propose patches" },
] as const

const hashLabels: Record<RepoSettings["hash"], string> = { sha1: "SHA-1", sha256: "SHA-256" }

function changeOf(settings: RepoSettings): SettingsChange {
  return { description: settings.description, access: settings.access, discuss_role: settings.discuss_role, issue_role: settings.issue_role, patch_role: settings.patch_role }
}

function sameChange(a: SettingsChange, b: SettingsChange): boolean {
  return a.description === b.description && a.access === b.access && a.discuss_role === b.discuss_role && a.issue_role === b.issue_role && a.patch_role === b.patch_role
}

/**
 * What the page says once a save was answered, or settled after an unknown
 * outcome. `stale`: another change of the settings landed since the form was
 * loaded, so Haxy refused to save over it.
 */
type Outcome =
  | { kind: "saved" }
  | { kind: "failed"; failure: Failure }
  | { kind: "stale"; message: string }
  | { kind: "uncertain"; message: string }

/** A save whose outcome is unknown and that a read couldn't settle (see `useWrite`). */
type UnknownSave = { cause: string; submitted: SettingsChange; from: RepoSettings }

/**
 * The description, visibility and who may start each kind of thread; the
 * hash format, shown read-only. A save names the revision of the settings the
 * form was loaded from (`base`), so it never overwrites a change it didn't
 * show; while untouched, the form follows the settings Haxy sends. The fields
 * take no edits while a save or check runs or a save is unresolved, so what a
 * completion shows never replaces an edit.
 */
export function GeneralSettings({ repo, viewer, settings }: { repo: AdminRepo; viewer: string; settings: RepoSettings }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [base, setBase] = useState<RepoSettings>(settings)
  const [change, setChange] = useState<SettingsChange>(() => changeOf(settings))
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const write = useWrite<UnknownSave>()
  const leave = useLeaveSettings()
  const set = <K extends keyof SettingsChange>(field: K) => (value: SettingsChange[K]) => setChange((previous) => ({ ...previous, [field]: value }))
  const pristine = sameChange(change, changeOf(base))

  // Fresh settings (read again on each navigation) replace an untouched form;
  // an edited one keeps its edits, and saving them is refused if they're
  // stale. Settings that arrive during a save were read before it settled, so
  // they're dropped: the repository is read again once a save lands.
  useEffect(() => {
    if (settings.revision === base.revision || !pristine || write.blocked) return
    setBase(settings)
    setChange(changeOf(settings))
  }, [settings])

  function show(now: RepoSettings) {
    setBase(now)
    setChange(changeOf(now))
  }

  // replaces the edits, which the user asked for
  const loadCurrent = () => write.start(async (current) => {
    try {
      const now = await getSettings(repo)
      if (!current()) return
      show(now)
      setOutcome(null)
    } catch (error) {
      if (current()) setOutcome({ kind: "failed", failure: failureOf(error, "Loading the settings failed.") })
    }
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const submitted = change
    const from = base
    void write.start(async (current) => {
      setOutcome(null)
      try {
        const saved = await changeSettings(repo, viewer, { ...submitted, revision: from.revision })
        if (!current()) return
        show(saved)
        setOutcome({ kind: "saved" })
        // read the repository again, so its header and sections show the change
        void navigate(location.pathname + location.search, { replace: true })
      } catch (error) {
        if (!current()) return
        const failure = failureOf(error, "Saving the settings failed.")
        if (failure.fields.revision !== undefined) setOutcome({ kind: "stale", message: failure.fields.revision })
        else if (!failure.unknown) setOutcome({ kind: "failed", failure })
        else await settle({ cause: failure.cause, submitted, from }, current)
      }
    })
  }

  /**
   * Haxy may or may not have saved `unknown.submitted`: say what it holds
   * now, never what this attempt did, and keep what was entered to save
   * again. When Haxy can't say either, the save stays unresolved.
   */
  async function settle(unknown: UnknownSave, current: () => boolean) {
    const { cause, submitted, from } = unknown
    let now: RepoSettings
    try {
      now = await getSettings(repo)
    } catch (error) {
      if (!current()) return
      // no longer an owner (perhaps by another owner's hand), or the
      // repository is gone: that is the answer, which the settings then say
      if (lostAccess(error)) {
        write.setUnresolved(null)
        leave()
      } else write.setUnresolved(unknown)
      return
    }
    if (!current()) return
    write.setUnresolved(null)
    if (sameChange(changeOf(now), submitted)) {
      show(now)
      setOutcome({ kind: "uncertain", message: `${cause} Haxy's settings match what you submitted now, so they are saved.` })
      // read the repository again, so its header and sections show them, as after a confirmed save
      void navigate(location.pathname + location.search, { replace: true })
    } else if (now.revision === from.revision) {
      setOutcome({ kind: "uncertain", message: `${cause} Haxy's settings are as you loaded them, so yours weren't saved. Save again to apply them.` })
    } else {
      setOutcome({ kind: "stale", message: `${cause} Another change of these settings landed since you loaded them, so yours weren't saved.` })
    }
  }

  const fields = outcome?.kind === "failed" ? outcome.failure.fields : {}
  return (
    <section aria-labelledby="general-heading" className="max-w-xl">
      <h2 id="general-heading" className="text-xl font-semibold">General</h2>
      <form aria-label="Repository settings" className="mt-6 space-y-6" onSubmit={submit} noValidate>
        {outcome?.kind === "failed" && <FailureMessage failure={outcome.failure} />}
        {outcome?.kind === "uncertain" && <FormMessage kind="error">{outcome.message}</FormMessage>}
        {write.unresolved && (
          <Unresolved message={`${write.unresolved.cause} Haxy couldn't say what the settings are now either, so saving waits until a check gets an answer.`}
            pending={write.busy} onCheck={() => void write.check((unknown, current) => settle(unknown, current))} />
        )}
        {outcome?.kind === "stale" && (
          <FormMessage kind="error">
            <p>{outcome.message} Loading the current settings replaces your edits.</p>
            <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void loadCurrent()} disabled={write.blocked}><RefreshCw />Load the current settings</Button>
          </FormMessage>
        )}
        {outcome?.kind === "saved" && <FormMessage kind="success">Settings saved.</FormMessage>}
        {/* no edits while a save or check runs or a save is unresolved: what it then shows replaces none */}
        <fieldset disabled={write.blocked} className="space-y-6 disabled:opacity-60">
          <TextField label="Description" name="description" value={change.description} onValue={set("description")} error={fields.description} autoComplete="off" />
          <RadioGroup<RepoAccess> legend="Visibility" name="access" choices={accessChoices} value={change.access} onValue={set("access")} error={fields.access} />
          {threadKinds.map((kind) => (
            <RadioGroup<ThreadRole> key={kind.field} legend={kind.legend} name={kind.field} choices={roleChoices} value={change[kind.field]} onValue={set(kind.field)} error={fields[kind.field]} />
          ))}
        </fieldset>
        <div>
          <p className="text-sm font-medium">Hash format</p>
          <p className="mt-1.5 text-sm">
            <span aria-label="Hash format" className="font-mono">{hashLabels[settings.hash] ?? settings.hash}</span>
            <span className="block text-xs text-muted-foreground">Chosen when the repository was created; it can't be changed.</span>
          </p>
        </div>
        <Button type="submit" disabled={write.blocked}>
          {write.busy ? <LoaderCircle className="animate-spin" /> : <Save />}
          Save settings
        </Button>
      </form>
    </section>
  )
}
