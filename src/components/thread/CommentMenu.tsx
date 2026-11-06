import { useRef } from "react"
import { DropdownMenu } from "radix-ui"
import { Ellipsis, type LucideIcon } from "lucide-react"
import { destructiveMenuItemClass, menuContentClass, menuItemClass } from "@/components/ui/menu"

export type CommentMenuAction = { label: string; icon: LucideIcon; run(): void; disabled?: boolean; destructive?: boolean }

const MENU_OFFSET = 4

/**
 * A comment's own actions behind a ⋯ button. A chosen action moves focus
 * where it leads (an editor, a confirmation), so the menu doesn't hand focus
 * back to its button then; dismissing the menu does.
 */
export function CommentMenu({ actions }: { actions: CommentMenuAction[] }) {
  const chosen = useRef(false)
  if (actions.length === 0) return null
  return (
    <DropdownMenu.Root onOpenChange={(open) => { if (open) chosen.current = false }}>
      <DropdownMenu.Trigger aria-label="Comment actions"
        className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent">
        <Ellipsis size={16} aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={MENU_OFFSET} className={`min-w-36 ${menuContentClass}`}
          onCloseAutoFocus={(event) => { if (chosen.current) event.preventDefault() }}>
          {actions.map(({ label, icon: Icon, run, disabled, destructive }) => (
            <DropdownMenu.Item key={label} disabled={disabled} className={destructive ? destructiveMenuItemClass : menuItemClass}
              onSelect={() => { chosen.current = true; run() }}>
              <Icon aria-hidden />{label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
