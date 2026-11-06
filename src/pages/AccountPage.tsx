import { Link } from "react-router"
import { FailureState, LoadingState, UnavailableState } from "@/components/listing"
import { useConnection } from "@/app/connection"
import { useSession } from "@/app/session"
import { getAccount } from "@/lib/account"
import { useResource } from "@/lib/resource"
import { loginPath } from "@/lib/session"
import { DeleteSection } from "@/pages/account/DeleteSection"
import { EmailSection } from "@/pages/account/EmailSection"
import { KeysSection } from "@/pages/account/KeysSection"
import { PasswordSection } from "@/pages/account/PasswordSection"

/** `/account`: the logged-in viewer's email, password, SSH keys and account deletion. */
export function AccountPage() {
  const { check } = useConnection()
  const { viewer } = useSession()

  if (check?.kind === "connected" && check.status.mode === "local") {
    return <UnavailableState title="Account">Local mode serves a single repository without accounts, so there are no account settings.</UnavailableState>
  }
  if (!viewer) {
    return (
      <section className="max-w-md">
        <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
        <p className="mt-3 text-muted-foreground">Log in to manage your account.</p>
        <Link to={loginPath("/account")} className="mt-6 inline-block text-sm text-primary underline-offset-4 hover:underline">Log in</Link>
      </section>
    )
  }
  return <Settings />
}

function Settings() {
  const account = useResource("account", (signal) => getAccount({ signal }))
  switch (account.kind) {
    case "loading":
      return <LoadingState>Loading your account…</LoadingState>
    case "failed":
      return (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
          <FailureState title="Couldn't load your account" error={account.error} onRetry={account.reload} />
        </>
      )
    case "loaded":
      return (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
          <p className="mt-2 text-muted-foreground">Signed in as <strong className="text-foreground">{account.data.name}</strong>.</p>
          <div className="mt-10 space-y-12">
            <EmailSection account={account.data} />
            <PasswordSection name={account.data.name} />
            <KeysSection viewer={account.data.name} />
            <DeleteSection name={account.data.name} />
          </div>
        </>
      )
  }
}
