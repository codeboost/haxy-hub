import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type RefObject } from "react"
import { LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ApiError } from "@/lib/api"
import { branchOf, composesText, encodedNameOf, pickedValue, searchOf, showsAmbiguously } from "@/lib/branchPicker"
import type { BranchChoices, BranchSearch } from "@/lib/patches"
import type { RefId, RefItem, RepoLocator } from "@/lib/repo"
import { useResource, type Resource } from "@/lib/resource"
import type { ThreadConfig } from "./config"

const inputClass =
  "mt-1.5 block w-full rounded-md border bg-background px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive"

/** How long typing pauses before the branches are searched. */
const searchDelayMs = 200

const noBranches: BranchSearch = () => Promise.resolve({ items: [], page: { has_more: false, next_cursor: null, count: { kind: "exact", value: 0 } } })

/**
 * The branches a kind's forms choose among (`config.branches`, patches), read
 * for `viewerKey`'s form; `null` for a kind whose forms choose none.
 */
export function useBranchChoices<Status extends string>(repo: RepoLocator, config: ThreadConfig<Status>, viewerKey: string): (Resource<BranchChoices> & { reload(): void }) | null {
  const key = repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
  const { branches } = config
  const choices = useResource(`${config.kind} branches ${key} ${viewerKey} ${branches ? "" : "none"}`, (signal) =>
    branches ? branches.load(repo, { signal }) : Promise.resolve({ search: noBranches, defaultTarget: null }))
  return branches ? choices : null
}

/** How a patch's branch fields are named, for a refusal shown away from them. */
export const branchLabels: Record<string, string> = { source: "Source branch", target: "Target branch" }

/** What a form's branch fields offer: the branches, and whether it chooses a source too (only a new thread does). */
export type BranchOffer = { choices: BranchChoices; source: boolean }

/**
 * The source and target branch pickers of a patch's form, by Haxy's ref ids:
 * each searches every branch of the repository, or takes a name as typed,
 * which Haxy checks when the form is sent.
 */
export function BranchFields({ offer, source, target, onSource, onTarget, errors }: {
  offer: BranchOffer
  source: RefId
  target: RefId
  onSource(value: RefId): void
  onTarget(value: RefId): void
  errors: { source?: string; target?: string }
}) {
  const { search } = offer.choices
  return (
    <>
      {offer.source && (
        <BranchPicker label="Source branch" name="source" value={source} onValue={onSource} search={search} error={errors.source}
          hint="The branch whose commits the patch proposes; pushes to it update the patch." />
      )}
      <BranchPicker label="Target branch" name="target" value={target} onValue={onTarget} search={search} error={errors.target}
        hint="The branch the patch would be merged into." />
    </>
  )
}

/** A read of one page of the branches starting with `search`, after those already `shown`. */
type PageRead = { search: string; cursor: string | null; shown: RefItem[] }

/**
 * A search's matches so far. While a read runs (`busy`) they stay shown,
 * with their controls, until its answer replaces them; `failed` is the read
 * that failed, to try again.
 */
type Matches = { search: string; items: RefItem[]; next: string | null; busy: boolean; failed: { read: PageRead; error: string } | null }

/** What an answer to `read` makes of the matches: its page after those shown, or the failure. */
function answered(read: PageRead, answer: { items: RefItem[]; next: string | null } | { error: string }): Matches {
  if ("error" in answer) return { search: read.search, items: read.shown, next: null, busy: false, failed: { read, error: answer.error } }
  return { search: read.search, items: [...read.shown, ...answer.items], next: answer.next, busy: false, failed: null }
}

/**
 * The branches whose names start with `search` while `open`, refreshed from
 * the first page shortly after it opens or the search changes; `more` reads
 * the next page (or tries a failed read again) and resolves to the branches
 * it added. An answer to a superseded read, or one arriving once closed,
 * changes nothing.
 */
