import { useEffect, useState } from "react"
import { useReadsPending } from "@/lib/resource"

const showAfterMs = 150
const hideAfterMs = 120

/** A thin bar along the top of the window while the next page waits on its reads; quick reads never show it. */
export function ReadsProgress() {
  const pending = useReadsPending()
  const [shown, setShown] = useState(false)
  // a page that reads one thing after another keeps one bar between its reads
  useEffect(() => {
    const timer = setTimeout(() => setShown(pending), pending ? showAfterMs : hideAfterMs)
    return () => clearTimeout(timer)
  }, [pending])
  if (!shown) return null
  return (
    <div role="progressbar" aria-label="Loading" className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden">
      <div className="h-full w-1/3 animate-[reads-progress_1s_ease-in-out_infinite] bg-primary" />
    </div>
  )
}
