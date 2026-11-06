import type { APIRequestContext, Page } from "@playwright/test"
import { alice, registerUser, writeHeaders, type Account } from "./support/accounts"
import { expect, test } from "./support/fixtures"
import { commentOnDiscussion, createDiscussion, editDiscussion, setDiscussRole, tuiDiscussionPage, tuiDiscussions } from "./support/discussions"
import { createRepo, signedIn } from "./support/repos"

// Browsing, opening, editing and removing discussions, and commenting on
// them, in the browser through Vite's proxy against a real Haxy. Every change
// is checked again after a refresh and in Haxy's own server-rendered
// discussion pages (the TUI's).

const bob: Account = { name: "bobby", email: "bobby@example.test", password: "bobby's password" }
const header = (page: Page) => page.getByRole("banner")

async function logIn(page: Page, hubUrl: string, account: Account, next: string) {
  await page.goto(`${hubUrl}/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel("Username").fill(account.name)
  await page.getByLabel("Password").fill(account.password)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(header(page)).toContainText(`Signed in as ${account.name}`)
}

/** Counts the writes (anything but GET and HEAD) the page sends to routes matching `pattern`. */
function countWrites(page: Page, pattern: RegExp) {
  const writes: string[] = []
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.method() !== "HEAD" && pattern.test(new URL(request.url()).pathname)) writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
  })
  return writes
}

/** Opens `count` discussions through the API, oldest first, every third labelled "ideas"; returns their ids. */
async function openMany(request: APIRequestContext, hubUrl: string, count: number): Promise<string[]> {
  const headers = { ...(await writeHeaders(request, hubUrl)), "Content-Type": "application/json" }
  const ids: string[] = []
  for (let index = 1; index <= count; index++) {
    const response = await request.post(`${hubUrl}/api/v1/repos/alice/forum/discussions`, { headers, data: JSON.stringify({ title: `Topic ${index}`, labels: index % 3 === 0 ? "ideas" : "", description: `About topic ${index}.` }) })
    expect(response.status(), await response.text()).toBe(201)
    ids.push((await response.json()).id)
  }
  return ids
}

const actions = (page: Page) => page.getByRole("group", { name: "Discussion actions" })

test("a reader browses, searches and pages through recent discussions; the URL keeps each view across a refresh", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await createRepo(owner, backend, { name: "forum", access: "public" })
  const ids = await openMany(owner, hub.url, 22)

  await page.goto(`${hub.url}/repos/alice/forum`)
  await page.getByRole("navigation", { name: "Repository sections" }).getByRole("link", { name: "Discussions" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/forum/discussions`)
  const tabs = page.getByRole("navigation", { name: "Discussion lists" })
  await expect(tabs.getByRole("link", { name: "Recent 22" })).toHaveAttribute("aria-current", "page")
  const recent = page.getByRole("list", { name: "Recent discussions" })
  await expect(recent.getByRole("listitem")).toHaveCount(20)
  // most recently active first, as the TUI lists them
  const tui = await tuiDiscussions(backend, "/alice:forum")
  await expect(recent.getByRole("listitem").first().getByRole("link").first()).toHaveText("Topic 22")
  expect(tui.ids[0]).toBe(ids[21])
  // anonymous readers aren't offered to open one
  await expect(page.getByRole("link", { name: "New discussion" })).toHaveCount(0)

  await page.getByRole("navigation", { name: "Discussions pages" }).getByRole("link", { name: "Next page" }).click()
  await expect(page).toHaveURL(new RegExp(`/repos/alice/forum/discussions\\?cursor=${tui.next}$`))
  await expect(recent.getByRole("listitem")).toHaveCount(2)
  await page.reload()
  await expect(page.getByRole("list", { name: "Recent discussions" }).getByRole("listitem")).toHaveText([/^Topic 2(?!\d)/, /^Topic 1(?!\d)/])

  // Haxy's own search, kept in the URL; discussions have no assignees to search by
  await expect(page.getByRole("searchbox", { name: "Search discussions" })).toHaveAttribute("placeholder", "Words, label:name")
  await page.getByRole("searchbox", { name: "Search discussions" }).fill("label:ideas")
  await page.getByRole("button", { name: "Search" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/forum/discussions?search=label%3Aideas`)
  await expect(page.getByRole("status", { name: "Active filters" })).toHaveText("Showing recent discussions labelled ideas.")
  await expect(recent.getByRole("listitem")).toHaveCount(7)
  await page.reload()
  await expect(page.getByRole("list", { name: "Recent discussions" }).getByRole("listitem")).toHaveCount(7)
  await expect(tabs.getByRole("link", { name: "Recent 7" })).toBeVisible()

  // the labels listing links into the filtered list
  await tabs.getByRole("link", { name: "Labels" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/forum/discussions/labels?search=label%3Aideas`)
  await page.getByRole("list", { name: "Labels" }).getByRole("link", { name: "ideas" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/forum/discussions?search=label%3Aideas`)

  // a discussion's own page: no status, no assignees
  await recent.getByRole("link", { name: "Topic 21" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/forum/discussions/${ids[20]}`)
  await expect(page.getByRole("heading", { level: 2, name: "Topic 21" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Description" })).toHaveText(/About topic 21\./)
  await expect(page.getByText("Recent", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Assignees" })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("heading", { level: 2, name: "Topic 21" })).toBeVisible()
  await page.getByRole("link", { name: "Recent discussions" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/forum/discussions`)
  await owner.dispose()
})

test("a contributor opens, edits and removes a discussion; each change shows after a refresh and in Haxy's own pages", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await createRepo(owner, backend, { name: "forum", access: "public" })

  // anybody who can read the repository may open one
  await logIn(page, hub.url, bob, "/repos/alice/forum/discussions")
  await expect(page.getByText("No recent discussions")).toBeVisible()
  await page.getByRole("link", { name: "New discussion" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/forum/discussions/new`)
  const form = page.getByRole("form", { name: "New discussion" })
  await form.getByLabel("Title").fill("Plugin ideas")
  await form.getByLabel("Labels").fill("ideas plugins")
  await form.getByLabel("Description").fill("Share **yours**.")
  const writes = countWrites(page, /\/api\/v1\/repos\/alice\/forum\/discussions$/)
  await form.getByRole("button", { name: "Open discussion" }).dblclick()
  await expect(page).toHaveURL(/\/repos\/alice\/forum\/discussions\/[0-9a-f]{32}$/)
  const id = page.url().split("/").pop()!
  expect(writes).toEqual(["POST /api/v1/repos/alice/forum/discussions"])
  await expect(page.getByRole("heading", { level: 2, name: "Plugin ideas" })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("region", { name: "Labels" }).getByRole("link")).toHaveText(["ideas", "plugins"])
  await expect(page.getByRole("region", { name: "Description" }).locator("strong")).toHaveText("yours")
  expect((await tuiDiscussions(backend, "/alice:forum")).ids).toEqual([id])

  // edit it
  await actions(page).getByRole("link", { name: "Edit" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/forum/discussions/${id}/edit`)
  const edit = page.getByRole("form", { name: "Edit discussion" })
  await expect(edit.getByLabel("Title")).toHaveValue("Plugin ideas")
  await edit.getByLabel("Title").fill("Plugin ideas for 2027")
  await edit.getByLabel("Labels").fill("ideas")
  await edit.getByRole("button", { name: "Save changes" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/forum/discussions/${id}`)
  await expect(page.getByRole("heading", { level: 2, name: "Plugin ideas for 2027" })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("heading", { level: 2, name: "Plugin ideas for 2027" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Labels" }).getByRole("link")).toHaveText(["ideas"])
  expect(await tuiDiscussionPage(backend, "/alice:forum", id)).toContain("Plugin ideas for 2027")

  // no status to change
  await expect(actions(page).getByRole("button")).toHaveText(["Remove"])

  // removal asks first; cancelling keeps it
  await actions(page).getByRole("button", { name: "Remove" }).click()
  const confirm = page.getByRole("alertdialog", { name: "Remove this discussion?" })
  await confirm.getByRole("button", { name: "Cancel" }).click()
  await expect(confirm).toHaveCount(0)
  await actions(page).getByRole("button", { name: "Remove" }).click()
  await confirm.getByRole("button", { name: "Remove discussion" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/forum/discussions`)
  await expect(page.getByText("No recent discussions")).toBeVisible()
  await page.goto(`${hub.url}/repos/alice/forum/discussions/${id}`)
  await expect(page.getByRole("heading", { level: 2, name: "Discussion not found" })).toBeVisible()
  expect((await tuiDiscussions(backend, "/alice:forum")).ids).toEqual([])
  await owner.dispose()
})

test("an edit based on a version someone else changed is refused until the current version has been seen", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  const other = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await logIn(page, hub.url, alice, "/")
  await createRepo(other, backend, { name: "forum", access: "public" })
  const id = await createDiscussion(other, backend, "/alice:forum", { title: "Roadmap" })

  await page.goto(`${hub.url}/repos/alice/forum/discussions/${id}/edit`)
  const form = page.getByRole("form", { name: "Edit discussion" })
  await expect(form.getByLabel("Title")).toHaveValue("Roadmap")
  await form.getByLabel("Title").fill("Roadmap (mine)")
  // another client (Haxy's own edit form, as the TUI's) changes it meanwhile
  await editDiscussion(other, backend, "/alice:forum", id, { title: "Roadmap (theirs)", description: "Their words." })
  await form.getByRole("button", { name: "Save changes" }).click()
  await expect(form.getByRole("alert")).toContainText("Someone changed this discussion since you opened the form")
  await expect(form.getByRole("button", { name: "Save changes" })).toBeDisabled()
  expect(await tuiDiscussionPage(backend, "/alice:forum", id)).toContain("Roadmap (theirs)")

  await form.getByRole("button", { name: "Show the current version" }).click()
  await expect(form.getByRole("region", { name: "Current version" })).toContainText("Their words.")
  await expect(form.getByLabel("Title")).toHaveValue("Roadmap (mine)")
  await form.getByRole("button", { name: "Save changes" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/forum/discussions/${id}`)
  await page.reload()
  await expect(page.getByRole("heading", { level: 2, name: "Roadmap (mine)" })).toBeVisible()
  expect(await tuiDiscussionPage(backend, "/alice:forum", id)).toContain("Roadmap (mine)")
  await other.dispose()
})

test("discussions turned off show as unavailable, and a members-only threshold offers readers no way to open one", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  const repo = { owner: "alice", name: "forum", access: "public" as const }
  await createRepo(owner, backend, repo)
  const id = await createDiscussion(owner, backend, "/alice:forum", { title: "Welcome" })
  await setDiscussRole(owner, backend, repo, "members")

  await logIn(page, hub.url, bob, `/repos/alice/forum/discussions/${id}`)
  await expect(page.getByRole("heading", { level: 2, name: "Welcome" })).toBeVisible()
  await expect(actions(page)).toHaveCount(0)
  await expect(page.getByRole("form", { name: "New comment" })).toHaveCount(0)
  await page.goto(`${hub.url}/repos/alice/forum/discussions`)
  await expect(page.getByRole("list", { name: "Recent discussions" }).getByRole("listitem")).toHaveCount(1)
  await expect(page.getByRole("link", { name: "New discussion" })).toHaveCount(0)
  await page.goto(`${hub.url}/repos/alice/forum/discussions/new`)
  await expect(page.getByText("Your role in this repository doesn't allow opening discussions.")).toBeVisible()

  await setDiscussRole(owner, backend, repo, "nobody")
  await page.goto(`${hub.url}/repos/alice/forum/discussions`)
  await expect(page.getByRole("status")).toHaveText("Discussions are turned off for this repository.")
  await expect(page.getByRole("navigation", { name: "Repository sections" }).getByRole("link", { name: "Discussions" })).toHaveCount(0)
  await page.goto(`${hub.url}/repos/alice/forum/discussions/${id}`)
  await expect(page.getByRole("status")).toHaveText("Discussions are turned off for this repository.")
  await owner.dispose()
})

test("a reader comments on a discussion and replies; both persist after a refresh, with permalinks, and Haxy's own pages show them", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await createRepo(owner, backend, { name: "forum", access: "public" })
  const id = await createDiscussion(owner, backend, "/alice:forum", { title: "Roadmap" })
  const first = await commentOnDiscussion(owner, backend, "/alice:forum", id, "What should come first?")
  const path = `/repos/alice/forum/discussions/${id}`

  await logIn(page, hub.url, bob, path)
  const card = (text: string) => page.getByRole("article", { name: /^Comment by / }).filter({ hasText: text })
  await expect(card("What should come first?")).toBeVisible()
  const composer = page.getByRole("form", { name: "New comment" })
  await composer.getByLabel("New comment").fill("Plugins, **please**.")
  const writes = countWrites(page, /\/comments$/)
  await composer.getByRole("button", { name: "Comment" }).dblclick()
  await expect(page).toHaveURL(new RegExp(`${path}#comment-[0-9a-f]{32}$`))
  expect(writes).toEqual([`POST /api/v1/repos/alice/forum/discussions/${id}/comments`])
  await expect(card("Plugins, please.")).toBeFocused()

  await card("What should come first?").getByRole("button", { name: "Reply" }).click()
  const reply = page.getByRole("form", { name: "Reply" })
  await reply.getByLabel("Reply").fill("Agreed.")
  await reply.getByRole("button", { name: "Post reply" }).click()
  await expect(card("Agreed.")).toBeFocused()
  const comments = page.getByRole("list", { name: "Comments" })
  await expect(comments.getByRole("listitem").filter({ has: card("What should come first?") }).getByRole("region", { name: "1 reply" }).getByRole("article")).toHaveText([/Agreed\./])

  await page.reload()
  await expect(comments.getByRole("article")).toHaveCount(3)
  const tui = await tuiDiscussionPage(backend, "/alice:forum", id)
  expect(tui).toContain("Plugins,")
  expect(tui).toContain("Agreed.")

  // the comment's permalink opens its own page, where its reply says whom it answers
  await card("What should come first?").getByRole("link", { name: "Permalink" }).click()
  await expect(page).toHaveURL(`${hub.url}${path}/comments/${first}`)
  await expect(page.getByRole("heading", { level: 2, name: "Comment on Roadmap" })).toBeVisible()
  await expect(page.getByRole("list", { name: "Replies" }).getByRole("article")).toHaveText([/Agreed\./])
  await expect(page.getByRole("list", { name: "Replies" }).getByRole("link", { name: "replying to alice" })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("heading", { level: 2, name: "Comment on Roadmap" })).toBeVisible()
  await owner.dispose()
})

test("local mode opens, comments on and removes discussions without logging in; Haxy's discussion links open Hub pages", async ({ page, request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)

  await page.goto(`${hub.url}/repo/discussions`)
  await page.getByRole("link", { name: "New discussion" }).click()
  const form = page.getByRole("form", { name: "New discussion" })
  await form.getByLabel("Title").fill("Offline notes")
  await form.getByLabel("Description").fill("See [the list](/discussions/labels) and [an edit](/discuss:0123456789abcdef0123456789abcdef/edit).")
  await form.getByRole("button", { name: "Open discussion" }).click()
  await expect(page).toHaveURL(/\/repo\/discussions\/[0-9a-f]{32}$/)
  const id = page.url().split("/").pop()!
  expect((await tuiDiscussions(backend, "")).ids).toEqual([id])
  await expect(page.getByRole("link", { name: "the list" })).toHaveAttribute("href", "/repo/discussions/labels")
  await expect(page.getByRole("link", { name: "an edit" })).toHaveAttribute("href", "/repo/discussions/0123456789abcdef0123456789abcdef/edit")

  await page.getByRole("form", { name: "New comment" }).getByLabel("New comment").fill("Noted.")
  await page.getByRole("form", { name: "New comment" }).getByRole("button", { name: "Comment" }).click()
  await expect(page.getByRole("article", { name: /^Comment by / }).filter({ hasText: "Noted." })).toBeVisible()

  await actions(page).getByRole("button", { name: "Remove" }).click()
  await page.getByRole("alertdialog", { name: "Remove this discussion?" }).getByRole("button", { name: "Remove discussion" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/discussions`)
  expect((await tuiDiscussions(backend, "")).ids).toEqual([])
  void request
})
