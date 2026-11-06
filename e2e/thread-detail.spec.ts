import type { Page } from "@playwright/test"
import { alice, registerUser, type Account } from "./support/accounts"
import { expect, test } from "./support/fixtures"
import { createDiscussion } from "./support/discussions"
import { createIssue } from "./support/issues"
import { postComment } from "./support/comments"
import { createRepo, signedIn } from "./support/repos"

// A thread's own page: its title, status and actions over the description as
// the opening post and the conversation, beside a sidebar of its labels,
// assignees, attachments and notifications. Changing the assignees or the
// attachments is a step of its own, behind each section's edit toggle.

const bob: Account = { name: "bobby", email: "bobby@example.test", password: "bobby's password" }
const header = (page: Page) => page.getByRole("banner")
const details = (page: Page) => page.getByRole("complementary", { name: "Details" })
const section = (page: Page, name: string) => details(page).getByRole("region", { name })

async function logIn(page: Page, hubUrl: string, account: Account, next: string) {
  await page.goto(`${hubUrl}/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel("Username").fill(account.name)
  await page.getByLabel("Password").fill(account.password)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(header(page)).toContainText(`Signed in as ${account.name}`)
}

test("an issue's page shows its status and meta over the opening post and conversation, with its details in a sidebar", async ({ page, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  await logIn(page, hub.url, alice, "/")
  await createRepo(page.context().request, backend, { name: "tracker", access: "public" })
  const id = await createIssue(page.context().request, backend, "/alice:tracker", { title: "Crash on save", labels: "bug", description: "It crashes." })
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${id}`)

  await expect(page.getByRole("heading", { level: 2, name: "Crash on save" })).toBeVisible()
  await expect(page.getByRole("status", { name: "Status" })).toHaveText("Open")
  await expect(page.getByText(/^alice opened .+$/).first()).toBeVisible()
  await expect(page.getByText("0 comments", { exact: true })).toBeVisible()
  const post = page.getByRole("region", { name: "Description" })
  await expect(post).toContainText("alice opened this issue on")
  await expect(post).toContainText("It crashes.")
  await expect(page.getByRole("heading", { name: /^Conversation/ })).toBeVisible()

  await expect(details(page).getByRole("heading")).toHaveText(["Labels", "Assignees", "Attachments", "Notifications"])
  await expect(section(page, "Labels").getByRole("link", { name: "bug" })).toHaveAttribute("href", "/repos/alice/tracker/issues?search=label%3Abug")
  await expect(section(page, "Notifications")).toContainText("You're notified of activity on this issue.")

  // the assignees show as a list; their form is behind the section's toggle
  const editAssignees = section(page, "Assignees").getByRole("button", { name: "Edit assignees" })
  await expect(section(page, "Assignees")).toContainText("Nobody is assigned to this issue.")
  await expect(page.getByRole("form", { name: "Assign someone" })).toHaveCount(0)
  await expect(editAssignees).toHaveAttribute("aria-expanded", "false")
  await editAssignees.click()
  await expect(editAssignees).toHaveAttribute("aria-expanded", "true")
  const assign = page.getByRole("form", { name: "Assign someone" })
  await assign.getByLabel("Assign").fill("bobby")
  await assign.getByRole("button", { name: "Assign" }).click()
  await expect(section(page, "Assignees").getByRole("button", { name: "Unassign bobby" })).toBeVisible()
  await editAssignees.click()
  await expect(assign).toHaveCount(0)
  await expect(section(page, "Assignees").getByRole("button", { name: "Unassign bobby" })).toHaveCount(0)
  await expect(section(page, "Assignees").getByRole("list", { name: "Assigned" }).getByRole("link")).toHaveText(["bobby"])

  // so are the attachments
  const editAttachments = section(page, "Attachments").getByRole("button", { name: "Edit attachments" })
  await expect(page.getByRole("form", { name: "Attach a file" })).toHaveCount(0)
  await editAttachments.click()
  await expect(editAttachments).toHaveAttribute("aria-expanded", "true")
  await expect(page.getByRole("form", { name: "Attach a file" })).toBeVisible()

  await page.getByRole("group", { name: "Issue actions" }).getByRole("button", { name: "Close issue" }).click()
  await expect(page.getByRole("status", { name: "Status" })).toHaveText("Closed")
})

test("a discussion's page has no status, and says when it has no labels", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
  await createRepo(owner, backend, { name: "forum", access: "public" })
  const id = await createDiscussion(owner, backend, "/alice:forum", { title: "Roadmap", description: "What next?" })
  await owner.dispose()

  await page.goto(`${hub.url}/repos/alice/forum/discussions/${id}`)
  await expect(page.getByRole("heading", { level: 2, name: "Roadmap" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Description" })).toContainText("alice opened this discussion on")
  await expect(page.getByRole("status", { name: "Status" })).toHaveCount(0)
  await expect(section(page, "Labels")).toContainText("None yet")
  await expect(section(page, "Assignees")).toHaveCount(0)
})

const LONG_RUN = "x".repeat(400)

const overflows = (element: HTMLElement | SVGElement) => element.scrollWidth > element.clientWidth

test("a long unbroken run of text wraps inside the opening post and a comment card instead of being cut off", async ({ page, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await logIn(page, hub.url, alice, "/")
  await createRepo(page.context().request, backend, { name: "tracker", access: "public" })
  const id = await createIssue(page.context().request, backend, "/alice:tracker", { title: "Long", description: `See ${LONG_RUN}` })
  await postComment(page.context().request, backend, "/alice:tracker", id, `Inline \`${LONG_RUN}\` here`)
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${id}`)

  const post = page.getByRole("region", { name: "Description" })
  const comment = page.getByRole("article", { name: "Comment by alice" })
  await expect(comment).toContainText(LONG_RUN)
  expect(await post.evaluate(overflows)).toBe(false)
  expect(await comment.evaluate(overflows)).toBe(false)
})

test("a file chosen before the attachments are folded away is not uploaded once they are shown again", async ({ page, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await registerUser(backend, alice)
  await logIn(page, hub.url, alice, "/")
  await createRepo(page.context().request, backend, { name: "tracker", access: "public" })
  const id = await createIssue(page.context().request, backend, "/alice:tracker", { title: "Crash on save" })
  await page.goto(`${hub.url}/repos/alice/tracker/issues/${id}`)

  const toggle = section(page, "Attachments").getByRole("button", { name: "Edit attachments" })
  const form = page.getByRole("form", { name: "Attach a file" })
  await toggle.click()
  await form.getByLabel("Attach a file").setInputFiles({ name: "log.txt", mimeType: "text/plain", buffer: Buffer.from("log\n") })
  await expect(form.getByRole("button", { name: "Attach file" })).toBeEnabled()
  await toggle.click()
  await toggle.click()
  await expect(form.getByRole("button", { name: "Attach file" })).toBeDisabled()
})