function useBranchMatches(branches: BranchSearch, search: string, open: boolean) {
  const [matches, setMatches] = useState<Matches>({ search, items: [], next: null, busy: true, failed: null })
  const generation = useRef(0)
  const refresh = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const read = useCallback(async (request: PageRead): Promise<RefItem[] | null> => {
    const started = ++generation.current
    setMatches((shown) => ({ ...shown, busy: true }))
    try {
      const page = await branches({ search: request.search, ...(request.cursor ? { cursor: request.cursor } : {}) })
      if (started !== generation.current) return null
      setMatches(answered(request, { items: page.items, next: page.page.next_cursor }))
      return page.items
    } catch (error) {
      if (started === generation.current) setMatches(answered(request, { error: error instanceof ApiError ? error.message : "Haxy Hub couldn't read Haxy's answer." }))
      return null
    }
  }, [branches])
  useEffect(() => {
    if (!open) return
    refresh.current = setTimeout(() => void read({ search, cursor: null, shown: [] }), searchDelayMs)
    return () => {
      clearTimeout(refresh.current)
      generation.current++
    }
  }, [search, open, read])
  // a search not read yet is as good as being read
  const current = matches.search === search ? matches : { ...matches, busy: true }
  // a page asked for explicitly supersedes the refresh still due, which would start over
  const more = async () => {
    if (current.busy) return null
    clearTimeout(refresh.current)
    return read(current.failed?.read ?? { search: current.search, cursor: current.next, shown: current.items })
  }
  // rows answering another search than the one typed are shown, but not to be chosen
  return { matches: current, more, choosable: matches.search === search }
}

/**
 * A picker's state: what is typed, the branch picked (until the text is
 * edited), whether its list is open and which branch in it is active (by
 * id, so another list never inherits it), with what typing, picking,
 * reading more and the keys do to it.
 */
