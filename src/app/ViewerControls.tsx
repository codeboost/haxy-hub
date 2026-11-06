import { useState } from "react"
import { Link, useLocation } from "react-router"
import { DropdownMenu } from "radix-ui"
import { ChevronDown, FolderGit2, LogIn, LogOut, Plus, UserPlus, UserRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useConnection } from "@/app/connection"
import { useSession } from "@/app/session"
import { ApiError } from "@/lib/api"
import { loginPath, type Viewer } from "@/lib/session"

const menuItemClass = "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground [&_svg]:size-4 [&_svg]:text-muted-foreground"

function LoggedOut() {
  const location = useLocation()
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

function Avatar({ name }: { name: string }) {
  return <span aria-hidden className="grid size-6 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-foreground uppercase">{name.slice(0, 1)}</span>
}

function UserMenu({ viewer, pending, onLogOut }: { viewer: Viewer; pending: boolean; onLogOut: () => void }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="sm" className="max-w-48">
          <Avatar name={viewer.name} />
          <span className="truncate"><span className="sr-only">Signed in as </span><span className="font-medium">{viewer.name}</span></span>
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-48 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
          <DropdownMenu.Item asChild className={menuItemClass}><Link to="/account"><UserRound />Account</Link></DropdownMenu.Item>
          <DropdownMenu.Item asChild className={menuItemClass}><Link to={`/users/${encodeURIComponent(viewer.name)}`}><FolderGit2 />Your repositories</Link></DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item className={menuItemClass} disabled={pending} onSelect={onLogOut}><LogOut />Log out</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** The header's viewer: a New repository button and a menu with Account and Log out, or Register and Log in links. Nothing in local mode. */
export function ViewerControls() {
  const { check } = useConnection()
  const { ready, viewer, logOut } = useSession()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (check?.kind !== "connected" || check.status.mode !== "server" || !ready) return null
  if (!viewer) return <LoggedOut />

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
    <div className="flex items-center gap-1">
      <Button asChild variant="ghost" size="icon-sm">
        <Link to="/repos/new" aria-label="New repository" title="New repository"><Plus /></Link>
      </Button>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <UserMenu viewer={viewer} pending={pending} onLogOut={() => void onLogOut()} />
    </div>
  )
}
