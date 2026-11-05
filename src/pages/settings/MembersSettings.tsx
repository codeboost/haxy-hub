import { useEffect, useRef, useState, type FormEvent } from "react"
import { Link, useNavigate } from "react-router"
import { Crown, LoaderCircle, UserMinus, UserPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FailureMessage, FormMessage, TextField, failureOf, type Failure } from "@/components/form"
import { FailureState, LoadingState, Pager, useListParams } from "@/components/listing"
import { ApiError } from "@/lib/api"
import { repoRoute } from "@/lib/repo"
import { addMember, listMembers, revokeMember, setMemberRole, type AdminRepo, type Member, type MemberRole } from "@/lib/repoAdmin"
import { useResource } from "@/lib/resource"
import { adminRoute, linkClass, lostAccess, useLeaveSettings, useWrite } from "./shared"
import { Unresolved } from "./Unresolved"

const roleLabels: Record<MemberRole, string> = { owner: "Owner", member: "Member" }

/** The role `name` holds now, read from the first pages of the list (null when not listed). */
async function currentRole(repo: AdminRepo, name: string): Promise<MemberRole | null> {
  let cursor: string | undefined
  // the list is short in practice; stop after a few pages rather than guess
  for (let pages = 0; pages < 10; pages++) {
    const page = await listMembers(repo, { cursor, page_size: 100 })
    const found = page.items.find((member) => member.name === name)
    if (found) return found.role
    if (!page.page.next_cursor) return null
    cursor = page.page.next_cursor
  }
  throw new Error("too many members to check")
}

/**
 * What a read that settles a member write found: something to say, that the
 * viewer can no longer manage the members (itself the answer: see
 * `lostAccess`), or nothing, when Haxy couldn't say.
 */
type Reading = { kind: "known"; said: string } | { kind: "lost" } | { kind: "unknown" }

/** `name`'s role as Haxy holds it now, said in words. */
async function roleNow(repo: AdminRepo, name: string): Promise<Reading> {
  try {
    const role = await currentRole(repo, name)
    return { kind: "known", said: role === null ? `${name} isn't a member now` : `${name} is ${role === "owner" ? "an owner" : "a member"} now` }
  } catch (error) {
    return lostAccess(error) ? { kind: "lost" } : { kind: "unknown" }
  }
}

/** What a member write's unknown outcome turned out to be, said without claiming this attempt did it. */
async function settle(repo: AdminRepo, name: string, cause: string): Promise<Reading> {
  const now = await roleNow(repo, name)
  return now.kind === "known" ? { kind: "known", said: `${cause} Haxy couldn't confirm the change; ${now.said} (which may or may not be from this attempt). The list shows the members as they are.` } : now
}

/** Said while a change's outcome is unknown and a check couldn't settle it. */
const unsettled = (name: string, cause: string) =>
  `${cause} Haxy couldn't confirm the change, or say what ${name}'s role is now, so it isn't offered again until a check gets an answer.`

/**
 * The repository's members, paged as the TUI pages them, with the main owner
 * apart (they always own it, so no action applies to them). Owners add
 * members, promote them to owners, demote owners, and remove anyone, after
 * confirming a demotion or removal.
 */
