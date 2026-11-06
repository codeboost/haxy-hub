import type { APIRequestContext, Page, Route } from "@playwright/test"
import { alice, writeHeaders, type Account } from "./support/accounts"
import { expect, test } from "./support/fixtures"
import { localGit } from "./support/history"
import { closePatch, createBranchPatch, divergeBranch, removePatch, tuiPatchPage, tuiPatches } from "./support/patches"
import { bob, mergeRepo } from "./support/patchMerge"

// Merging and squash-merging a patch in the browser, through Vite's proxy
// against a real Haxy. Every merge is checked again after a refresh and in
// Haxy's own server-rendered patches pages (the TUI's).

const header = (page: Page) => page.getByRole("banner")
const mergeActions = (page: Page) => page.getByRole("group", { name: "Merge actions" })
const proposal = (page: Page) => page.getByRole("region", { name: "Proposal" })
const mergePattern = (id: string) => new RegExp(`/patches/${id}/merge$`)

async function logIn(page: Page, hubUrl: string, account: Account, next: string) {
  await page.goto(`${hubUrl}/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel("Username").fill(account.name)
  await page.getByLabel("Password").fill(account.password)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(header(page)).toContainText(`Signed in as ${account.name}`)
}

/** Counts the merges the page sends. */
function countMerges(page: Page, id: string) {
  const merges: string[] = []
  page.on("request", (request) => {
    if (request.method() === "POST" && mergePattern(id).test(new URL(request.url()).pathname)) merges.push(request.url())
  })
  return merges
}

/** Handles the first merge of patch `id` with `handler`; everything else goes on as usual. */
async function onFirstMerge(page: Page, id: string, handler: (route: Route) => Promise<void>) {
  let pending = true
  await page.route(mergePattern(id), async (route) => {
    if (route.request().method() !== "POST" || !pending) return route.fallback()
    pending = false
    await handler(route)
  })
}

const patchRead = (id: string) => new RegExp(`/api/v1/repos/alice/parser/patches/${id}$`)
const internal = { status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Haxy failed." } }) }

/** Merges patch `id` with its commits as another client would, moving the target. */
async function mergeOutOfBand(owner: APIRequestContext, hubUrl: string, id: string) {
  const path = `${hubUrl}/api/v1/repos/alice/parser/patches/${id}`
  const patch = await (await owner.get(path)).json()
  const headers = { ...(await writeHeaders(owner, hubUrl)), "Content-Type": "application/json" }
  const landed = await owner.post(`${path}/merge`, { headers, data: { method: "source", revision: patch.revision.id, target_commit: patch.target.commit } })
  expect(landed.status(), await landed.text()).toBe(200)
}

async function confirmMerge(page: Page, button: "Merge" | "Squash and merge") {
  await mergeActions(page).getByRole("button", { name: button, exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: button, exact: true }).click()
}

test.describe("on a server", () => {
  test("a writer squash-merges a patch after confirming; it shows merged, after a refresh and in Haxy's own pages", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, feature, docs } = await mergeRepo(playwright, backend, hub.url)
    const targetTip = async () => (await (await owner.get(`${hub.url}/api/v1/repos/alice/parser/patches/${docs}`)).json()).target.commit as string
    const before = await targetTip()
    await logIn(page, hub.url, alice, `/repos/alice/parser/patches/${feature}`)
    await expect(page.getByRole("heading", { name: "Add a parser" })).toBeVisible()

    // cancelling asks nothing of Haxy
    const merges = countMerges(page, feature)
    await mergeActions(page).getByRole("button", { name: "Squash and merge" }).click()
    await expect(page.getByRole("alertdialog")).toContainText("Merge “Add a parser” into main as one squashed commit?")
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click()
    expect(merges).toEqual([])

    await confirmMerge(page, "Squash and merge")
    await expect(page.getByText("Merged into main.")).toBeVisible()
    await expect(page.getByLabel("Status")).toHaveText("Merged")
    await expect(proposal(page)).toContainText("As one squashed commit")
    await expect(mergeActions(page)).toHaveCount(0)
    expect(merges).toHaveLength(1)

    await page.reload()
    await expect(page.getByLabel("Status")).toHaveText("Merged")
    await expect(proposal(page)).toContainText("As one squashed commit")
    // the target branch moved on, and Haxy's own pages list the patch as merged
    expect(await targetTip()).not.toBe(before)
    expect((await tuiPatches(backend, "/alice:parser", "merged")).ids).toEqual([feature])
    expect(await tuiPatchPage(backend, "/alice:parser", feature)).toContain("merged")
    await owner.dispose()
  })

  test("a target that moved after the page loaded is refused with no success shown; read again, the merge lands", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, feature, docs } = await mergeRepo(playwright, backend, hub.url)
    await logIn(page, hub.url, alice, `/repos/alice/parser/patches/${feature}`)
    await expect(mergeActions(page).getByRole("button", { name: "Merge", exact: true })).toBeEnabled()

    // another client merges the docs into main meanwhile
    await mergeOutOfBand(owner, hub.url, docs)

    await confirmMerge(page, "Merge")
    await expect(page.getByRole("alert")).toContainText("The target branch moved since you loaded this patch.")
    await expect(page.getByText(/^Merged into/)).toHaveCount(0)
    await expect(page.getByLabel("Status")).toHaveText("Open")

    // the page read the patch again, so merging now merges what it shows
    await confirmMerge(page, "Merge")
    await expect(page.getByText("Merged into main.")).toBeVisible()
    await page.reload()
    await expect(page.getByLabel("Status")).toHaveText("Merged")
    await expect(proposal(page)).toContainText("With its source commits")
    expect((await tuiPatches(backend, "/alice:parser", "merged")).ids.sort()).toEqual([docs, feature].sort())
    await owner.dispose()
  })

  test("a target that moves while the confirmation is open merges nothing the user didn't confirm, even once the page has read the move", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, feature, docs } = await mergeRepo(playwright, backend, hub.url)
    await logIn(page, hub.url, alice, `/repos/alice/parser/patches/${feature}`)
    await mergeActions(page).getByRole("button", { name: "Merge", exact: true }).click()
    await expect(page.getByRole("alertdialog")).toBeVisible()

    // the target moves, and an upload on the page reads the patch (and the new tip) again behind the open confirmation
    await mergeOutOfBand(owner, hub.url, docs)
    const reread = page.waitForResponse((response) => response.request().method() === "GET" && patchRead(feature).test(new URL(response.url()).pathname))
    await page.getByRole("form", { name: "Attach a file" }).getByLabel("Attach a file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes\n") })
    await page.getByRole("form", { name: "Attach a file" }).getByRole("button", { name: "Attach file" }).click()
    await reread
    await expect(page.getByRole("alertdialog")).toBeVisible()

    await page.getByRole("alertdialog").getByRole("button", { name: "Merge", exact: true }).click()
    await expect(page.getByRole("alert")).toContainText("The target branch moved since you loaded this patch.")
    await expect(page.getByText(/^Merged into/)).toHaveCount(0)
    const detail = await (await owner.get(`${hub.url}/api/v1/repos/alice/parser/patches/${feature}`)).json()
    expect(detail.status).toBe("open")
    await owner.dispose()
  })

  test("a refusal whose follow-up read fails keeps merging blocked until checking the patch again succeeds", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, feature, docs } = await mergeRepo(playwright, backend, hub.url)
    await logIn(page, hub.url, alice, `/repos/alice/parser/patches/${feature}`)
    await expect(mergeActions(page).getByRole("button", { name: "Merge", exact: true })).toBeEnabled()
    await mergeOutOfBand(owner, hub.url, docs)

    // once the merge is sent, the patch can't be read until the flag clears
    let failReads = false
    await page.route(patchRead(feature), async (route) => {
      if (route.request().method() !== "GET" || !failReads) return route.fallback()
      await route.fulfill(internal)
    })
    await onFirstMerge(page, feature, async (route) => {
      failReads = true
      await route.fallback()
    })
    await confirmMerge(page, "Merge")
    await expect(page.getByRole("alert")).toContainText("The target branch moved since you loaded this patch.")
    const checkAgain = page.getByRole("button", { name: "Check the patch again" })
    await expect(checkAgain).toBeVisible()
    await expect(mergeActions(page).getByRole("button", { name: "Merge", exact: true })).toBeDisabled()
    await expect(mergeActions(page).getByRole("button", { name: "Squash and merge" })).toBeDisabled()

    // a check that fails too keeps it blocked; one that reads the patch offers the merge again
    await checkAgain.click()
    await expect(page.getByRole("alert")).toContainText("Haxy failed.")
    await expect(mergeActions(page).getByRole("button", { name: "Merge", exact: true })).toBeDisabled()
    failReads = false
    await checkAgain.click()
    await expect(checkAgain).toHaveCount(0)
    await confirmMerge(page, "Merge")
    await expect(page.getByText("Merged into main.")).toBeVisible()
    await owner.dispose()
  })

  test("a refused merge holds the status actions until its follow-up read lands", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, feature, docs } = await mergeRepo(playwright, backend, hub.url)
    await logIn(page, hub.url, alice, `/repos/alice/parser/patches/${feature}`)
    await expect(mergeActions(page).getByRole("button", { name: "Merge", exact: true })).toBeEnabled()
    await mergeOutOfBand(owner, hub.url, docs)

    // the read after the refusal reads the open patch, then waits; once it is answered, later reads fail
    let release = () => {}
    const released = new Promise<void>((resolve) => { release = resolve })
    let phase: "before" | "holding" | "held" | "failing" = "before"
    await page.route(patchRead(feature), async (route) => {
      if (route.request().method() !== "GET") return route.fallback()
      if (phase === "failing") return route.fulfill(internal)
      if (phase !== "holding") return route.fallback()
      phase = "held"
      const response = await route.fetch()
      await released
      phase = "failing"
      await route.fulfill({ response })
    })
    await onFirstMerge(page, feature, async (route) => {
      phase = "holding"
      await route.fallback()
    })
    await confirmMerge(page, "Merge")
    await expect(page.getByRole("alert")).toContainText("The target branch moved since you loaded this patch.")
    await expect.poll(() => phase).toBe("held")

    // the patch can't be closed while that read is in flight, so its answer can't cross a close
    const close = page.getByRole("group", { name: "Patch actions" }).getByRole("button", { name: "Close patch" })
    await expect(close).toBeDisabled()
    release()
    await expect.poll(() => phase).toBe("failing")
    await expect(close).toBeEnabled()
    await expect(page.getByLabel("Status")).toHaveText("Open")
    await owner.dispose()
  })

  test("after a refused merge the whole page is read again, so a file another client attached meanwhile shows", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, feature, docs } = await mergeRepo(playwright, backend, hub.url)
    await logIn(page, hub.url, alice, `/repos/alice/parser/patches/${feature}`)
    await expect(mergeActions(page).getByRole("button", { name: "Merge", exact: true })).toBeEnabled()

    // another client attaches a file and moves the target
    const headers = { ...(await writeHeaders(owner, hub.url)), "Content-Type": "application/octet-stream" }
    const attached = await owner.post(`${hub.url}/api/v1/repos/alice/parser/patches/${feature}/attachments?name=notes.txt`, { headers, data: Buffer.from("notes\n") })
    expect(attached.status(), await attached.text()).toBe(201)
    await mergeOutOfBand(owner, hub.url, docs)

    await confirmMerge(page, "Merge")
    await expect(page.getByRole("alert")).toContainText("The target branch moved since you loaded this patch.")
    await expect(page.getByRole("region", { name: "Attachments" }).getByRole("list", { name: "Attached files" }).getByRole("link", { name: /notes\.txt/ })).toBeVisible()
    await owner.dispose()
  })

  test("a close whose outcome is unknown holds merging until the read that settles it lands", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, feature } = await mergeRepo(playwright, backend, hub.url)
    await logIn(page, hub.url, alice, `/repos/alice/parser/patches/${feature}`)
    await expect(mergeActions(page).getByRole("button", { name: "Merge", exact: true })).toBeEnabled()

    // the close fails without landing; the read that settles it reads the open patch, then waits; once answered, later reads fail
    let release = () => {}
    const released = new Promise<void>((resolve) => { release = resolve })
    let phase: "before" | "holding" | "held" | "failing" = "before"
    await page.route(patchRead(feature), async (route) => {
      if (route.request().method() !== "GET") return route.fallback()
      if (phase === "failing") return route.fulfill(internal)
      if (phase !== "holding") return route.fallback()
      phase = "held"
      const response = await route.fetch()
      await released
      phase = "failing"
      await route.fulfill({ response })
    })
    let closing = true
    await page.route(new RegExp(`/patches/${feature}/status$`), async (route) => {
      if (route.request().method() !== "PUT" || !closing) return route.fallback()
      closing = false
      phase = "holding"
      await route.fulfill(internal)
    })
    await page.getByRole("group", { name: "Patch actions" }).getByRole("button", { name: "Close patch" }).click()
    await expect.poll(() => phase).toBe("held")

    // the patch can't be merged while that read is in flight, so its answer can't cross a merge
    const merge = mergeActions(page).getByRole("button", { name: "Merge", exact: true })
    await expect(merge).toBeDisabled()
    release()
    await expect.poll(() => phase).toBe("failing")
    await expect(page.getByText(/couldn't confirm what happened to this request/)).toBeVisible()
    await expect(page.getByLabel("Status")).toHaveText("Open")
    await expect(merge).toBeEnabled()
    await owner.dispose()
  })

  test("a patch removed while its merge is being confirmed leads back to the list, not to an endless check", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, feature } = await mergeRepo(playwright, backend, hub.url)
    await logIn(page, hub.url, alice, `/repos/alice/parser/patches/${feature}`)
    await mergeActions(page).getByRole("button", { name: "Merge", exact: true }).click()
    await expect(page.getByRole("alertdialog")).toBeVisible()

    await removePatch(owner, backend, "/alice:parser", feature)
    await page.getByRole("alertdialog").getByRole("button", { name: "Merge", exact: true }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/alice/parser/patches`)
    await expect(page.getByRole("button", { name: "Check the patch again" })).toHaveCount(0)
    await owner.dispose()
  })

  test("the page writes the patch's status and merges it one at a time", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, feature } = await mergeRepo(playwright, backend, hub.url)
    await closePatch(owner, backend, "/alice:parser", feature)
    await logIn(page, hub.url, alice, `/repos/alice/parser/patches/${feature}`)
    await expect(page.getByLabel("Status")).toHaveText("Closed")
    const patchActions = page.getByRole("group", { name: "Patch actions" })

    // the reopen lands, but its answer is held; an upload meanwhile reads the reopened patch
    let releaseReopen = () => {}
    const reopenHeld = new Promise<void>((resolve) => { releaseReopen = resolve })
    await page.route(new RegExp(`/patches/${feature}/status$`), async (route) => {
      if (route.request().method() !== "PUT") return route.fallback()
      const response = await route.fetch()
      await reopenHeld
      await route.fulfill({ response })
    })
    await patchActions.getByRole("button", { name: "Reopen patch" }).click()
    await page.getByRole("form", { name: "Attach a file" }).getByLabel("Attach a file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes\n") })
    await page.getByRole("form", { name: "Attach a file" }).getByRole("button", { name: "Attach file" }).click()
    await expect(page.getByLabel("Status")).toHaveText("Open")
    // no merge while the reopen is unanswered
    await expect(mergeActions(page).getByRole("button", { name: "Merge", exact: true })).toBeDisabled()
    releaseReopen()
    await expect(patchActions.getByRole("button", { name: "Close patch" })).toBeEnabled()

    // while a merge is unanswered, the status can't change
    let releaseMerge = () => {}
    const mergeHeld = new Promise<void>((resolve) => { releaseMerge = resolve })
    await onFirstMerge(page, feature, async (route) => {
      const response = await route.fetch()
      await mergeHeld
      await route.fulfill({ response })
    })
    await confirmMerge(page, "Merge")
    await expect(patchActions.getByRole("button", { name: "Close patch" })).toBeDisabled()
    releaseMerge()
    await expect(page.getByText("Merged into main.")).toBeVisible()
    await expect(page.getByLabel("Status")).toHaveText("Merged")
    await owner.dispose()
  })

  test("a merge whose answer is lost is not retried; the page reads the patch to say what happened", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, feature } = await mergeRepo(playwright, backend, hub.url)
    await logIn(page, hub.url, alice, `/repos/alice/parser/patches/${feature}`)
    await expect(page.getByRole("heading", { name: "Add a parser" })).toBeVisible()
    const merges = countMerges(page, feature)
    // the merge lands, but its answer never reaches the page
    await onFirstMerge(page, feature, async (route) => {
      await route.fetch()
      await route.abort("connectionreset")
    })

    await confirmMerge(page, "Merge")
    await expect(page.getByRole("alert")).toContainText("Haxy couldn't confirm whether the patch was merged")
    await expect(page.getByLabel("Status")).toHaveText("Merged")
    expect(merges).toHaveLength(1)
    await expect(mergeActions(page)).toHaveCount(0)
    await owner.dispose()
  })

  test("a reader sees why they can't merge", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, other, feature } = await mergeRepo(playwright, backend, hub.url)
    await logIn(page, hub.url, bob, `/repos/alice/parser/patches/${feature}`)
    await expect(page.getByLabel("Merge unavailable")).toHaveText("Only the repository's writers can merge its patches.")
    await expect(mergeActions(page)).toHaveCount(0)
    await owner.dispose()
    await other.dispose()
  })
})

test("local mode shows merging as unavailable, with the reason", async ({ page, launch }) => {
  const backend = await launch.local()
  divergeBranch(localGit(backend), "feature", [{ message: "Add the parser", files: { "src/parser.txt": "parse\n" } }])
  const hub = await launch.hub(backend.port)
  const id = await createBranchPatch(page.request, backend, "", { title: "Add a parser", source: "feature", target: "main" })
  await page.goto(`${hub.url}/repo/patches/${id}`)
  await expect(page.getByLabel("Merge unavailable")).toHaveText("Local mode doesn't merge patches; merge the branches with Git.")
  await expect(mergeActions(page)).toHaveCount(0)
})
