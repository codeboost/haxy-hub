import { Suspense, useDeferredValue, useState } from "react"
import { Link } from "react-router"
import { Popover } from "radix-ui"
import { Check, ChevronDown, GitBranch, GitCommitHorizontal, GitPullRequest, Tag } from "lucide-react"
import { Button } from "@/components/ui/button"
import { listRefs, refsRoute, repoRoute, type EncodedPath, type ReadRef, type RefId, type RefKind, type SourceLocator, sourceKey } from "@/lib/repo"
import { useResource } from "@/lib/resource"

const pickerPageSize = 20
const shortIdLength = 7

const noteClass = "px-3 py-2 text-sm text-muted-foreground"

const kindLabels: Record<ReadRef["kind"], string> = { branch: "Branch", tag: "Tag", commit: "Commit", revision: "Patch revision" }
const kindIcons = { branch: GitBranch, tag: Tag, commit: GitCommitHorizontal, revision: GitPullRequest } as const
const kindNouns: Record<RefKind, { title: string; plural: string }> = {
  branch: { title: "Branches", plural: "branches" },
  tag: { title: "Tags", plural: "tags" },
}

function refValue(id: RefId): string {
  return id.slice(id.indexOf(":") + 1)
}

/** What the picker's button says: a branch or tag by name, a commit or revision by its short id (the full one for screen readers). */
function RefLabel({ read }: { read: ReadRef }) {
  const Icon = kindIcons[read.kind]
  const value = read.name ?? refValue(read.id)
  return (
    <>
      <Icon />
      <span className="truncate font-mono">
        <span className="sr-only">{kindLabels[read.kind]} </span>
        {read.name !== null ? value : <><span className="sr-only">{value}</span><span aria-hidden>{value.slice(0, shortIdLength)}</span></>}
      </span>
    </>
  )
}

function RefOptions({ repo, path, read, kind, search, onPick }: { repo: SourceLocator; path: EncodedPath; read: ReadRef; kind: RefKind; search: string; onPick: () => void }) {
  const refs = useResource(`picker ${sourceKey(repo)} ${kind} ${search}`, (signal) => listRefs(repo, kind, { search, page_size: pickerPageSize }, { signal }))
  if (refs.kind === "failed") return <p role="alert" className="px-3 py-2 text-sm text-destructive">{refs.error.message}</p>
  if (refs.data.items.length === 0) return <p className={noteClass}>{search ? `No ${kindNouns[kind].plural} start with “${search}”.` : `No ${kindNouns[kind].plural} yet.`}</p>
  return (
    <ul aria-label={kindNouns[kind].title} className="max-h-64 overflow-y-auto py-1">
      {refs.data.items.map((item) => (
        <li key={item.id}>
          <Link to={repoRoute(repo, path, item.id)} onClick={onPick} aria-current={item.id === read.id ? "true" : undefined} className="flex items-center gap-2 px-3 py-1.5 font-mono text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none">
            <Check size={14} aria-hidden className={item.id === read.id ? "shrink-0 text-primary" : "invisible shrink-0"} />
            <span className="break-all">{item.name}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

function KindTabs({ kind, onChange }: { kind: RefKind; onChange: (kind: RefKind) => void }) {
  return (
    <div role="tablist" className="flex border-b px-2">
      {(["branch", "tag"] as const).map((each) => (
        <button key={each} type="button" role="tab" aria-selected={each === kind} onClick={() => onChange(each)} className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${each === kind ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
          {kindNouns[each].title}
        </button>
      ))}
    </div>
  )
}

/** The ref the files view shows, as a button that opens a searchable list of branches and tags, each opening the same path there. */
export function RefPicker({ repo, path, read }: { repo: SourceLocator; path: EncodedPath; read: ReadRef }) {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<RefKind>(read.kind === "tag" ? "tag" : "branch")
  const [search, setSearch] = useState("")
  const shownKind = useDeferredValue(kind)
  const shownSearch = useDeferredValue(search)
  const close = () => setOpen(false)
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button variant="outline" size="sm" className="max-w-64 bg-card">
          <RefLabel read={read} />
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} aria-label="Switch branches or tags" className="z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border bg-popover text-popover-foreground shadow-lg">
          <p className="border-b px-3 py-2 text-sm font-semibold">Switch branches or tags</p>
          <div className="p-2">
            <input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} aria-label={`Find a ${kind}`} placeholder={`Find a ${kind}…`} className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          </div>
          <KindTabs kind={kind} onChange={setKind} />
          <Suspense fallback={<p className={noteClass}>Loading {kindNouns[kind].plural}…</p>}>
            <RefOptions repo={repo} path={path} read={read} kind={shownKind} search={shownSearch} onPick={close} />
          </Suspense>
          <div className="border-t px-3 py-2 text-sm">
            <Link to={refsRoute(repo, kind)} onClick={close} className="text-primary underline-offset-4 hover:underline">View all {kindNouns[kind].plural}</Link>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
