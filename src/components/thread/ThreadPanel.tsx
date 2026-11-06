import { useState, type ReactNode } from "react"
import { Settings2, X } from "lucide-react"

/** Where a part of a thread page sits: a section of the page's column, or of its sidebar. */
export type PanelFrame = "section" | "sidebar"

function PanelToggle({ label, open, onToggle }: { label: string; open: boolean; onToggle(): void }) {
  return (
    <button type="button" aria-expanded={open} aria-label={label} title={label} onClick={onToggle}
      className="grid size-6 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      {open ? <X size={14} aria-hidden /> : <Settings2 size={14} aria-hidden />}
    </button>
  )
}

/**
 * A titled part of a thread page. In the sidebar, a part with `compact`
 * content shows it, and `edit` names a toggle that shows `children` (its
 * editing controls) in its place; `edit` is left out when the viewer may
 * change nothing there.
 */
export function ThreadPanel({ id, title, frame, compact, edit, children }: { id: string; title: string; frame: PanelFrame; compact?: ReactNode; edit?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  if (frame === "section") {
    return (
      <section aria-labelledby={id} className="mt-6">
        <h3 id={id} className="mb-2 text-sm font-semibold">{title}</h3>
        {children}
      </section>
    )
  }
  const editing = edit !== undefined && open
  return (
    <section aria-labelledby={id} className="py-4 first:pt-0 last:pb-0">
      <div className="mb-2 flex min-h-6 items-center justify-between gap-2">
        <h3 id={id} className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
        {edit !== undefined && <PanelToggle label={edit} open={editing} onToggle={() => setOpen((value) => !value)} />}
      </div>
      {editing || compact === undefined ? children : compact}
    </section>
  )
}
