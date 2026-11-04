/**
 * Creating a repository for the signed-in viewer: empty, with a hash format,
 * or as a copy of a repository the viewer can read (which keeps its source's
 * hash format). Server mode only; local mode answers `unsupported`. Mirrors
 * haxy's src/api/repo_create.zig.
 */
import { ApiError, requestJson } from "@/lib/api"
import { asViewer, viewerHeader } from "@/lib/account"
import type { RepoAccess } from "@/lib/discovery"
import { getRepo } from "@/lib/repo"

export const repoCreatePath = "/api/v1/repos"

/** The hash formats Haxy creates repositories with, by the names the API uses. */
export const hashFormats = ["sha1", "sha256"] as const
export type HashFormat = (typeof hashFormats)[number]

export type NewRepo = {
  name: string
  description: string
  access: RepoAccess
  /** Ignored for a copy, which keeps its source's format. */
  hash: HashFormat
  /** The `owner:name` of a repository to copy; "" for an empty repository. */
  copy: string
}

/** Where the new repository is. */
export type CreatedRepo = { owner: string; name: string }

/**
 * Creates `repo` for `viewer` (who the form was loaded for). Rejects with
 * `validation` or `conflict` keyed by NewRepo's fields, `not_found` keyed by
 * `copy` when there is no such repository the viewer can see, or
 * ViewerChangedError.
 */
export function createRepo(viewer: string, repo: NewRepo): Promise<CreatedRepo> {
  const copying = repo.copy.length > 0
  const body = { name: repo.name, description: repo.description, access: repo.access, copy: repo.copy, ...(copying ? {} : { hash: repo.hash }) }
  // The viewer binding (asViewer and the header) is #04's, kept here only, for #30 to replace.
  return asViewer(viewer, () => requestJson<CreatedRepo>(repoCreatePath, {
    method: "POST",
    headers: { "Content-Type": "application/json", [viewerHeader]: viewer },
    body: JSON.stringify(body),
  }))
}

/**
 * Whether `owner`'s repository `name` exists now, for settling a creation
 * whose outcome is unknown before it is offered again (a retry would only be
 * told the name is taken). Rejects when Haxy can't say.
 */
export async function repoExists(owner: string, name: string): Promise<boolean> {
  try {
    await getRepo({ kind: "server", owner, name })
    return true
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_found") return false
    throw error
  }
}