export function MembersSettings({ repo, viewer, mainOwner }: { repo: AdminRepo; viewer: string; mainOwner: string }) {
  const navigate = useNavigate()
  // once the viewer can't manage the members, the settings say so themselves
  const leave = useLeaveSettings()
  const { cursor } = useListParams()
  // a change reads the list again in the background, keeping what the page says
  const [version, setVersion] = useState(0)
  const reload = () => setVersion((value) => value + 1)
  const members = useResource(`repo members ${repo.owner}/${repo.name} ${cursor}`, (signal) => listMembers(repo, { cursor }, { signal }), String(version))
  // Said when a change's outcome was unknown, or another owner changed the
  // row first, and the list was read again.
  const [notice, setNotice] = useState<string | null>(null)

  function changed(member: string, role: MemberRole | null) {
    setNotice(null)
    // giving up your own ownership ends your access to these settings
    if (member === viewer && role !== "owner") {
      void navigate(repoRoute(repo), { replace: true })
      return
    }
    reload()
  }

  return (
    <section aria-labelledby="members-heading" className="max-w-2xl">
      <h2 id="members-heading" className="text-xl font-semibold">Members</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        <strong className="text-foreground">Members</strong> can push to this repository. <strong className="text-foreground">Owners</strong> can also manage its settings, members and branches.
        Only the main owner, who created it, can delete it.
      </p>
      <AddMemberForm repo={repo} viewer={viewer} onAdded={() => { setNotice(null); reload() }} onUncertain={(message) => { setNotice(message); reload() }} onLost={leave} />
      {notice && <p role="status" className="mt-4 rounded-md border px-3 py-2 text-sm text-muted-foreground">{notice}</p>}
      <ul aria-label="Members" className="mt-6 divide-y rounded-xl border bg-card">
        <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link to={`/users/${encodeURIComponent(mainOwner)}`} className={`font-medium ${linkClass}`}>{mainOwner}</Link>
          <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground"><Crown size={12} aria-hidden />Main owner</span>
        </li>
        {members.kind === "loaded" && members.data.items.map((member) => (
          <MemberRow key={`${member.name} ${member.role}`} repo={repo} viewer={viewer} member={member}
            onChanged={(role) => changed(member.name, role)} onStale={(message) => { setNotice(message); reload() }} onLost={leave} />
        ))}
      </ul>
      {members.kind === "loading" && <LoadingState>Loading the members…</LoadingState>}
      {members.kind === "failed" && <FailureState title="Couldn't load the members" error={members.error} onRetry={members.reload} />}
      {members.kind === "loaded" && members.data.items.length === 0 && !cursor && <p className="mt-3 text-sm text-muted-foreground">No one else is a member yet.</p>}
      {members.kind === "loaded" && <Pager page={members.data.page} search="" cursor={cursor} noun="Members" base={adminRoute(repo, "members")} />}
    </section>
  )
}

function AddMemberForm({ repo, viewer, onAdded, onUncertain, onLost }: { repo: AdminRepo; viewer: string; onAdded(): void; onUncertain(message: string): void; onLost(): void }) {
  const [name, setName] = useState("")
  const [failure, setFailure] = useState<Failure | null>(null)
  const [added, setAdded] = useState<string | null>(null)
  // an addition whose outcome is unknown and unsettled blocks another
  const write = useWrite<{ name: string; cause: string }>()

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const typed = name.trim()
    void write.start(async (current) => {
      setFailure(null)
      setAdded(null)
      try {
        await addMember(repo, viewer, typed)
        if (!current()) return
        // the field took no edits meanwhile, so clearing it loses nothing
        setName("")
        setAdded(typed)
        onAdded()
      } catch (error) {
        if (!current()) return
        // A name isn't secret: keep it to correct.
        const failed = failureOf(error, "Adding the member failed.")
        if (!failed.unknown) return setFailure(failed)
        const now = await settle(repo, typed, failed.cause)
        if (!current()) return
        if (now.kind === "known") onUncertain(now.said)
        else if (now.kind === "lost") onLost()
        else write.setUnresolved({ name: typed, cause: failed.cause })
      }
    })
  }

  const check = () => write.check(async (unknown, current) => {
    const now = await settle(repo, unknown.name, unknown.cause)
    if (!current() || now.kind === "unknown") return
    write.setUnresolved(null)
    if (now.kind === "known") onUncertain(now.said)
    else onLost()
  })

  return (
    <form aria-label="Add a member" className="mt-4 space-y-3" onSubmit={submit} noValidate>
      {failure && <FailureMessage failure={failure} />}
      {added && <FormMessage kind="success">{added} is a member now.</FormMessage>}
      {write.unresolved && <Unresolved message={unsettled(write.unresolved.name, write.unresolved.cause)} pending={write.busy} onCheck={() => void check()} />}
      <fieldset disabled={write.blocked} className="disabled:opacity-60">
        <TextField label="Add a member" name="name" value={name} onValue={setName} error={failure?.fields.name} placeholder="username"
          autoComplete="off" autoCapitalize="none" spellCheck={false} />
      </fieldset>
      <Button type="submit" disabled={write.blocked}>
        {write.busy ? <LoaderCircle className="animate-spin" /> : <UserPlus />}
        Add member
      </Button>
    </form>
  )
}

type RowAction = "promote" | "demote" | "remove"