function usePicker(value: RefId, onValue: (value: RefId) => void, search: BranchSearch) {
  const field = useRef<HTMLInputElement>(null)
  const [picked, setPicked] = useState<RefItem | null>(value ? branchOf(value) : null)
  const [text, setText] = useState(picked?.name ?? "")
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<RefId | null>(null)
  const { matches, more, choosable } = useBranchMatches(search, searchOf(text, picked), open)
  const choices = choosable ? matches.items : []
  const active = choices.findIndex((item) => item.id === activeId)

  function type(typed: string) {
    setText(typed)
    setPicked(null)
    setActiveId(null)
    setOpen(true)
    onValue(pickedValue(typed, null))
  }

  function pick(item: RefItem) {
    setPicked(item)
    setText(item.name)
    setActiveId(null)
    setOpen(false)
    onValue(pickedValue(item.name, item))
  }

  // the list's own buttons hand the focus back to the field, at the first branch they add
  async function readMore() {
    field.current?.focus()
    const added = await more()
    if (added && added.length > 0) setActiveId(added[0].id)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => keyAction(event, { open, active, count: choices.length, setOpen, setActive: (index) => setActiveId(choices[index].id), pick: (index) => pick(choices[index]) })
  const pickListed = (item: RefItem) => { if (choosable) pick(item) }
  return { field, picked, text, open, setOpen, active, matches, choosable, type, pick: pickListed, readMore: () => void readMore(), onKeyDown }
}

/**
 * Keeps a picker's list open while the focus is anywhere in it, and gives
 * the field the focus back when what had it inside is gone (a button an
 * answer took away).
 */
function useFocusWithin(container: RefObject<HTMLDivElement | null>, field: RefObject<HTMLInputElement | null>, setOpen: (open: boolean) => void) {
  const within = useRef(false)
  useLayoutEffect(() => {
    if (within.current && document.activeElement === document.body) field.current?.focus()
  })
  return {
    onFocus: () => { within.current = true },
    onBlur: (event: FocusEvent<HTMLDivElement>) => {
      if (container.current?.contains(event.relatedTarget)) return
      within.current = false
      setOpen(false)
    },
  }
}

/**
 * One branch picker: a text field whose list shows the branches starting
 * with what is typed. Picking one sends its exact id, so a name that isn't
 * UTF-8 (shown with U+FFFD, alike others) is still sent exactly; a name typed
 * and not picked is sent as typed.
 */
function BranchPicker({ label, name, value, onValue, search, error, hint }: {
  label: string
  name: string
  value: RefId
  onValue(value: RefId): void
  search: BranchSearch
  error?: string
  hint: string
}) {
  const id = useId()
  const container = useRef<HTMLDivElement>(null)
  const picker = usePicker(value, onValue, search)
  const focus = useFocusWithin(container, picker.field, picker.setOpen)
  const exact = picker.picked && showsAmbiguously(picker.picked.name) ? picker.picked : null
  const describedBy = [`${id}-hint`, exact ? `${id}-exact` : null, error ? `${id}-error` : null].filter(Boolean).join(" ")
  return (
    <div ref={container} className="relative" onFocus={focus.onFocus} onBlur={focus.onBlur}>
      <label id={`${id}-label`} htmlFor={id} className="text-sm font-medium">{label}</label>
      <input ref={picker.field} id={id} name={name} role="combobox" aria-expanded={picker.open} aria-controls={`${id}-list`} aria-autocomplete="list" autoComplete="off" autoCapitalize="none" spellCheck={false}
        aria-activedescendant={picker.open && picker.active >= 0 ? `${id}-option-${picker.active}` : undefined} className={inputClass} value={picker.text} placeholder="Search the branches"
        onChange={(event) => picker.type(event.target.value)} onClick={() => picker.setOpen(true)} onKeyDown={picker.onKeyDown}
        aria-invalid={error ? true : undefined} aria-describedby={describedBy} />
      {picker.open && <BranchList id={id} matches={picker.matches} choosable={picker.choosable} active={picker.active} onPick={picker.pick} onMore={picker.readMore} />}
      <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">{hint} Type the start of a name to search every branch.</p>
      {exact && <p id={`${id}-exact`} className="mt-1 font-mono text-xs text-muted-foreground">Chosen branch: {encodedNameOf(exact.id)} (its name isn't valid UTF-8)</p>}
      {error && <p id={`${id}-error`} className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}

/** What a picker's keys do: arrows move through the list (opening it), Enter picks, Escape closes; none while an input method composes. */
function keyAction(event: KeyboardEvent<HTMLInputElement>, picker: { open: boolean; active: number; count: number; setOpen(open: boolean): void; setActive(index: number): void; pick(index: number): void }) {
  const { open, active, count } = picker
  if (composesText(event.nativeEvent)) return
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault()
    picker.setOpen(true)
    const step = event.key === "ArrowDown" ? 1 : -1
    if (count > 0) picker.setActive(Math.min(Math.max(active + step, 0), count - 1))
  } else if (event.key === "Enter" && open && active >= 0) {
    event.preventDefault()
    picker.pick(active)
  } else if (event.key === "Escape" && open) {
    event.preventDefault()
    picker.setOpen(false)
  }
}

/**
 * A picker's list of matching branches. A name that shows ambiguously is
 * shown with its encoded bytes too, so two alike can be told apart. It keeps
 * the field focused, so picking never closes it first.
 */
function BranchList({ id, matches, choosable, active, onPick, onMore }: { id: string; matches: Matches; choosable: boolean; active: number; onPick(item: RefItem): void; onMore(): void }) {
  // the active option is only pointed at, never focused, so nothing else scrolls it into sight
  useEffect(() => {
    if (active >= 0) document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: "nearest" })
  }, [id, active])
  return (
    <div className="absolute z-10 mt-1 w-full rounded-md border bg-popover text-popover-foreground shadow-md" onMouseDown={(event) => event.preventDefault()}>
      <ul id={`${id}-list`} role="listbox" aria-labelledby={`${id}-label`} aria-busy={matches.busy} tabIndex={-1} className="max-h-64 overflow-y-auto py-1">
        {matches.items.map((item, index) => (
          <li key={item.id} id={`${id}-option-${index}`} role="option" aria-selected={index === active} aria-disabled={choosable ? undefined : true} onClick={() => onPick(item)}
            className={`px-3 py-1.5 font-mono text-sm break-all ${choosable ? "cursor-pointer hover:bg-accent" : "cursor-default text-muted-foreground"} ${index === active ? "bg-accent" : ""}`}>
            {item.name}{showsAmbiguously(item.name) && <span className="text-muted-foreground"> ({encodedNameOf(item.id)})</span>}
          </li>
        ))}
      </ul>
      <MatchesStatus matches={matches} onMore={onMore} />
    </div>
  )
}

/**
 * What a list says under its branches: that it is searching, why a read
 * failed (with a retry), that nothing matches, or a button for the next
 * page. A read in progress keeps the buttons, inactive, so the focus stays.
 */
function MatchesStatus({ matches, onMore }: { matches: Matches; onMore(): void }) {
  const { busy, failed, items, next } = matches
  return (
    <>
      {busy && <p role="status" className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"><LoaderCircle size={14} className="animate-spin" aria-hidden />Searching the branches…</p>}
      {failed && (
        <div role="alert" className="px-3 py-2 text-xs text-destructive">
          Couldn't search the branches: {failed.error}
          <Button type="button" variant="outline" size="sm" className="ml-2" aria-disabled={busy} onClick={onMore}>Try again</Button>
        </div>
      )}
      {!busy && !failed && items.length === 0 && (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{matches.search ? `No branch starts with “${matches.search}”.` : "The repository has no branches."}</p>
      )}
      {!failed && next !== null && <div className="border-t px-3 py-2"><Button type="button" variant="outline" size="sm" aria-disabled={busy} onClick={onMore}>More branches</Button></div>}
    </>
  )
}
