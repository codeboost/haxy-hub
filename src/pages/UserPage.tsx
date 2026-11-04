import { Link, useParams } from "react-router"
import { Lock } from "lucide-react"
import { EmptyState, FailureState, LoadingState, Pager, SearchForm, UnavailableState, listQuery, useListParams } from "@/components/listing"
import { getUser, listUserRepos, type RepoSummary } from "@/lib/discovery"
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
      {repos.kind === "loading" && <LoadingState>Loading repositories…</LoadingState>}
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

export function UserPage() {
  const name = useParams().name ?? ""
  const user = useResource(`user ${name}`, (signal) => getUser(name, { signal }))
  switch (user.kind) {
    case "loading":
      return <LoadingState>Loading {name}…</LoadingState>
    case "failed":
      if (user.error.code === "unsupported") {
        return <UnavailableState title={name}>Local mode serves a single repository without accounts, so there are no user pages.</UnavailableState>
      }
      if (user.error.code === "not_found") {
        return (
          <section>
            <h1 className="text-3xl font-semibold tracking-tight">User not found</h1>
            <p className="mt-3 text-muted-foreground">There is no user named <strong>{name}</strong>.</p>
            <Link to="/users" className="mt-6 inline-block text-sm text-primary underline-offset-4 hover:underline">Browse users</Link>
          </section>
        )
      }
      return (
        <>
          <h1 className="text-3xl font-semibold tracking-tight">{name}</h1>
          <FailureState title="Couldn't load this user" error={user.error} onRetry={user.reload} />
        </>
      )
    case "loaded":
      return (
        <>
          <p className="text-sm text-muted-foreground"><Link to="/users" className="hover:underline">Users</Link> /</p>
          <h1 className="text-3xl font-semibold tracking-tight">{user.data.name}</h1>
          <Repos name={user.data.name} />
        </>
      )
  }
}
