import type { APIRequestContext, Page, PlaywrightWorkerArgs } from "@playwright/test"
import { alice, registerUser, type Account } from "./support/accounts"
import type { Backend } from "./support/backend"
import { commentOnDiscussion, createDiscussion, tuiDiscussionPage } from "./support/discussions"
import { expect, test } from "./support/fixtures"
import { commentOnPatch, pushedPatch, tuiPatchPage } from "./support/patches"
import { createRepo, signedIn } from "./support/repos"

// A discussion's page and a patch's page show the attachments and the
// notification panel an issue's page does, through the shared thread pieces
// (attachments.spec.ts and notifications.spec.ts cover their behaviour on
// issues). Every change is checked again after a refresh, and in Haxy's own
// page; opening the thread, or one of its comments' own pages, acknowledges it.

const bob: Account = { name: "bobby", email: "bobby@example.test", password: "bobby's password" }
const header = (page: Page) => page.getByRole("banner")
const bell = (page: Page) => header(page).getByRole("link", { name: /^Notifications/ })
const settings = (page: Page) => page.getByRole("region", { name: "Notifications" })
const attachments = (page: Page) => page.getByRole("region", { name: "Attachments" })
const listed = (page: Page) => attachments(page).getByRole("list", { name: "Attached files" }).getByRole("link")
const form = (page: Page) => page.getByRole("form", { name: "Attach a file" })

/** One of alice's threads, which bob may comment on. */
type Seeded = { route: string; comment(by: APIRequestContext, body: string): Promise<string>; tuiPage(): Promise<string> }

type Kind = { plural: string; noun: string; ssh: boolean; seed(playwright: PlaywrightWorkerArgs["playwright"], backend: Backend, hubUrl: string, owner: APIRequestContext): Promise<Seeded> }

const kinds: Kind[] = [
  {
    plural: "discussions",
    noun: "discussion",
    ssh: false,
    async seed(_playwright, backend, _hubUrl, owner) {
      await createRepo(owner, backend, { name: "forum", access: "public" })
      const id = await createDiscussion(owner, backend, "/alice:forum", { title: "Roadmap for 2027" })
      return {
        route: `/repos/alice/forum/discussions/${id}`,
        comment: (by, body) => commentOnDiscussion(by, backend, "/alice:forum", id, body),
        tuiPage: () => tuiDiscussionPage(backend, "/alice:forum", id),
      }
    },
  },
  {
    plural: "patches",
    noun: "patch",
    ssh: true,
    async seed(playwright, backend, hubUrl, owner) {
      await createRepo(owner, backend, { name: "parser", access: "public" })
      const id = await pushedPatch(playwright, backend, hubUrl, alice, owner, "parser", "Roadmap for 2027")
      return {
        route: `/repos/alice/parser/patches/${id}`,
        comment: (by, body) => commentOnPatch(by, backend, "/alice:parser", id, body),
        tuiPage: () => tuiPatchPage(backend, "/alice:parser", id),
      }
    },
  },
]

async function logIn(page: Page, hubUrl: string, account: Account, next: string) {
  await page.goto(`${hubUrl}/login?next=${encodeURIComponent(next)}`)
  await page.getByLabel("Username").fill(account.name)
  await page.getByLabel("Password").fill(account.password)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(header(page)).toContainText(`Signed in as ${account.name}`)
}

for (const kind of kinds) {
  test(`a ${kind.noun}'s page acknowledges it, takes attachments, and mutes and subscribes, each lasting a refresh`, async ({ page, playwright, launch }) => {
    const backend = await launch.server({ ssh: kind.ssh })
    const hub = await launch.hub(backend.port)
    await registerUser(backend, alice)
    await registerUser(backend, bob)
    const owner = await signedIn(playwright, backend, hub.url, alice.name, alice.password)
    const other = await signedIn(playwright, backend, hub.url, bob.name, bob.password)
    const seeded = await kind.seed(playwright, backend, hub.url, owner)
    await seeded.comment(other, "Count me in.")

    // bob's comment is unread until alice's page has shown the thread
    await logIn(page, hub.url, alice, "/")
    await expect(bell(page)).toHaveAccessibleName("Notifications, 1 unread")
    await page.goto(`${hub.url}${seeded.route}`)
    await expect(page.getByRole("heading", { name: "Roadmap for 2027" })).toBeVisible()
    await expect(settings(page)).toContainText(`You're notified of activity on this ${kind.noun}.`)
    await expect(bell(page)).toHaveAccessibleName("Notifications, 0 unread")

    // a file attached here is listed, after a refresh and on Haxy's own page; removing it lasts too
    await expect(attachments(page).getByText(`Nothing is attached to this ${kind.noun}.`)).toBeVisible()
    await form(page).getByLabel("Attach a file").setInputFiles({ name: "the plan.txt", mimeType: "text/plain", buffer: Buffer.from("the plan\n") })
    await form(page).getByRole("button", { name: "Attach file" }).click()
    await expect(listed(page)).toHaveText(["the plan.txt"])
    await page.reload()
    await expect(listed(page)).toHaveText(["the plan.txt"])
    expect(await seeded.tuiPage()).toContain("the plan.txt")
    await attachments(page).getByRole("button", { name: "Remove the plan.txt" }).click()
    await attachments(page).getByRole("alertdialog").getByRole("button", { name: "Remove attachment" }).click()
    await expect(attachments(page).getByText(`Nothing is attached to this ${kind.noun}.`)).toBeVisible()
    await page.reload()
    await expect(attachments(page).getByText(`Nothing is attached to this ${kind.noun}.`)).toBeVisible()
    expect(await seeded.tuiPage()).not.toContain("the plan.txt")

    // a comment's own page acknowledges its thread too
    const comment = await seeded.comment(other, "Still in.")
    await page.goto(`${hub.url}/`)
    await expect(bell(page)).toHaveAccessibleName("Notifications, 1 unread")
    await page.goto(`${hub.url}${seeded.route}/comments/${comment}`)
    await expect(page.getByText("Still in.")).toBeVisible()
    await expect(bell(page)).toHaveAccessibleName("Notifications, 0 unread")

    // muted, then subscribed again
    await page.goto(`${hub.url}${seeded.route}`)
    await settings(page).getByRole("button", { name: "Mute" }).click()
    await expect(settings(page)).toContainText("Muted. You won't be notified of this thread.")
    await page.reload()
    await expect(settings(page)).toContainText(`You're not notified of activity on this ${kind.noun}.`)
    await seeded.comment(other, "Anyone?")
    await page.goto(`${hub.url}/`)
    await expect(bell(page)).toHaveAccessibleName("Notifications, 0 unread")
    await page.goto(`${hub.url}${seeded.route}`)
    await settings(page).getByRole("button", { name: "Subscribe" }).click()
    await expect(settings(page)).toContainText("You're subscribed.")
    await page.reload()
    await expect(settings(page)).toContainText(`You're notified of activity on this ${kind.noun}.`)
    await owner.dispose()
    await other.dispose()
  })
}
