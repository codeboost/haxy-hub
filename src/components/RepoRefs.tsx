import { Link } from "react-router"
import { GitBranch, GitCommitHorizontal, GitPullRequest, Tag } from "lucide-react"
import { EmptyState, FailureState, LoadingState, Pager, SearchForm, listQuery, useListParams } from "@/components/listing"
import { commitsRoute } from "@/lib/commits"
import { listRefs, refsRoute, repoRoute, type EncodedPath, type ReadRef, type RefId, type RefKind, type RepoLocator } from "@/lib/repo"
import { useResource } from "@/lib/resource"

// Choosing a ref: the repository's branches and tags, searchable and paged
// like the TUI's refs tab (whose search and window this reads), each leading
// to the files at that ref. The list, its search and its page live in the URL
// (`/branches` or `/tags`, `?search=…&cursor=…`).

const linkClass = "text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"

const kindLabels: Record<ReadRef["kind"], string> = { branch: "Branch", tag: "Tag", commit: "Commit", revision: "Patch revision" }

/** The id's value after its kind, for showing a commit or revision id. */
function refValue(id: RefId): string {
  return id.slice(id.indexOf(":") + 1)
}

/**
 * Which ref the files view shows, with the way to choose another and, away
 * from the default branch, back to it (at the same path).
 */
export function RefBar({ repo, path, refId, read }: { repo: RepoLocator; path: EncodedPath; refId: RefId | null; read: ReadRef }) {
  const Icon = read.kind === "branch" ? GitBranch : read.kind === "tag" ? Tag : read.kind === "commit" ? GitCommitHorizontal : GitPullRequest
  return (
    <section aria-label="Ref" className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <span className="flex min-w-0 items-center gap-2">
        <Icon size={16} aria-hidden className="shrink-0 text-muted-foreground" />
        <span>{kindLabels[read.kind]}{" "}<code className="font-mono font-semibold break-all">{read.name ?? refValue(read.id)}</code></span>
      </span>
      {read.kind !== "commit" && <span className="text-muted-foreground">at commit <code className="font-mono break-all">{read.commit}</code></span>}
      <Link to={refsRoute(repo, read.kind === "tag" ? "tag" : "branch")} className={linkClass}>Branches and tags</Link>
      <Link to={commitsRoute(repo, refId)} className={linkClass}>History</Link>
      {refId !== null && <Link to={repoRoute(repo, path)} className={linkClass}>Default branch</Link>}
    </section>
  )
}

function repoKey(repo: RepoLocator): string {
  return repo.kind === "local" ? "local" : `${repo.owner}/${repo.name}`
}

const nouns: Record<RefKind, { plural: string; title: string }> = {
  branch: { plural: "branches", title: "Branches" },
  tag: { plural: "tags", title: "Tags" },
}

/** The repository's branches or tags, searchable and paged, each linking to its files. */
export function RepoRefs({ repo, kind }: { repo: RepoLocator; kind: RefKind }) {
  const { search, cursor } = useListParams()
  const refs = useResource(`refs ${repoKey(repo)} ${kind} ${listQuery(search, cursor)}`, (signal) => listRefs(repo, kind, { search, cursor }, { signal }))
  const noun = nouns[kind]
  const tabClass = "-mb-px border-b-2 px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
  const Icon = kind === "branch" ? GitBranch : Tag
  return (
    <section aria-labelledby="refs-heading" className="mt-6">
      <h2 id="refs-heading" className="sr-only">Branches and tags</h2>
      <nav aria-label="Ref kinds" className="mb-4 flex gap-1 border-b">
        {(["branch", "tag"] as const).map((each) => (
          <Link key={each} to={refsRoute(repo, each)} aria-current={each === kind ? "page" : undefined} className={`${tabClass} ${each === kind ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{nouns[each].title}</Link>
        ))}
      </nav>
      {/* ref names may start with whitespace git allows, and the prefix is matched exactly */}
      <SearchForm key={`${kind} ${search}`} label={`Search ${noun.plural}`} search={search} exact />
      {refs.kind === "loading" && <LoadingState>Loading {noun.plural}…</LoadingState>}
      {refs.kind === "failed" && <FailureState title={`Couldn't load ${noun.plural}`} error={refs.error} onRetry={refs.reload} />}
      {refs.kind === "loaded" && (
        refs.data.items.length === 0 ? (
          // a later page can be empty when refs were removed since its link was made
          cursor ? <EmptyState title={`No more ${noun.plural}`}><Link className={linkClass} to={refsRoute(repo, kind) + listQuery(search)}>Back to the first page</Link></EmptyState>
            : search ? <EmptyState title={`No ${noun.plural} match “${search}”`}>Names are matched from their start.</EmptyState>
            : <EmptyState title={`No ${noun.plural} yet`} />
        ) : (
          <>
            <ul aria-label={noun.title} className="mt-6 divide-y rounded-xl border bg-card">
              {refs.data.items.map((item) => (
                <li key={item.id}>
                  <Link to={repoRoute(repo, "", item.id)} className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                    <Icon size={16} aria-hidden className="shrink-0 text-muted-foreground" />
                    <span className="font-mono break-all">{item.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <Pager page={refs.data.page} search={search} cursor={cursor} noun={noun.title} base={refsRoute(repo, kind)} />
          </>
        )
      )}
    </section>
  )
}
