/**
 * Administering a server repository as one of its owners: its settings, its
 * members, its default and protected branches, and (its main owner only)
 * deleting it. Every write is bound to the viewer the page was loaded for and
 * is authorized again by Haxy when it lands. Local mode answers `unsupported`.
 * Mirrors haxy's src/api/repo_admin.zig.
 */
import { getJson, requestJson, ViewerChangedError, type ActionAvailability, type Page, type PageQuery, type RequestOptions } from "@/lib/api"
import type { RepoAccess } from "@/lib/discovery"
import { canonicalPath, type RefId, type RepoLocator } from "@/lib/repo"
import { repoExists } from "@/lib/repoCreate"
import { fetchSession } from "@/lib/session"

/** The server repository being administered. */
export type AdminRepo = Extract<RepoLocator, { kind: "server" }>

/** Who may start a kind of thread: nobody (it's turned off), members (and owners), or anybody who can read the repository. */
export const threadRoles = ["nobody", "members", "anybody"] as const
export type ThreadRole = (typeof threadRoles)[number]

export type RepoSettings = {
  owner: string
  name: string
  /** Identifies these settings; a change names the revision it was made from. Opaque. */
  revision: string
  description: string
  access: RepoAccess
  discuss_role: ThreadRole
  issue_role: ThreadRole
  patch_role: ThreadRole
  /** Fixed when the repository was created; shown, never changed. */
  hash: "sha1" | "sha256"
  /** The creator, who always owns the repository and alone may delete it. */
  main_owner: string
  actions: { delete: ActionAvailability }
}

export type SettingsChange = Pick<RepoSettings, "description" | "access" | "discuss_role" | "issue_role" | "patch_role">

export type MemberRole = "owner" | "member"
export type Member = { name: string; role: MemberRole }
/** A member write's result: the member's role now, null once revoked. */
export type MemberResult = { name: string; role: MemberRole | null }
export type MembersPage = Page<Member> & { main_owner: string }

export type BranchName = { name: string; id: RefId }
export type RepoBranches = {
  /** The branch HEAD names; null when it names none. */
  default_branch: BranchName | null
  protected: BranchName[]
  max_protected: number
}

type Options = Pick<RequestOptions, "signal">

function base(repo: AdminRepo): string {
  return `/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
}

function write<T>(path: string, method: string, viewer: string, body?: unknown): Promise<T> {
  // bound to the viewer the page was loaded for (requestJson sends X-Haxy-Viewer)
  return requestJson<T>(path, {
    method,
    viewer,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  })
}

/**
 * A branch name as someone typed it, as the canonical ref id Haxy writes for
 * it (its UTF-8 bytes, a literal `%` included, encoded as Haxy encodes them),
 * so it compares equal to the ids Haxy sends.
 */
export function branchId(name: string): RefId {
  return `branch:${canonicalPath(encodeURIComponent(name))}`
}

export function getSettings(repo: AdminRepo, options: Options = {}): Promise<RepoSettings> {
  return getJson<RepoSettings>(`${base(repo)}/settings`, options)
}

/**
 * Changes the settings as of `change.revision` (the settings it was made
 * from). Rejects with `conflict` keyed by `revision` when another change of
 * them landed since, `validation` keyed by SettingsChange's fields, or
 * `forbidden`/`not_found` once the viewer no longer owns or sees it.
 */
export function changeSettings(repo: AdminRepo, viewer: string, change: SettingsChange & { revision: string }): Promise<RepoSettings> {
  return write<RepoSettings>(`${base(repo)}/settings`, "PUT", viewer, change)
}

export function listMembers(repo: AdminRepo, query: PageQuery = {}, options: Options = {}): Promise<MembersPage> {
  const params = new URLSearchParams()
  if (query.cursor) params.set("cursor", query.cursor)
  if (query.page_size !== undefined) params.set("page_size", String(query.page_size))
  const text = params.toString()
  return getJson<MembersPage>(`${base(repo)}/settings/members${text ? `?${text}` : ""}`, options)
}

/** Adds `name` as a member. Rejects with `not_found` (no such user) or `conflict` (already a member or owner), keyed by `name`. */
export function addMember(repo: AdminRepo, viewer: string, name: string): Promise<MemberResult> {
  return write<MemberResult>(`${base(repo)}/settings/members`, "POST", viewer, { name })
}

/** Promotes or demotes a member. Rejects with `conflict` when their role changed meanwhile, `forbidden` for the main owner. */
export function setMemberRole(repo: AdminRepo, viewer: string, name: string, role: MemberRole): Promise<MemberResult> {
  return write<MemberResult>(`${base(repo)}/settings/members/${encodeURIComponent(name)}`, "PUT", viewer, { role })
}

export function revokeMember(repo: AdminRepo, viewer: string, name: string): Promise<MemberResult> {
  return write<MemberResult>(`${base(repo)}/settings/members/${encodeURIComponent(name)}`, "DELETE", viewer)
}

export function getBranches(repo: AdminRepo, options: Options = {}): Promise<RepoBranches> {
  return getJson<RepoBranches>(`${base(repo)}/settings/branches`, options)
}

/** Rejects with `not_found` keyed by `ref` when there is no such branch. */
export function setDefaultBranch(repo: AdminRepo, viewer: string, ref: RefId): Promise<RepoBranches> {
  return write<RepoBranches>(`${base(repo)}/settings/branches/default`, "PUT", viewer, { ref })
}

/** Rejects with `not_found`, `conflict` (already protected) or `validation` (too many), keyed by `ref`. */
export function protectBranch(repo: AdminRepo, viewer: string, ref: RefId): Promise<RepoBranches> {
  return write<RepoBranches>(`${base(repo)}/settings/branches/protected`, "POST", viewer, { ref })
}

/** Unprotects the branch `ref` names (Haxy's id, sent back unchanged); one that isn't protected changes nothing. */
export function unprotectBranch(repo: AdminRepo, viewer: string, ref: RefId): Promise<RepoBranches> {
  return write<RepoBranches>(`${base(repo)}/settings/branches/protected?ref=${ref}`, "DELETE", viewer)
}

/**
 * Deletes the repository, as its main owner, after the typed `owner:name`
 * and the password. Rejects with `validation` keyed by `confirm` or
 * `password`, or `forbidden` for anyone but the main owner.
 */
export function deleteRepo(repo: AdminRepo, viewer: string, fields: { confirm: string; password: string }): Promise<{ owner: string; name: string }> {
  return write<{ owner: string; name: string }>(base(repo), "DELETE", viewer, fields)
}

/**
 * Whether `repo` exists now as `viewer` sees it, to settle a deletion whose
 * outcome is unknown. Hidden and missing look the same, so the answer counts
 * only while `viewer` is still the one signed in: otherwise (another tab
 * signed out or in as someone else) it rejects with ViewerChangedError.
 */
export async function repoExistsFor(repo: AdminRepo, viewer: string): Promise<boolean> {
  const exists = await repoExists(repo.owner, repo.name)
  const now = await fetchSession()
  if (now.viewer?.name !== viewer) throw new ViewerChangedError(viewer, now.viewer)
  return exists
}
