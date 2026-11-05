import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormMessage } from "@/components/form"

/**
 * A change whose outcome is unknown and which Haxy couldn't settle either
 * (the read that would have said what holds now failed too). It may still
 * land, so the change isn't offered again until "Check again" gets an
 * answer (docs/haxy-hub-front-end-spec.md: no retry before authoritative
 * state is read).
 */
export function Unresolved({ message, pending, onCheck }: { message: string; pending: boolean; onCheck(): void }) {
  return (
    <FormMessage kind="error">
      <p>{message}</p>
      <Button type="button" variant="outline" size="sm" className="mt-2 flex" onClick={onCheck} disabled={pending}><RefreshCw />Check again</Button>
    </FormMessage>
  )
}
