import type { APIRequestContext, PlaywrightWorkerArgs } from "@playwright/test"
import { writeHeaders } from "./accounts"
import type { Launch } from "./fixtures"
import { localGit } from "./history"
import { divergeBranch, setPatchRole } from "./patches"
import { sharedRepo, syncFixture, type SyncFixture } from "./sync"

/**
 * Real metadata conflicts: local mode and a Haxy server share `alice:shared`
 * (see `syncFixture`); a thread is written here and synced, then edited on
 * both sides from that same version, and a second sync merges the two
 * histories with Haxy's own field-by-field merge, which records the
 * conflict here and, once pushed, on the server too.
 */

export const localApi = "/api/v1/repo"
export const serverApi = `/api/v1/repos/${sharedRepo.owner}/${sharedRepo.name}`

const baseDescription = "Intro.\nBase words.\nOutro."
export const localSide = { title: "Local title", description: "Intro.\nLocal words.\nOutro." }
export const serverSide = { title: "Server title", description: "Intro.\nServer words.\nOutro." }

/** Sends a JSON write through a hub, with the CSRF token a same-origin page would carry, and fails on an error answer. */
export async function sendJson(request: APIRequestContext, hubUrl: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await rawSend(request, hubUrl, method, path, body)
  if (!response.ok()) throw new Error(`${method} ${path}: HTTP ${response.status()} ${await response.text()}`)
  return response.status() === 204 ? null : response.json()
}

/** `sendJson` without the check, for answers a test inspects. */
export async function rawSend(request: APIRequestContext, hubUrl: string, method: string, path: string, body?: unknown) {
  const headers = { ...(await writeHeaders(request, hubUrl)), "Content-Type": "application/json" }
  return request.fetch(`${hubUrl}${path}`, { method, headers, data: body === undefined ? undefined : JSON.stringify(body) })
}

export async function getJson<T>(request: APIRequestContext, url: string): Promise<T> {
  const response = await request.get(url)
  if (!response.ok()) throw new Error(`GET ${url}: HTTP ${response.status()} ${await response.text()}`)
  return response.json() as Promise<T>
}

/** Syncs local mode with its remote, and fails unless the sync went through. */
export async function sync(request: APIRequestContext, fixture: SyncFixture): Promise<void> {
  const answer = (await sendJson(request, fixture.hub.url, "POST", `${localApi}/sync`)) as { last: { outcome: string; failure: unknown } }
  if (answer.last.outcome !== "synced") throw new Error(`The sync failed: ${JSON.stringify(answer.last.failure)}`)
}

type Thread = { id: string; revision: string; edit_revision?: string }

export type Diverged = SyncFixture & { id: string }

/** An issue whose title and description were edited differently here and on the server, merged into a conflict by a sync. */
export async function divergedIssue(playwright: PlaywrightWorkerArgs["playwright"], request: APIRequestContext, launch: Launch): Promise<Diverged> {
  const fixture = await syncFixture(playwright, launch)
  const issue = (await sendJson(request, fixture.hub.url, "POST", `${localApi}/issues`, { title: "Shared", labels: "", description: baseDescription })) as Thread
  await sync(request, fixture)
  await sendJson(request, fixture.hub.url, "PATCH", `${localApi}/issues/${issue.id}`, { revision: issue.revision, labels: "", ...localSide })
  const there = await getJson<Thread>(fixture.owner, `${fixture.serverHub.url}${serverApi}/issues/${issue.id}`)
  await sendJson(fixture.owner, fixture.serverHub.url, "PATCH", `${serverApi}/issues/${issue.id}`, { revision: there.revision, labels: "", ...serverSide })
  await sync(request, fixture)
  return { ...fixture, id: issue.id }
}

export const branchIds = { source: "branch:feature", main: "branch:main", local: "branch:release-a", server: "branch:release-b" }

/**
 * A branch-backed patch from `feature` whose title, description and target
 * were changed differently here (`release-a`) and on the server
 * (`release-b`), merged into a conflict by a sync. Retargeting captures a
 * new revision on each side, so the revision conflicts too.
 */
export async function divergedPatch(playwright: PlaywrightWorkerArgs["playwright"], request: APIRequestContext, launch: Launch): Promise<Diverged> {
  const fixture = await syncFixture(playwright, launch)
  const git = localGit(fixture.local)
  divergeBranch(git, "feature", [{ message: "Add the feature", files: { "feature.txt": "new\n" } }])
  git(["branch", "release-a", "main"])
  git(["branch", "release-b", "main"])
  await fixture.ssh.git(fixture.local.dataDir, "push", "--quiet", fixture.url, "feature:feature", "release-a:release-a", "release-b:release-b")
  await setPatchRole(fixture.owner, fixture.server, sharedRepo, "anybody")
  const patch = (await sendJson(request, fixture.hub.url, "POST", `${localApi}/patches`, { title: "Shared", labels: "", description: baseDescription, source: branchIds.source, target: branchIds.main })) as Thread
  await sync(request, fixture)
  await sendJson(request, fixture.hub.url, "PATCH", `${localApi}/patches/${patch.id}`, { revision: patch.edit_revision, labels: "", target: branchIds.local, ...localSide })
  const there = await getJson<Thread>(fixture.owner, `${fixture.serverHub.url}${serverApi}/patches/${patch.id}`)
  await sendJson(fixture.owner, fixture.serverHub.url, "PATCH", `${serverApi}/patches/${patch.id}`, { revision: there.edit_revision, labels: "", target: branchIds.server, ...serverSide })
  await sync(request, fixture)
  return { ...fixture, id: patch.id }
}
