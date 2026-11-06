import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import type { RepoSection } from "@/lib/repo"

export type RepoTab = { section: RepoSection; label: string; href: string | null }

/** What the app header shows while a repository page is open. */
export type RepoHeaderInfo = {
  owner: string | null
  name: string
  isPrivate: boolean
  home: string
  tabs: RepoTab[]
  current: RepoSection
}

type Slot = { info: RepoHeaderInfo | null; show: (info: RepoHeaderInfo | null) => void }

const RepoHeaderContext = createContext<Slot>({ info: null, show: () => {} })

export function RepoHeaderProvider({ children }: { children: ReactNode }) {
  const [info, show] = useState<RepoHeaderInfo | null>(null)
  return <RepoHeaderContext.Provider value={{ info, show }}>{children}</RepoHeaderContext.Provider>
}

export function useRepoHeader(): RepoHeaderInfo | null {
  return useContext(RepoHeaderContext).info
}

/** Puts this repository in the app header while the calling page is mounted. */
export function useShowRepoHeader(info: RepoHeaderInfo) {
  const { show } = useContext(RepoHeaderContext)
  useEffect(() => {
    show(info)
    return () => show(null)
  }, [info, show])
}
