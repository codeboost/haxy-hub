import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react"
import { useLocation, useNavigate } from "react-router"
import { LoaderCircle, Shield, ShieldOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FailureMessage, FormMessage, TextField, failureOf, type Failure } from "@/components/form"
import { FailureState, LoadingState } from "@/components/listing"
import { branchId, getBranches, protectBranch, setDefaultBranch, unprotectBranch, type AdminRepo, type BranchName, type RepoBranches } from "@/lib/repoAdmin"
import type { Page } from "@/lib/api"
import { listRefs, type RefId, type RefItem } from "@/lib/repo"
import { useResource } from "@/lib/resource"
import { lostAccess, useLeaveSettings, useWrite } from "./shared"
import { Unresolved } from "./Unresolved"

/**
 * What a change whose outcome was unknown turned out to be, from the branches
 * read again: something to say, that the viewer can no longer manage the
 * repository (itself the answer: see `lostAccess`), or "unknown" when Haxy
 * couldn't say.
 */
async function settle(repo: AdminRepo, cause: string, describe: (branches: RepoBranches) => string): Promise<{ said: string; now: RepoBranches } | "lost" | "unknown"> {
  try {
    const now = await getBranches(repo)
    return { said: `${cause} Haxy couldn't confirm the change; ${describe(now)} (which may or may not be from this attempt).`, now }
  } catch (error) {
    return lostAccess(error) ? "lost" : "unknown"
  }
}

/** Said while a change's outcome is unknown and a check couldn't settle it. */
const unsettled = (cause: string) => `${cause} Haxy couldn't confirm the change, or say what the branches are now, so it isn't offered again until a check gets an answer.`

/**
 * The default branch (what the repository page shows and clones check out)
 * and the protected branches (which can't be deleted or force-pushed; only
 * owners push to them directly, members change them by merging a patch).
 */
export function BranchesSettings({ repo, viewer }: { repo: AdminRepo; viewer: string }) {
  // a change reads the branches again in the background, keeping the forms and what they say
  const [version, setVersion] = useState(0)
  const branches = useResource(`repo branches ${repo.owner}/${repo.name}`, (signal) => getBranches(repo, { signal }), String(version))
  // what the pickers offer: the first page of branches, by Haxy's ids
  const choices = useResource(`repo branch choices ${repo.owner}/${repo.name}`, (signal) => listRefs(repo, "branch", { page_size: pickerSize }, { signal }), String(version))
  const offered = choices.kind === "loaded" ? choices.data : null
  const [notice, setNotice] = useState<string | null>(null)
  const uncertain = (message: string) => { setNotice(message); setVersion((value) => value + 1) }
  const done = () => { setNotice(null); setVersion((value) => value + 1) }

  return (
    <section aria-labelledby="branches-heading" className="max-w-2xl">
      <h2 id="branches-heading" className="text-xl font-semibold">Branches</h2>
      {notice && <p role="status" className="mt-4 rounded-md border px-3 py-2 text-sm text-muted-foreground">{notice}</p>}
      {branches.kind === "loading" && <LoadingState>Loading the branches…</LoadingState>}
      {branches.kind === "failed" && <FailureState title="Couldn't load the branches" error={branches.error} onRetry={branches.reload} />}
      {branches.kind === "loaded" && (
        <>
          <DefaultBranchForm repo={repo} viewer={viewer} current={branches.data.default_branch} offered={offered} onChanged={done} onUncertain={uncertain} />
          <h3 className="mt-10 font-semibold">Protected branches</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Protected branches can't be deleted or force-pushed. Owners can push to them directly; members can only change them by merging a patch.
          </p>
          <ProtectForm repo={repo} viewer={viewer} count={branches.data.protected.length} max={branches.data.max_protected} offered={offered} onChanged={done} onUncertain={uncertain} />
          {branches.data.protected.length === 0
            ? <p className="mt-4 text-sm text-muted-foreground">No branch is protected.</p>
            : (
              <ul aria-label="Protected branches" className="mt-4 divide-y rounded-xl border bg-card">
                {branches.data.protected.map((branch) => (
                  <ProtectedRow key={branch.id} repo={repo} viewer={viewer} branch={branch} onChanged={done} onUncertain={uncertain} />
                ))}
              </ul>
            )}
        </>
      )}
    </section>
  )
}

/** How many branches a picker lists; others are named by typing. */
const pickerSize = 100

/** The picker's choice that names a branch by typing it instead. */
const typedChoice = "other"

/**
 * One branch form: a picker over the repository's branches by their ids (so
 * a name that isn't UTF-8, shown with U+FFFD, is still sent exactly), with
 * typing a name as the fallback for a branch the picker doesn't list. `write`
 * sends the change for the chosen branch. Its completion counts only while
 * this form is still shown and its latest attempt: then `onDone` applies the
 * result (and says what changed), or an unknown outcome is settled by reading
 * the branches again and said through `onUncertain` as `describe` puts it.
 * `initial` is the branch first chosen; while the picker is untouched it
 * follows a new `initial` (the default branch changed elsewhere).
 */
