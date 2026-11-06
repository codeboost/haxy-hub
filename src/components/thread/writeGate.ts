import { useEffect, useState } from "react"

/** A writer on a page whose writes must not cross: it says while it is busy, and holds while another is. */
export type WriteGate = { blocked: boolean; onBusy(busy: boolean): void }

/** Tells `gate` (when there is one) whether its writer is busy, until it unmounts. */
export function useGateReport(gate: WriteGate | undefined, busy: boolean) {
  useEffect(() => {
    gate?.onBusy(busy)
    return () => { if (busy) gate?.onBusy(false) }
    // the gate's report goes to the page's state, whichever render made it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy])
}

/** A gate for each writer in `names`: each holds while any other is busy. */
export function useWriteGates<Name extends string>(names: readonly Name[]): Record<Name, WriteGate> {
  const [busy, setBusy] = useState<Partial<Record<Name, boolean>>>({})
  const gateOf = (name: Name): WriteGate => ({
    blocked: names.some((other) => other !== name && busy[other] === true),
    onBusy: (value) => setBusy((current) => current[name] === value ? current : { ...current, [name]: value }),
  })
  return Object.fromEntries(names.map((name) => [name, gateOf(name)])) as Record<Name, WriteGate>
}
