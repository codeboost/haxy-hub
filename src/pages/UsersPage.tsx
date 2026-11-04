import { Link } from "react-router"
import { EmptyState, FailureState, LoadingState, Pager, SearchForm, UnavailableState, listQuery, useListParams } from "@/components/listing"
import { listUsers } from "@/lib/discovery"
import { useResource } from "@/lib/resource"

export function UsersPage() {
  const { search, cursor } = useListParams()
  const users = useResource(`users ${listQuery(search, cursor)}`, (signal) => listUsers({ search, cursor }, { signal }))

  if (users.kind === "failed" && users.error.code === "unsupported") {
    return <UnavailableState title="Users">Local mode serves a single repository without accounts, so there is no user directory.</UnavailableState>
  }
  return (
    <section>
      <h1 className="mb-6 text-3xl font-semibold tracking-tight">Users</h1>
      <SearchForm key={search} label="Search users" search={search} />
      {users.kind === "loading" && <LoadingState>Loading users…</LoadingState>}
      {users.kind === "failed" && <FailureState title="Couldn't load users" error={users.error} onRetry={users.reload} />}
      {users.kind === "loaded" && (
        users.data.items.length === 0 ? (
          // A later page can be empty when the list changed since its link was made.
          cursor ? <EmptyState title="No more users"><Link className="text-primary underline-offset-4 hover:underline" to={listQuery(search)}>Back to the first page</Link></EmptyState>
            : search ? <EmptyState title={`No users match “${search}”`}>Names are matched from their start.</EmptyState>
            : <EmptyState title="No users yet">Nobody has registered on this server.</EmptyState>
        ) : (
          <>
            <ul aria-label="Users" className="mt-6 divide-y rounded-xl border bg-card">
              {users.data.items.map((user) => (
                <li key={user.name}>
                  <Link to={`/users/${encodeURIComponent(user.name)}`} className="block px-4 py-3 font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">{user.name}</Link>
                </li>
              ))}
            </ul>
            <Pager page={users.data.page} search={search} cursor={cursor} noun="Users" />
          </>
        )
      )}
    </section>
  )
}