function BranchForm({ repo, label, initial, baseline, offered, placeholder, button, icon, hint, write: write_, describe, onDone, onUncertain }: {
  repo: AdminRepo
  label: string
  initial: BranchName | null
  /**
   * What a change made `initial`, read from its answer (the default form's
   * new default): the picker counts it as untouched from then on, so the
   * refresh that follows never replaces a choice made since.
   */
  baseline?(result: RepoBranches): BranchName | null
  offered: Page<RefItem> | null
  placeholder?: string
  button: string
  icon: ReactNode
  hint?: ReactNode
  write(ref: RefId): Promise<RepoBranches>
  describe(branch: BranchName, now: RepoBranches): string
  onDone(result: RepoBranches, branch: BranchName): string
  onUncertain(message: string): void
}) {
  const [selected, setSelected] = useState(initial?.id ?? "")
  // the branch chosen from the list, kept as an option while the list
  // can't be read, so the picker always shows what it would send
  const [remembered, setRemembered] = useState<BranchName | null>(initial)
  const [loadedFrom, setLoadedFrom] = useState(initial?.id ?? "")
  const [typed, setTyped] = useState("")
  const [failure, setFailure] = useState<Failure | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  // a change whose outcome is unknown and unsettled blocks another
  const write = useWrite<{ cause: string; branch: BranchName }>()
  const leave = useLeaveSettings()
  const pickerId = useId()

  // the last `initial` considered, so a stale one is never taken for news
  const seen = useRef(initial?.id ?? "")
  useEffect(() => {
    const id = initial?.id ?? ""
    // a picker being sent from waits (it takes no edits then), and follows once free
    if (id === seen.current || write.blocked) return
    seen.current = id
    // already the baseline, as a change's own answer set it
    if (id === loadedFrom) return
    setLoadedFrom(id)
    // an untouched picker follows a default changed elsewhere; a choice made since stays
    if (selected === loadedFrom) {
      setSelected(id)
      setRemembered(initial)
    }
  }, [initial?.id, write.blocked])

  // the current default and the current choice are always offered, listed or not
  const options: BranchName[] = offered ? [...offered.items] : []
  for (const extra of [remembered, initial]) {
    if (extra && !options.some((option) => option.id === extra.id)) options.unshift(extra)
  }

  function choose(id: string) {
    setSelected(id)
    const option = options.find((each) => each.id === id)
    if (option) setRemembered(option)
  }

  /** The chosen branch: a listed one by its id, or a typed name as the id Haxy would give it. */
  function chosen(): BranchName {
    if (selected === typedChoice) return { id: branchId(typed), name: typed }
    return options.find((option) => option.id === selected) ?? { id: selected, name: selected }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const branch = chosen()
    void write.start(async (current) => {
      setFailure(null)
      setSuccess(null)
      try {
        const result = await write_(branch.id)
        if (!current()) return
        adopt(result)
        setSuccess(onDone(result, branch))
      } catch (error) {
        if (!current()) return
        const failed = failureOf(error, `${button} failed.`)
        if (!failed.unknown) return setFailure(failed)
        const reading = await settle(repo, failed.cause, (now) => describe(branch, now))
        if (current()) settled(reading, { cause: failed.cause, branch })
      }
    })
  }

  const check = () => write.check(async (unknown, current) => {
    const reading = await settle(repo, unknown.cause, (now) => describe(unknown.branch, now))
    if (current()) settled(reading, unknown)
  })

  /**
   * The branches as Haxy holds them after a change (its answer, or the read
   * that settled it) set the picker's baseline, before the form unlocks: so
   * the refresh that follows never replaces a branch picked since. Every
   * path that reads them back goes through here.
   */
  function adopt(branches: RepoBranches) {
    if (baseline) setLoadedFrom(baseline(branches)?.id ?? "")
  }

  /** What a read that settles a change found: said (with the baseline adopted), lost access, or still unresolved. */
  function settled(reading: Awaited<ReturnType<typeof settle>>, unknown: { cause: string; branch: BranchName }) {
    if (reading === "unknown") return write.setUnresolved(unknown)
    write.setUnresolved(null)
    if (reading === "lost") return leave()
    adopt(reading.now)
    onUncertain(reading.said)
  }

  const error = failure?.fields.ref
  return (
    <form aria-label={label} className="mt-4 space-y-3" onSubmit={submit} noValidate>
      {failure && <FailureMessage failure={failure} />}
      {success && <FormMessage kind="success">{success}</FormMessage>}
      {write.unresolved && <Unresolved message={unsettled(write.unresolved.cause)} pending={write.busy} onCheck={() => void check()} />}
      {/* no other choice while a change or check runs or a change is unresolved */}
      <fieldset disabled={write.blocked} className="space-y-3 disabled:opacity-60">
        <div>
          <label htmlFor={pickerId} className="text-sm font-medium">{label}</label>
          <select id={pickerId} name="ref" value={selected} onChange={(event) => choose(event.target.value)}
            aria-invalid={error && selected !== typedChoice ? true : undefined} aria-describedby={`${pickerId}-hint`}
            className="mt-1.5 block w-full rounded-md border bg-background px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50">
            {(selected === "" || !initial) && <option value="" disabled>{placeholder ?? "Choose a branch"}</option>}
            {options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
            <option value={typedChoice}>Another branch, by name…</option>
          </select>
          <p id={`${pickerId}-hint`} className="mt-1 text-xs text-muted-foreground">
            {hint}{offered?.page.has_more ? ` The first ${pickerSize} branches are listed; name another by typing it.` : ""}
          </p>
          {error && selected !== typedChoice && <p className="mt-1 text-xs text-destructive">{error}</p>}
        </div>
        {selected === typedChoice && (
          <TextField label="Branch name" name="name" value={typed} onValue={setTyped} error={error}
            autoComplete="off" autoCapitalize="none" spellCheck={false} className="font-mono" />
        )}
      </fieldset>
      <Button type="submit" disabled={write.blocked || selected === ""}>
        {write.busy ? <LoaderCircle className="animate-spin" /> : icon}
        {button}
      </Button>
    </form>
  )
}

function DefaultBranchForm({ repo, viewer, current, offered, onChanged, onUncertain }: { repo: AdminRepo; viewer: string; current: BranchName | null; offered: Page<RefItem> | null; onChanged(): void; onUncertain(message: string): void }) {
  const navigate = useNavigate()
  const location = useLocation()
  return (
    <BranchForm repo={repo} label="Default branch" initial={current} baseline={(result) => result.default_branch} offered={offered} button="Change default branch" icon={null}
      hint="What the repository page shows and clones check out."
      write={(ref) => setDefaultBranch(repo, viewer, ref)}
      describe={(_, now) => (now.default_branch ? `the default branch is ${now.default_branch.name} now` : "HEAD names no branch now")}
      onDone={(result, branch) => {
        onChanged()
        // read the repository again, so its page follows the new default
        void navigate(location.pathname + location.search, { replace: true })
        return `The default branch is ${result.default_branch?.name ?? branch.name} now.`
      }}
      onUncertain={onUncertain} />
  )
}

function ProtectForm({ repo, viewer, count, max, offered, onChanged, onUncertain }: { repo: AdminRepo; viewer: string; count: number; max: number; offered: Page<RefItem> | null; onChanged(): void; onUncertain(message: string): void }) {
  return (
    <BranchForm repo={repo} label="Protect a branch" initial={null} offered={offered} button="Protect branch" icon={<Shield />}
      hint={`${count} of at most ${max} branches are protected.`}
      write={(ref) => protectBranch(repo, viewer, ref)}
      // Haxy's ids are canonical, and so is branchId's
      describe={(branch, now) => (now.protected.some((each) => each.id === branch.id) ? `${branch.name} is protected now` : `${branch.name} isn't protected now`)}
      onDone={(_, branch) => {
        onChanged()
        return `${branch.name} is protected now.`
      }}
      onUncertain={onUncertain} />
  )
}

function ProtectedRow({ repo, viewer, branch, onChanged, onUncertain }: { repo: AdminRepo; viewer: string; branch: BranchName; onChanged(): void; onUncertain(message: string): void }) {
  const [failure, setFailure] = useState<Failure | null>(null)
  // an unprotection whose outcome is unknown and unsettled blocks another
  const write = useWrite<string>()
  const leave = useLeaveSettings()
  const describe = (now: RepoBranches) => (now.protected.some((each) => each.id === branch.id) ? `${branch.name} is still protected` : `${branch.name} isn't protected now`)

  const check = () => write.check(async (cause, current) => {
    const reading = await settle(repo, cause, describe)
    if (!current() || reading === "unknown") return
    write.setUnresolved(null)
    if (reading === "lost") leave()
    else onUncertain(reading.said)
  })

  // the row stays mounted if another owner protects the branch again before
  // the list is read, so every path leaves it usable
  const unprotect = () => write.start(async (current) => {
    setFailure(null)
    try {
      // Haxy's id, sent back unchanged; unprotecting twice changes nothing
      await unprotectBranch(repo, viewer, branch.id)
      if (current()) onChanged()
    } catch (error) {
      if (!current()) return
      const failed = failureOf(error, "Unprotecting the branch failed.")
      if (!failed.unknown) return setFailure(failed)
      const reading = await settle(repo, failed.cause, describe)
      if (!current()) return
      if (reading === "unknown") write.setUnresolved(failed.cause)
      else if (reading === "lost") leave()
      else onUncertain(reading.said)
    }
  })

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <code className="font-mono text-sm break-all">{branch.name}</code>
        <Button variant="outline" size="sm" aria-label={`Unprotect ${branch.name}`} onClick={() => void unprotect()} disabled={write.blocked}>
          {write.busy ? <LoaderCircle className="animate-spin" /> : <ShieldOff />}
          Unprotect
        </Button>
      </div>
      {failure && <div className="mt-2"><FailureMessage failure={failure} /></div>}
      {write.unresolved !== null && <div className="mt-2"><Unresolved message={unsettled(write.unresolved)} pending={write.busy} onCheck={() => void check()} /></div>}
    </li>
  )
}
