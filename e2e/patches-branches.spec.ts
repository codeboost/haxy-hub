import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Page } from "@playwright/test"
import type { FixtureRef } from "./support/backend"
import { expect, test } from "./support/fixtures"
import { branchPicker, chooseBranch, tuiPatchEditPage, tuiPatchPage, tuiPatches } from "./support/patches"

// Choosing a patch's branches in a repository with more branches than one
// list holds, by searching Haxy's branch list or typing a name, through Vite's
// proxy against a real Haxy. Every patch is checked again after a refresh, in
// Haxy's own server-rendered patch page (the TUI's).

const topicCount = 1100
const topic = (index: number) => `topic/${String(index).padStart(4, "0")}`
const proposal = (page: Page) => page.getByRole("region", { name: "Proposal" })

/** `main` and 1,100 topic branches at it, of which `topic/1050` is one commit ahead. */
const manyBranches: FixtureRef[] = Array.from({ length: topicCount }, (_, index): FixtureRef => (
  index === 1050 ? { kind: "branch", name: topic(index), files: { "feature.txt": "far down the list\n" } } : { kind: "branch", name: topic(index) }
))

test("in a repository with more than 1,000 branches, branches past the first 1,000 are found and chosen as source and target", async ({ page, request, launch }) => {
  const backend = await launch.local({ refs: manyBranches })
  const hub = await launch.hub(backend.port)

  await page.goto(`${hub.url}/repo/patches/new`)
  const form = page.getByRole("form", { name: "New patch" })
  await expect(branchPicker(form, "Target branch")).toHaveValue("main")
  await form.getByLabel("Title").fill("Far down the list")
  // searched and picked from the list
  await chooseBranch(form, "Source branch", "topic/105", topic(1050))
  // typed in full, without picking
  await branchPicker(form, "Target branch").fill(topic(1075))
  await form.getByRole("button", { name: "Open patch" }).click()
  await expect(page).toHaveURL(/\/repo\/patches\/[0-9a-f]{32}$/)
  const id = page.url().split("/").pop()!
  await page.reload()
  await expect(page.getByRole("heading", { level: 2, name: "Far down the list" })).toBeVisible()
  await expect(proposal(page)).toContainText(`Branch ${topic(1050)}`)
  await expect(proposal(page)).toContainText(`Branch ${topic(1075)}`)
  expect(await tuiPatchPage(backend, "", id)).toContain(topic(1050))
  expect(await tuiPatchEditPage(backend, "", id)).toContain(topic(1075))

  // retargeting to the last branch: its search's matches page on
  await page.goto(`${hub.url}/repo/patches/${id}/edit`)
  const edit = page.getByRole("form", { name: "Edit patch" })
  await expect(branchPicker(edit, "Target branch")).toHaveValue(topic(1075))
  await branchPicker(edit, "Target branch").fill("topic/1")
  await expect(edit.getByRole("option", { name: topic(1000), exact: true })).toBeVisible()
  await expect(edit.getByRole("option", { name: topic(1099), exact: true })).toHaveCount(0)
  await edit.getByRole("button", { name: "More branches" }).click()
  await edit.getByRole("option", { name: topic(1099), exact: true }).click()
  await expect(branchPicker(edit, "Target branch")).toHaveValue(topic(1099))
  await edit.getByRole("button", { name: "Save changes" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/patches/${id}`)
  await page.reload()
  await expect(proposal(page)).toContainText(`Branch ${topic(1099)}`)
  expect(await tuiPatchEditPage(backend, "", id)).toContain(topic(1099))
  const answer = await (await request.get(`${hub.url}/api/v1/repo/patches/${id}`)).json()
  expect(answer).toMatchObject({ source: { id: `branch:${topic(1050)}` }, target: { id: `branch:${topic(1099)}` } })
})

test("a name that names no branch is refused beside its field, and nothing is opened", async ({ page, launch }) => {
  const backend = await launch.local({ refs: [{ kind: "branch", name: "feature", files: { "feature.txt": "new\n" } }] })
  const hub = await launch.hub(backend.port)

  await page.goto(`${hub.url}/repo/patches/new`)
  const form = page.getByRole("form", { name: "New patch" })
  await form.getByLabel("Title").fill("Nowhere")
  await branchPicker(form, "Source branch").fill("no-such-branch")
  await expect(form.getByText("No branch starts with “no-such-branch”.")).toBeVisible()
  await form.getByRole("button", { name: "Open patch" }).click()
  await expect(form.getByText("There is no such branch.")).toBeVisible()
  await expect(branchPicker(form, "Source branch")).toHaveAttribute("aria-invalid", "true")
  await expect(branchPicker(form, "Source branch")).toHaveValue("no-such-branch")

  await chooseBranch(form, "Source branch", "feat", "feature")
  await branchPicker(form, "Target branch").fill("mai")
  await form.getByRole("button", { name: "Open patch" }).click()
  await expect(branchPicker(form, "Target branch")).toHaveAttribute("aria-invalid", "true")
  await expect(form.getByText("There is no such branch.")).toBeVisible()
  expect((await tuiPatches(backend, "", "open")).ids).toEqual([])

  await chooseBranch(form, "Target branch", "mai", "main")
  await form.getByRole("button", { name: "Open patch" }).click()
  await expect(page).toHaveURL(/\/repo\/patches\/[0-9a-f]{32}$/)
  await page.reload()
  await expect(proposal(page)).toContainText("Branch feature")
  expect((await tuiPatches(backend, "", "open")).ids).toHaveLength(1)
})

test("branches whose names aren't UTF-8 and show alike are told apart, and the default target is the exact default branch", async ({ page, request, launch }) => {
  const e8 = Uint8Array.from([...Buffer.from("caf"), 0xe8])
  const e9 = Uint8Array.from([...Buffer.from("caf"), 0xe9])
  const backend = await launch.local({ refs: [{ kind: "branch", name: e8, files: { "e8.txt": "e8\n" } }, { kind: "branch", name: e9, files: { "e9.txt": "e9\n" } }] })
  writeFileSync(path.join(backend.dataDir, ".git", "HEAD"), Buffer.concat([Buffer.from("ref: refs/heads/"), Buffer.from(e9), Buffer.from("\n")]))
  const hub = await launch.hub(backend.port)

  await page.goto(`${hub.url}/repo/patches/new`)
  const form = page.getByRole("form", { name: "New patch" })
  await expect(branchPicker(form, "Target branch")).toHaveValue("caf�")
  await expect(form.getByText("Chosen branch: caf%E9")).toBeVisible()
  await form.getByLabel("Title").fill("From e8")
  await branchPicker(form, "Source branch").fill("caf")
  await expect(form.getByRole("option", { name: /^caf�/ })).toHaveText(["caf� (caf%E8)", "caf� (caf%E9)"])
  await form.getByRole("option", { name: "caf� (caf%E8)" }).click()
  await expect(form.getByText("Chosen branch: caf%E8")).toBeVisible()
  await form.getByRole("button", { name: "Open patch" }).click()
  await expect(page).toHaveURL(/\/repo\/patches\/[0-9a-f]{32}$/)
  const id = page.url().split("/").pop()!

  await page.reload()
  await expect(page.getByRole("heading", { level: 2, name: "From e8" })).toBeVisible()
  // Haxy's own pages can't render a repository holding a branch name that isn't UTF-8, so Haxy's API is the check here
  const answer = await (await request.get(`${hub.url}/api/v1/repo/patches/${id}`)).json()
  expect(answer).toMatchObject({ title: "From e8", source: { id: "branch:caf%E8" }, target: { id: "branch:caf%E9" } })

  // the edit form holds the exact target too, and saves it unchanged
  await page.goto(`${hub.url}/repo/patches/${id}/edit`)
  const edit = page.getByRole("form", { name: "Edit patch" })
  await expect(edit.getByText("Chosen branch: caf%E9")).toBeVisible()
  await edit.getByLabel("Title").fill("From e8, edited")
  await edit.getByRole("button", { name: "Save changes" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/patches/${id}`)
  await page.reload()
  await expect(page.getByRole("heading", { level: 2, name: "From e8, edited" })).toBeVisible()
  expect(await (await request.get(`${hub.url}/api/v1/repo/patches/${id}`)).json()).toMatchObject({ target: { id: "branch:caf%E9" } })
})

test("the branch list is used from the keyboard: arrows keep the active branch in sight, its next page and a retry are reached with Tab", async ({ page, launch }) => {
  const backend = await launch.local({ refs: manyBranches })
  const hub = await launch.hub(backend.port)
  await page.goto(`${hub.url}/repo/patches/new`)
  const form = page.getByRole("form", { name: "New patch" })
  const source = branchPicker(form, "Source branch")
  const list = form.getByRole("listbox", { name: "Source branch" })
  const activeOption = async () => page.locator(`[id="${await source.getAttribute("aria-activedescendant")}"]`)

  await source.fill("topic/1")
  await expect(list.getByRole("option", { name: topic(1049), exact: true })).toBeAttached()
  for (let step = 0; step < 30; step++) await source.press("ArrowDown")
  await expect(await activeOption()).toHaveText(topic(1029))
  await expect(await activeOption()).toBeInViewport()

  // the next page, from the keyboard: the field keeps the focus, at the first branch it added
  await source.press("Tab")
  await expect(form.getByRole("button", { name: "More branches" })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(source).toBeFocused()
  await expect(list.getByRole("option", { name: topic(1099), exact: true })).toBeAttached()
  await expect(await activeOption()).toHaveText(topic(1050))
  await source.press("Enter")
  await expect(source).toHaveValue(topic(1050))

  // a search that fails is tried again from the keyboard
  let failing = true
  await page.route(/\/api\/v1\/repo\/branches/, (route) => (failing ? route.abort("connectionreset") : route.fallback()))
  await source.fill("topic/0")
  await expect(form.getByRole("alert")).toContainText("Couldn't search the branches")
  failing = false
  await source.press("Tab")
  await expect(form.getByRole("button", { name: "Try again" })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(source).toBeFocused()
  await expect(list.getByRole("option", { name: topic(0), exact: true })).toBeVisible()
})

test("reading the next page of a reopened list isn't undone by the list's own refresh", async ({ page, launch }) => {
  const backend = await launch.local({ refs: manyBranches })
  const hub = await launch.hub(backend.port)
  await page.clock.install()
  await page.goto(`${hub.url}/repo/patches/new`)
  const form = page.getByRole("form", { name: "New patch" })
  const source = branchPicker(form, "Source branch")
  const list = form.getByRole("listbox", { name: "Source branch" })
  await source.fill("topic/1")
  await expect(list.getByRole("option", { name: topic(1049), exact: true })).toBeAttached()
  await source.press("Escape")
  await expect(list).toHaveCount(0)

  // reopened, the list shows what it had and refreshes it shortly; the next page is asked for before that
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000))
  await source.click()
  await form.getByRole("button", { name: "More branches" }).click()
  await page.clock.runFor(1000)
  await page.clock.resume()
  await expect(list.getByRole("option", { name: topic(1099), exact: true })).toBeAttached()
  await expect(list.getByRole("option")).toHaveCount(100)
})

test("keys that compose text in an input method are left to it", async ({ page, launch }) => {
  const backend = await launch.local({ refs: manyBranches })
  const hub = await launch.hub(backend.port)
  await page.goto(`${hub.url}/repo/patches/new`)
  const form = page.getByRole("form", { name: "New patch" })
  const source = branchPicker(form, "Source branch")
  const list = form.getByRole("listbox", { name: "Source branch" })
  const composing = (key: string) => source.evaluate((input, key) => input.dispatchEvent(new KeyboardEvent("keydown", { key, isComposing: true, bubbles: true, cancelable: true })), key)

  await source.fill("topic/1")
  await expect(list.getByRole("option", { name: topic(1000), exact: true })).toBeAttached()
  expect(await composing("ArrowDown")).toBe(true)
  await expect(source).not.toHaveAttribute("aria-activedescendant")
  await source.press("ArrowDown")
  await expect(source).toHaveAttribute("aria-activedescendant")
  expect(await composing("Enter")).toBe(true)
  expect(await composing("Escape")).toBe(true)
  await expect(source).toHaveValue("topic/1")
  await expect(list).toBeVisible()
  await source.press("Enter")
  await expect(source).toHaveValue(topic(1000))
})

test("a picked branch stays chosen when its list reopens on other branches", async ({ page, launch }) => {
  const backend = await launch.local({ refs: manyBranches })
  const hub = await launch.hub(backend.port)
  await page.goto(`${hub.url}/repo/patches/new`)
  const form = page.getByRole("form", { name: "New patch" })
  const source = branchPicker(form, "Source branch")
  const list = form.getByRole("listbox", { name: "Source branch" })

  await source.fill("topic/1")
  await expect(list.getByRole("option", { name: topic(1001), exact: true })).toBeAttached()
  await source.press("ArrowDown")
  await source.press("ArrowDown")
  await source.press("Enter")
  await expect(source).toHaveValue(topic(1001))

  // reopened, the list starts from the first branch, and nothing in it is active until an arrow moves there
  await source.click()
  await expect(list.getByRole("option", { name: "main", exact: true })).toBeVisible()
  await expect(source).not.toHaveAttribute("aria-activedescendant")
  await source.press("Enter")
  await expect(source).toHaveValue(topic(1001))
})

test("a reopened list's refresh keeps the focus in the picker, on its button while it stays", async ({ page, launch }) => {
  const backend = await launch.local({ refs: manyBranches })
  const hub = await launch.hub(backend.port)
  await page.clock.install()
  await page.goto(`${hub.url}/repo/patches/new`)
  const form = page.getByRole("form", { name: "New patch" })
  const source = branchPicker(form, "Source branch")
  const list = form.getByRole("listbox", { name: "Source branch" })
  const more = form.getByRole("button", { name: "More branches" })
  const firstPage = () => page.waitForResponse((response) => response.url().includes("/api/v1/repo/branches?") && !response.url().includes("cursor="))
  /** Reopens the list and tabs to its button before the refresh it schedules, then lets the refresh land. */
  const reopenAndTab = async () => {
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000))
    await source.click()
    await source.press("Tab")
    await expect(more).toBeFocused()
    const refreshed = firstPage()
    await page.clock.runFor(1000)
    await page.clock.resume()
    await refreshed
  }

  await source.fill("topic/10")
  await expect(list.getByRole("option", { name: topic(1049), exact: true })).toBeAttached()
  await source.press("Escape")
  await reopenAndTab()
  await expect(list.getByRole("option")).toHaveCount(50)
  await expect(more).toBeFocused()

  // branches deleted meanwhile: the refreshed list has no next page, so the focus goes back to the field
  await page.keyboard.press("Shift+Tab")
  await source.press("Escape")
  const packed = path.join(backend.dataDir, ".git", "packed-refs")
  const kept = readFileSync(packed, "latin1").split("\n").filter((line) => !/refs\/heads\/topic\/10[4-9]\d$/.test(line))
  writeFileSync(packed, kept.join("\n"), "latin1")
  await reopenAndTab()
  await expect(list.getByRole("option")).toHaveCount(40)
  await expect(source).toBeFocused()
})

test("the branches of a search no longer typed are shown but can't be chosen", async ({ page, launch }) => {
  const backend = await launch.local({ refs: manyBranches })
  const hub = await launch.hub(backend.port)
  await page.clock.install()
  await page.goto(`${hub.url}/repo/patches/new`)
  const form = page.getByRole("form", { name: "New patch" })
  const source = branchPicker(form, "Source branch")
  const list = form.getByRole("listbox", { name: "Source branch" })
  const old = list.getByRole("option", { name: topic(1000), exact: true })
  await source.fill("topic/1")
  await expect(old).toBeAttached()

  // typed on before the new search runs: the old rows stay, inert
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000))
  await source.fill("mai")
  await expect(old).toHaveAttribute("aria-disabled", "true")
  await source.press("ArrowDown")
  await expect(source).not.toHaveAttribute("aria-activedescendant")
  await source.press("Enter")
  await old.click({ force: true })
  await expect(source).toHaveValue("mai")

  await page.clock.resume()
  await list.getByRole("option", { name: "main", exact: true }).click()
  await expect(source).toHaveValue("main")
})
