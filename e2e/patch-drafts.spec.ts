import type { Page, Route } from "@playwright/test"
import { alice, type Account } from "./support/accounts"
import { bob, draftsRepo, editForkDraft, publishForkDraft, startForkDraft, tuiPage } from "./support/drafts"
import { expect, test } from "./support/fixtures"
import { setPatchRole, tuiPatches } from "./support/patches"

// Starting a patch with a new fork, listing, editing, publishing and removing
// drafts in the browser, through Vite's proxy against a real Haxy server.
// Every change is checked again after a refresh, in Haxy's own server-rendered
// pages (the TUI's).

const header = (page: Page) => page.getByRole("banner")
const actions = (page: Page) => page.getByRole("group", { name: "Draft actions" })
const proposal = (page: Page) => page.getByRole("region", { name: "Proposal" })
const drafts = "/repos/alice/parser/patches/drafts"

async function logIn(page: Page, hubUrl: string, account: Account, next: string) {
  await page.goto(`${hubUrl}/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel("Username").fill(account.name)
  await page.getByLabel("Password").fill(account.password)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(header(page)).toContainText(`Signed in as ${account.name}`)
}

/** Handles the first `method` request to `pattern` with `handler`; every other request goes on as usual. */
async function onFirst(page: Page, pattern: RegExp, method: string, handler: (route: Route) => Promise<void>) {
  let pending = true
  await page.route(pattern, async (route) => {
    if (route.request().method() !== method || !pending) return route.fallback()
    pending = false
    await handler(route)
  })
}

/**
 * From the new patch page: takes the way to a new fork beside its branch
 * pickers, starts a draft into `main` titled `title`, and returns its id.
 */
async function startFromNewPatchPage(page: Page, title: string): Promise<string> {
  await expect(page.getByRole("form", { name: "New patch" }).getByLabel("Source branch")).toBeVisible()
  await page.getByRole("link", { name: "Start with a new fork" }).click()
  const form = page.getByRole("form", { name: "New draft" })
  await form.getByLabel("Title").fill(title)
  await form.getByLabel("Labels").fill("perf")
  await expect(form.getByLabel("Target branch")).toHaveValue("branch:main")
  await form.getByRole("button", { name: "Start with a new fork" }).click()
  await expect(page).toHaveURL(new RegExp(`${drafts}/[0-9a-f]{32}$`))
  return page.url().split("/").pop() ?? ""
}

/** The fork's push, clone and merge commands, each in its own region, naming the fork of patch `id`. */
async function expectForkCommands(page: Page, id: string, noun: "draft" | "patch") {
  await expect(page.getByRole("region", { name: `Push to this ${noun} from an existing repository` })).toContainText(new RegExp(`git push ssh://\\S+/alice:parser\\+${id} HEAD:patch`))
  await expect(page.getByRole("region", { name: `Clone this ${noun}` })).toContainText(`git clone ssh://`)
  await expect(page.getByRole("region", { name: `Merge this ${noun} locally` })).toContainText(`alice:parser+${id}' refs/heads/patch && git merge FETCH_HEAD`)
}

test.describe("on a server", () => {
  test("a contributor starts a patch with a new fork from the new patch page, edits the draft and publishes it", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner } = await draftsRepo(playwright, backend, hub.url)
    await logIn(page, hub.url, alice, "/repos/alice/parser/patches/new")

    const id = await startFromNewPatchPage(page, "Speed up parsing")

    // the draft, with its fork's commands, after a refresh too
    await page.reload()
    await expect(page.getByRole("heading", { level: 2, name: "Speed up parsing" })).toBeVisible()
    await expect(page.getByLabel("Status")).toHaveText("Draft")
    await expect(proposal(page)).toContainText("Your fork alice/parser")
    await expect(proposal(page)).toContainText("Nothing has been pushed yet.")
    await expectForkCommands(page, id, "draft")
    expect(await tuiPage(owner, backend, "/alice:parser/patches/drafts")).toContain("Speed up parsing")

    // edit it: a new title and target
    await actions(page).getByRole("link", { name: "Edit" }).click()
    const edit = page.getByRole("form", { name: "Edit draft" })
    await edit.getByLabel("Title").fill("Parse twice as fast")
    await edit.getByLabel("Target branch").selectOption({ label: "feature" })
    await edit.getByRole("button", { name: "Save changes" }).click()
    await expect(page).toHaveURL(`${hub.url}${drafts}/${id}`)
    await page.reload()
    await expect(page.getByRole("heading", { level: 2, name: "Parse twice as fast" })).toBeVisible()
    await expect(proposal(page)).toContainText("Branch feature")
    expect(await tuiPage(owner, backend, "/alice:parser/patches/drafts")).toContain("Parse twice as fast")

    // publishing makes it the repository's patch
    await actions(page).getByRole("button", { name: "Publish" }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/alice/parser/patches/${id}`)
    await expect(page.getByRole("heading", { level: 2, name: "Parse twice as fast" })).toBeVisible()
    await expect(page.getByRole("region", { name: "Proposal" })).toContainText("The fork alice/parser")
    // the patch keeps its fork's commands, to push more to it
    await expectForkCommands(page, id, "patch")
    expect((await tuiPatches(backend, "/alice:parser", "open")).ids).toEqual([id])
    await page.goto(`${hub.url}${drafts}`)
    await expect(page.getByText("No drafts")).toBeVisible()
    await owner.dispose()
  })

  test("drafts are listed for their author alone, whom removing one asks first", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, other } = await draftsRepo(playwright, backend, hub.url)
    const id = await startForkDraft(owner, backend, "/alice:parser", { title: "Alice's idea", target: "main", description: "See [my drafts](/alice:parser/patches/drafts)." })

    // the patches list leads to them
    await logIn(page, hub.url, alice, "/repos/alice/parser/patches")
    await page.getByRole("link", { name: "Your drafts" }).click()
    await expect(page).toHaveURL(`${hub.url}${drafts}`)
    const list = page.getByRole("list", { name: "Your drafts" })
    await expect(list).toContainText("Alice's idea")
    await expect(list).toContainText("Nothing pushed yet")

    // Haxy's own drafts URL in a description leads back to them
    await list.getByRole("link", { name: "Alice's idea" }).click()
    await page.getByRole("link", { name: "my drafts" }).click()
    await expect(page).toHaveURL(`${hub.url}${drafts}`)

    // removing asks first, then takes it off the list, here and in Haxy's own drafts tab
    await list.getByRole("link", { name: "Alice's idea" }).click()
    await actions(page).getByRole("button", { name: "Remove" }).click()
    const confirm = page.getByRole("alertdialog", { name: "Remove this draft?" })
    await confirm.getByRole("button", { name: "Cancel" }).click()
    await expect(page.getByRole("heading", { level: 2, name: "Alice's idea" })).toBeVisible()
    await actions(page).getByRole("button", { name: "Remove" }).click()
    await confirm.getByRole("button", { name: "Remove draft" }).click()
    await expect(page).toHaveURL(`${hub.url}${drafts}`)
    await expect(page.getByText("No drafts")).toBeVisible()
    await page.reload()
    await expect(page.getByText("No drafts")).toBeVisible()
    expect(await tuiPage(owner, backend, "/alice:parser/patches/drafts")).not.toContain("Alice's idea")

    // someone else's draft isn't there for anyone else, by its own URL either
    const his = await startForkDraft(other, backend, "/alice:parser", { title: "Bob's idea", target: "main" })
    await page.goto(`${hub.url}${drafts}/${his}`)
    await expect(page.getByRole("heading", { level: 2, name: "Draft not found" })).toBeVisible()
    await page.goto(`${hub.url}/repos/alice/parser/patches/${his}`)
    await expect(page.getByRole("heading", { level: 2, name: "Patch not found" })).toBeVisible()
    await page.goto(`${hub.url}${drafts}`)
    await expect(page.getByText("No drafts")).toBeVisible()
    await expect(page.getByText("Bob's idea")).toHaveCount(0)
    expect(id).not.toBe(his)
    await owner.dispose()
    await other.dispose()
  })

  test("publishing once the author's role no longer allows it says Haxy's reason", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner, other, repo } = await draftsRepo(playwright, backend, hub.url)
    const id = await startForkDraft(other, backend, "/alice:parser", { title: "Bob's idea", target: "main" })
    await logIn(page, hub.url, bob, `${drafts}/${id}`)
    await expect(page.getByRole("heading", { level: 2, name: "Bob's idea" })).toBeVisible()

    // the owner restricts patches to members after the page loaded
    await setPatchRole(owner, backend, repo, "members")
    await actions(page).getByRole("button", { name: "Publish" }).click()
    await expect(page.getByRole("alert")).toContainText("Your role in this repository doesn't allow writing patches.")
    await expect(page).toHaveURL(`${hub.url}${drafts}/${id}`)
    expect((await tuiPatches(backend, "/alice:parser", "open")).ids).toEqual([])

    // read again, the page no longer offers it, and says why
    await page.reload()
    await expect(actions(page).getByRole("button", { name: "Publish" })).toHaveCount(0)
    await expect(page.getByRole("status", { name: "Publishing unavailable" })).toHaveText("Your role in this repository doesn't allow writing patches.")
    await owner.dispose()
    await other.dispose()
  })

  test("a start or a publication whose answer is lost is settled by reading again", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner } = await draftsRepo(playwright, backend, hub.url)
    await logIn(page, hub.url, alice, `${drafts}/new`)

    // Haxy starts the draft, but its answer never arrives
    await onFirst(page, /\/api\/v1\/repos\/alice\/parser\/patches\/drafts$/, "POST", async (route) => {
      await route.fetch()
      await route.abort("connectionreset")
    })
    const form = page.getByRole("form", { name: "New draft" })
    await form.getByLabel("Title").fill("Lost answer")
    await form.getByRole("button", { name: "Start with a new fork" }).click()
    await expect(form.getByText("The draft was started.")).toBeVisible()
    await expect(form.getByRole("button", { name: "Start with a new fork" })).toBeDisabled()
    await form.getByRole("link", { name: "Open the draft" }).click()
    await expect(page.getByRole("heading", { level: 2, name: "Lost answer" })).toBeVisible()
    const id = page.url().split("/").pop() ?? ""

    // the publication lands, but its answer is lost: the page finds the patch
    await onFirst(page, /\/publish$/, "POST", async (route) => {
      await route.fetch()
      await route.abort("connectionreset")
    })
    await actions(page).getByRole("button", { name: "Publish" }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/alice/parser/patches/${id}`)
    await expect(page.getByRole("heading", { level: 2, name: "Lost answer" })).toBeVisible()
    expect((await tuiPatches(backend, "/alice:parser", "open")).ids).toEqual([id])

    // a draft that wasn't published says so, and may be published again
    const second = await startForkDraft(owner, backend, "/alice:parser", { title: "Not yet", target: "main" })
    await page.goto(`${hub.url}${drafts}/${second}`)
    await expect(page.getByRole("heading", { level: 2, name: "Not yet" })).toBeVisible()
    await onFirst(page, /\/publish$/, "POST", (route) => route.abort("connectionreset"))
    await actions(page).getByRole("button", { name: "Publish" }).click()
    await expect(page.getByRole("alert")).toContainText("The draft wasn't published; publish it again")
    await actions(page).getByRole("button", { name: "Publish" }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/alice/parser/patches/${second}`)
    await owner.dispose()
  })
})

test.describe("on a server, settling", () => {
  test("a lost answer that can't be settled either holds every write until a check says what happened", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner } = await draftsRepo(playwright, backend, hub.url)
    const id = await startForkDraft(owner, backend, "/alice:parser", { title: "Unsettled", target: "main" })
    await logIn(page, hub.url, alice, `${drafts}/${id}`)
    await expect(page.getByRole("heading", { level: 2, name: "Unsettled" })).toBeVisible()

    // the publication's answer is lost, and so are the reads that would settle it
    let readsFail = true
    await page.route(new RegExp(`/api/v1/repos/alice/parser/patches/(?:drafts/)?${id}$`), (route) => (readsFail && route.request().method() === "GET" ? route.abort("connectionreset") : route.fallback()))
    await onFirst(page, /\/publish$/, "POST", (route) => route.abort("connectionreset"))
    await actions(page).getByRole("button", { name: "Publish" }).click()
    await expect(page.getByRole("alert")).toContainText("couldn't say what happened")
    await expect(actions(page).getByRole("button", { name: "Publish" })).toBeDisabled()
    await expect(actions(page).getByRole("button", { name: "Remove" })).toBeDisabled()
    await expect(actions(page).getByRole("link", { name: "Edit" })).toHaveCount(0)
    await expect(actions(page).getByRole("button", { name: "Edit" })).toBeDisabled()

    // a check that reads the draft says it wasn't published, and frees the writes
    readsFail = false
    await page.getByRole("button", { name: "Check again" }).click()
    await expect(page.getByRole("alert")).toContainText("The draft wasn't published; publish it again")
    await actions(page).getByRole("button", { name: "Publish" }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/alice/parser/patches/${id}`)
    await owner.dispose()
  })

  test("a publication landing between the reads that settle a lost answer is still found", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner } = await draftsRepo(playwright, backend, hub.url)
    const id = await startForkDraft(owner, backend, "/alice:parser", { title: "Raced", target: "main" })
    await logIn(page, hub.url, alice, `${drafts}/${id}`)
    await expect(page.getByRole("heading", { level: 2, name: "Raced" })).toBeVisible()

    // the answer is lost; the first look for the patch finds none, and the draft is published right after it
    await onFirst(page, /\/publish$/, "POST", (route) => route.abort("connectionreset"))
    await onFirst(page, new RegExp(`/api/v1/repos/alice/parser/patches/${id}$`), "GET", async (route) => {
      const response = await route.fetch()
      await publishForkDraft(owner, backend, "/alice:parser", id)
      await route.fulfill({ response })
    })
    await actions(page).getByRole("button", { name: "Publish" }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/alice/parser/patches/${id}`)
    await expect(page.getByRole("heading", { level: 2, name: "Raced" })).toBeVisible()
    await owner.dispose()
  })

  test("an edit based on a version changed since shows the current one in place and keeps the input", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner } = await draftsRepo(playwright, backend, hub.url)
    const id = await startForkDraft(owner, backend, "/alice:parser", { title: "First title", target: "main" })
    await logIn(page, hub.url, alice, `${drafts}/${id}/edit`)
    const form = page.getByRole("form", { name: "Edit draft" })
    await form.getByLabel("Title").fill("My title")

    // another client edits it meanwhile
    await editForkDraft(owner, backend, "/alice:parser", id, { title: "Their title", target: "feature" })
    await form.getByRole("button", { name: "Save changes" }).click()
    await expect(form.getByRole("alert")).toContainText("This draft changed since you opened the form")
    await expect(form.getByRole("button", { name: "Save changes" })).toBeDisabled()

    await form.getByRole("button", { name: "Show the current version" }).click()
    const current = form.getByRole("region", { name: "Current version" })
    await expect(current).toContainText("Their title")
    await expect(current).toContainText("feature")
    await expect(form.getByLabel("Title")).toHaveValue("My title")
    await form.getByRole("button", { name: "Save changes" }).click()
    await expect(page).toHaveURL(`${hub.url}${drafts}/${id}`)
    await page.reload()
    await expect(page.getByRole("heading", { level: 2, name: "My title" })).toBeVisible()
    expect(await tuiPage(owner, backend, "/alice:parser/patches/drafts")).toContain("My title")
    await owner.dispose()
  })

  test("a start whose answer is lost and that was published meanwhile leads to the patch", async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: true })
    const hub = await launch.hub(backend.port)
    const { owner } = await draftsRepo(playwright, backend, hub.url)
    await logIn(page, hub.url, alice, `${drafts}/new`)

    // the draft is started, then published from another tab, before its answer arrives
    let started = ""
    await onFirst(page, /\/api\/v1\/repos\/alice\/parser\/patches\/drafts$/, "POST", async (route) => {
      started = ((await (await route.fetch()).json()) as { id: string }).id
      await publishForkDraft(owner, backend, "/alice:parser", started)
      await route.abort("connectionreset")
    })
    const form = page.getByRole("form", { name: "New draft" })
    await form.getByLabel("Title").fill("Published meanwhile")
    await form.getByRole("button", { name: "Start with a new fork" }).click()
    await expect(form.getByText("The draft was started and has been published since.")).toBeVisible()
    await expect(form.getByRole("button", { name: "Start with a new fork" })).toBeDisabled()
    await form.getByRole("link", { name: "Open the patch" }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/alice/parser/patches/${started}`)
    await owner.dispose()
  })
})

test("local mode offers no fork on the new patch page and has no drafts", async ({ page, launch }) => {
  const backend = await launch.local({ files: { "README.md": "# local\n" } })
  const hub = await launch.hub(backend.port)
  await page.goto(`${hub.url}/repo/patches/new`)
  await expect(page.getByRole("form", { name: "New patch" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Start with a new fork" })).toHaveCount(0)
  await page.goto(`${hub.url}/repo/patches/drafts`)
  await expect(page.getByText("Local mode has no drafts")).toBeVisible()
})
