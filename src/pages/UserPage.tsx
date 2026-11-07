import { Link, useParams, useSearchParams } from "react-router"
import { Lock } from "lucide-react"
import { EmptyState, FailureState, Pager, SearchForm, UnavailableState, listQuery, useListParams } from "@/components/listing"
import { getUser, listUserRepos, type RepoSummary } from "@/lib/discovery"
import { forkRoute, listUserForks, type ForkItem } from "@/lib/forks"
import { repoRoute } from "@/lib/repo"
import { useResource } from "@/lib/resource"

function RepoRow({ owner, repo }: { owner: string; repo: RepoSummary }) {
  return (
    <li className="px-4 py-3">
      <p className="flex items-center gap-2 font-medium">
        <Link to={repoRoute({ kind: "server", owner, name: repo.name })} className="text-primary underline-offset-4 hover:underline">{repo.name}</Link>
        {repo.access === "private" && (
          <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground"><Lock size={12} aria-hidden />Private</span>
        )}
      </p>
      {repo.description && <p className="mt-0.5 text-sm text-muted-foreground">{repo.description}</p>}
    </li>
  )
}

function Repos({ name }: { name: string }) {
  const { search, cursor } = useListParams()
  const repos = useResource(`repos ${name} ${listQuery(search, cursor)}`, (signal) => listUserRepos(name, { search, cursor }, { signal }))
  return (
    <section aria-labelledby="repos-heading" className="mt-8">
      <h2 id="repos-heading" className="mb-4 text-xl font-semibold">Repositories</h2>
      <SearchForm key={search} label="Search repositories" search={search} />
      {repos.kind === "failed" && <FailureState title="Couldn't load repositories" error={repos.error} onRetry={repos.reload} />}
      {repos.kind === "loaded" && (
        repos.data.items.length === 0 ? (
          // A later page can be empty when the list changed since its link was made.
          cursor ? <EmptyState title="No more repositories"><Link className="text-primary underline-offset-4 hover:underline" to={listQuery(search)}>Back to the first page</Link></EmptyState>
            : search ? <EmptyState title={`No repositories match “${search}”`}>Names are matched from their start.</EmptyState>
            : <EmptyState title="No repositories">{name} has no repositories you can see.</EmptyState>
        ) : (
          <>
            <ul aria-label="Repositories" className="mt-6 divide-y rounded-xl border bg-card">{repos.data.items.map((repo) => <RepoRow key={repo.name} owner={name} repo={repo} />)}</ul>
            <Pager page={repos.data.page} search={search} cursor={cursor} noun="Repositories" />
          </>
        )
      )}
    </section>
  )
}

const forksCursorParam = "forks_cursor"

/** The page's query with the forks cursor set to `cursor` (dropped when empty), keeping the repositories' own parameters. */
function forksPage(params: URLSearchParams, cursor: string): string {
  const next = new URLSearchParams(params)
  if (cursor) next.set(forksCursorParam, cursor)
  else next.delete(forksCursorParam)
  const text = next.toString()
  return text ? `?${text}` : "?"
}

function Badge({ children }: { children: string }) {
  return <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground">{children}</span>
}

function ForkRow({ forker, fork }: { forker: string; fork: ForkItem }) {
  return (
    <li className="px-4 py-3">
      <p className="flex flex-wrap items-center gap-2 font-medium">
        <Link to={forkRoute({ kind: "fork", forker, name: fork.name, id: fork.id })} className="text-primary underline-offset-4 hover:underline">{fork.title}</Link>
        {fork.access === "private" && <Badge>Private</Badge>}
        {fork.target_deleted && <Badge>Target deleted</Badge>}
      </p>
      <p className="mt-0.5 text-sm text-muted-foreground">A fork of {fork.name}</p>
    </li>
  )
}

/** The user's forks the viewer may see, paged by their own cursor so the repositories keep theirs. */
function Forks({ name }: { name: string }) {
  const [params] = useSearchParams()
  const cursor = params.get(forksCursorParam) ?? ""
  const forks = useResource(`forks ${name} ${cursor}`, (signal) => listUserForks(name, { cursor }, { signal }))
  const next = forks.kind === "loaded" ? forks.data.page.next_cursor : null
  return (
    <section aria-labelledby="forks-heading" className="mt-10">
      <h2 id="forks-heading" className="mb-4 text-xl font-semibold">Forks</h2>
      {forks.kind === "failed" && <FailureState title="Couldn't load forks" error={forks.error} onRetry={forks.reload} />}
      {forks.kind === "loaded" && (
        forks.data.items.length === 0 ? (
          cursor ? <EmptyState title="No more forks"><Link className="text-primary underline-offset-4 hover:underline" to={forksPage(params, "")}>Back to the first page</Link></EmptyState>
            : <EmptyState title="No forks">{name} has no forks you can see.</EmptyState>
        ) : (
          <>
            <ul aria-label="Forks" className="divide-y rounded-xl border bg-card">{forks.data.items.map((fork) => <ForkRow key={fork.id} forker={name} fork={fork} />)}</ul>
            <nav aria-label="Forks pages" className="mt-3 flex gap-4 text-sm">
              {cursor && <Link className="text-primary underline-offset-4 hover:underline" to={forksPage(params, "")}>First page</Link>}
              {next && <Link className="text-primary underline-offset-4 hover:underline" to={forksPage(params, next)}>Next page</Link>}
            </nav>
          </>
        )
      )}
    </section>
  )
}

export function UserPage() {
  const name = useParams().name ?? ""
  const user = useResource(`user ${name}`, (signal) => getUser(name, { signal }))
  switch (user.kind) {
    case "failed":
      if (user.error.code === "unsupported") {
        return <UnavailableState title={name}>Local mode serves a single repository without accounts, so there are no user pages.</UnavailableState>
      }
      if (user.error.code === "not_found") {
        return (
          <section>
            <h1 className="text-2xl font-semibold tracking-tight">User not found</h1>
            <p className="mt-3 text-muted-foreground">There is no user named <strong>{name}</strong>.</p>
            <Link to="/users" className="mt-6 inline-block text-sm text-primary underline-offset-4 hover:underline">Browse users</Link>
          </section>
        )
      }
      return (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
          <FailureState title="Couldn't load this user" error={user.error} onRetry={user.reload} />
        </>
      )
    case "loaded":
      return (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">{user.data.name}</h1>
          <Repos name={user.data.name} />
          <Forks name={user.data.name} />
        </>
      )
  }
}
