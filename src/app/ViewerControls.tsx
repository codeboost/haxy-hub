import { useState } from "react"
import { Link, useLocation } from "react-router"
import { LogIn, LogOut, UserPlus, UserRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useConnection } from "@/app/connection"
import { useSession } from "@/app/session"
import { ApiError } from "@/lib/api"
import { loginPath } from "@/lib/session"

/** The header's viewer: who is logged in with a Log out button, or a Log in link. Nothing in local mode. */
export function ViewerControls() {
  const { check } = useConnection()
  const { ready, viewer, logOut } = useSession()
  const location = useLocation()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (check?.kind !== "connected" || check.status.mode !== "server" || !ready) return null

  if (!viewer) {
    // On the login page itself, keep the route it will return to.
    const to = location.pathname === "/login" ? location.pathname + location.search : loginPath(location.pathname + location.search)
    return (
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link to="/register"><UserPlus />Register</Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link to={to}><LogIn />Log in</Link>
        </Button>
      </div>
    )
  }

  async function onLogOut() {
    setPending(true)
    setError(null)
    try {
      await logOut()
    } catch (failure) {
      // Still logged in as far as we know; the backend didn't confirm.
      setError(failure instanceof ApiError ? failure.message : "Logging out failed.")
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex items-center gap-3">
      <p className="hidden text-sm text-muted-foreground sm:block">Signed in as <Link to="/account" className="font-medium text-foreground underline-offset-4 hover:underline">{viewer.name}</Link></p>
      {/* Narrow screens hide the name, so the account page gets its own link. */}
      <Button asChild variant="ghost" size="icon-sm" className="sm:hidden">
        <Link to="/account" aria-label="Your account"><UserRound /></Link>
      </Button>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <Button variant="outline" size="sm" onClick={onLogOut} disabled={pending}><LogOut />Log out</Button>
    </div>
  )
}