function MemberRow({ repo, viewer, member, onChanged, onStale, onLost }: {
  repo: AdminRepo
  viewer: string
  member: Member
  onChanged(role: MemberRole | null): void
  onStale(message: string): void
  /** the viewer can no longer manage the members (perhaps by this very change) */
  onLost(): void
}) {
  // demoting and removing ask first; promoting doesn't take anything away
  const [confirming, setConfirming] = useState<RowAction | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)
  // a change whose outcome is unknown and unsettled: the row offers no
  // change until a check gets an answer
  const write = useWrite<string>()
  const self = member.name === viewer

  useEffect(() => {
    if (confirming) confirmButton.current?.focus()
  }, [confirming])

  const check = () => write.check(async (cause, current) => {
    const now = await settle(repo, member.name, cause)
    if (!current() || now.kind === "unknown") return
    write.setUnresolved(null)
    if (now.kind === "known") onStale(now.said)
    else onLost()
  })

  // the row stays mounted when the list reads it back unchanged (another
  // owner reversed the change), so every path leaves it usable
  const act = (action: RowAction) => write.start(async (current) => {
    setFailure(null)
    try {
      const result = action === "remove"
        ? await revokeMember(repo, viewer, member.name)
        : await setMemberRole(repo, viewer, member.name, action === "promote" ? "owner" : "member")
      if (!current()) return
      setConfirming(null)
      onChanged(result.role)
    } catch (error) {
      if (!current()) return
      const failed = failureOf(error, "Changing the member failed.")
      // Never offer the change again before the list is read: it may have
      // landed (unknown), or another owner changed the row first.
      const stale = error instanceof ApiError && (error.code === "conflict" || error.code === "not_found") && !failed.viewerChanged
      if (!failed.unknown && !stale) return setFailure(failed)
      const now = failed.unknown ? await settle(repo, member.name, failed.cause) : await roleNow(repo, member.name)
      if (!current()) return
      setConfirming(null)
      if (now.kind === "lost") onLost()
      else if (failed.unknown) {
        if (now.kind === "known") onStale(now.said)
        else write.setUnresolved(failed.cause)
      } else onStale(`${failed.cause} ${now.kind === "known" ? `${now.said}.` : "The list shows the members as they are."}`)
    }
  })

  const prompts: Record<RowAction, { question: string; button: string }> = {
    promote: { question: "", button: "" },
    demote: {
      question: self ? "Demote yourself to member? You'll no longer manage this repository." : `Demote ${member.name} to member? They'll no longer manage this repository.`,
      button: "Demote to member",
    },
    remove: {
      question: self ? "Remove yourself? You'll lose access this repository gives members." : `Remove ${member.name}? They lose the access this repository gives members, from their next request.`,
      button: "Remove member",
    },
  }

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Link to={`/users/${encodeURIComponent(member.name)}`} className={`font-medium ${linkClass}`}>{member.name}</Link>
          <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{roleLabels[member.role]}</span>
        </div>
        {!confirming && write.unresolved === null && (
          <div className="flex gap-2">
            {member.role === "member"
              ? <Button variant="outline" size="sm" aria-label={`Promote ${member.name} to owner`} onClick={() => void act("promote")} disabled={write.blocked}>{write.busy && <LoaderCircle className="animate-spin" />}Promote to owner</Button>
              : <Button variant="outline" size="sm" aria-label={`Demote ${member.name} to member`} onClick={() => setConfirming("demote")} disabled={write.blocked}>Demote to member</Button>}
            <Button variant="outline" size="sm" aria-label={`Remove ${member.name}`} onClick={() => setConfirming("remove")} disabled={write.blocked}><UserMinus />Remove</Button>
          </div>
        )}
      </div>
      {!confirming && failure && <div className="mt-2"><FailureMessage failure={failure} /></div>}
      {write.unresolved !== null && <div className="mt-2"><Unresolved message={unsettled(member.name, write.unresolved)} pending={write.busy} onCheck={() => void check()} /></div>}
      {confirming && (
        <div role="group" aria-label={`Confirm: ${prompts[confirming].button} ${member.name}`} className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-sm">{prompts[confirming].question}</p>
          {failure && <div className="mt-2"><FailureMessage failure={failure} /></div>}
          <div className="mt-3 flex gap-2">
            <Button ref={confirmButton} variant="destructive" size="sm" onClick={() => void act(confirming)} disabled={write.blocked}>
              {write.busy && <LoaderCircle className="animate-spin" />}
              {prompts[confirming].button}
            </Button>
            <Button variant="outline" size="sm" onClick={() => { setConfirming(null); setFailure(null) }} disabled={write.busy}>Cancel</Button>
          </div>
        </div>
      )}
    </li>
  )
}
