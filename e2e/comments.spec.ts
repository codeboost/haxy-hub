import type { Locator, Page, Route } from "@playwright/test"
import { alice, registerUser, writeHeaders, type Account } from "./support/accounts"
import { expect, test } from "./support/fixtures"
import { editCommentForm, postComment, tuiCommentIds, tuiCommentPage, tuiThreadPage } from "./support/comments"
import { createIssue } from "./support/issues"
import { createRepo, signedIn } from "./support/repos"

// Reading, posting, replying to, editing and removing comments in the
// browser, through Vite's proxy against a real Haxy. Every change is checked
// again after a refresh, and in Haxy's own server-rendered thread pages (the
// TUI's).

const bob: Account = { name: "bobby", email: "bobby@example.test", password: "bobby's password" }
const carol: Account = { name: "carol", email: "carol@example.test", password: "carol's password" }
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

/**
 * Runs `handler` on the first `method` request to `pattern` only; every other
 * request goes on as usual. The route never expires (`times` would count the
 * requests passed on too, so the page's own reads could use it up first).
 */
async function onFirst(page: Page, pattern: RegExp, method: string, handler: (route: Route) => Promise<void>) {
  let pending = true
  await page.route(pattern, async (route) => {
    if (route.request().method() !== method || !pending) return route.fallback()
    pending = false
    await handler(route)
  })
}

/** alice's public tracker with one issue, alice and bob registered. */
async function tracker(playwright: Parameters<typeof signedIn>[0], backend: Parameters<typeof signedIn>[1], hubUrl: string) {
  await registerUser(backend, alice)
  await registerUser(backend, bob)
  const owner = await signedIn(playwright, backend, hubUrl, alice.name, alice.password)
  await createRepo(owner, backend, { name: "tracker", access: "public" })
  const issue = await createIssue(owner, backend, "/alice:tracker", { title: "Crash on save" })
  return { owner, issue }
}

const comments = (page: Page) => page.getByRole("list", { name: "Comments" })
const card = (page: Page, text: string) => page.getByRole("article", { name: /^Comment by / }).filter({ hasText: text })
const cardOf = (page: Page, text: string) => comments(page).getByRole("listitem").filter({ has: card(page, text) })

/** Picks one of a comment's own actions from its menu. */
async function choose(page: Page, comment: Locator, action: "Edit" | "Remove") {
  await comment.getByRole("button", { name: "Comment actions" }).click()
  await page.getByRole("menu").getByRole("menuitem", { name: action }).click()
}

test("a reader comments and replies in the browser; both persist after a refresh and a restart, and Haxy's own pages show them", async ({ page, playwright, launch }) => {
  let backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, issue } = await tracker(playwright, backend, hub.url)
  const issuePath = `/repos/alice/tracker/issues/${issue}`

  // anonymous readers are asked to log in
  await page.goto(`${hub.url}${issuePath}`)
  await expect(page.getByText("No comments yet.")).toBeVisible()
  await expect(page.getByText("to comment on this issue.")).toBeVisible()
  await page.getByRole("link", { name: "Log in", exact: true }).last().click()
  await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(issuePath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))

  await logIn(page, hub.url, bob, issuePath)
  await expect(page).toHaveURL(`${hub.url}${issuePath}`)
  const composer = page.getByRole("form", { name: "New comment" })
  await composer.getByLabel("New comment").fill("Seen it on **Linux** too.")
  // a double click posts once
  const writes = countWrites(page, /\/comments$/)
  await composer.getByRole("button", { name: "Comment" }).dblclick()
  await expect(page).toHaveURL(new RegExp(`${issuePath}#comment-[0-9a-f]{32}$`))
  const first = page.url().split("#comment-")[1]
  expect(writes).toEqual([`POST /api/v1/repos/alice/tracker/issues/${issue}/comments`])
  await expect(card(page, "Seen it on Linux too.")).toBeFocused()
  await expect(card(page, "Seen it on Linux too.").locator("strong")).toHaveText("Linux")
  await expect(composer.getByLabel("New comment")).toHaveValue("")
  await expect(page.getByRole("heading", { name: "Comments (1)" })).toBeVisible()
  await expect(page.getByText("1 comment", { exact: true })).toBeVisible()

  // a reply to that comment, in that comment's card
  await card(page, "Seen it on Linux too.").getByRole("button", { name: "Reply" }).click()
  const reply = page.getByRole("form", { name: "Reply" })
  await reply.getByLabel("Reply").fill("Also on macOS.")
  await reply.getByRole("button", { name: "Post reply" }).click()
  await expect(card(page, "Also on macOS.")).toBeFocused()
  const second = page.url().split("#comment-")[1]
  expect(second).not.toBe(first)
  await expect(cardOf(page, "Seen it on Linux too.").getByRole("region", { name: "1 reply" }).getByRole("article")).toHaveText([/Also on macOS\./])
  await expect(card(page, "Also on macOS.").getByRole("link", { name: /^replying to/ })).toHaveCount(0)

  for (const step of ["refresh", "restart"] as const) {
    if (step === "restart") backend = await backend.restart!()
    await page.reload()
    await expect(comments(page).getByRole("article"), step).toHaveCount(2)
    await expect(card(page, "Also on macOS.")).toBeFocused()
    expect(tuiCommentIds(await tuiThreadPage(backend, "/alice:tracker", issue), "/alice:tracker", issue), step).toEqual([first, second])
    expect(await tuiCommentPage(backend, "/alice:tracker", issue, first), step).toContain("Also on macOS.")
  }

  // the comment's permalink opens its own page, where its reply says whom it answers
  await card(page, "Seen it on Linux too.").getByRole("link", { name: "Permalink" }).click()
  await expect(page).toHaveURL(`${hub.url}${issuePath}/comments/${first}`)
  await expect(page.getByRole("heading", { level: 2, name: "Comment on Crash on save" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "1 reply" })).toBeVisible()
  await expect(page.getByRole("list", { name: "Replies" }).getByRole("article")).toHaveText([/Also on macOS\./])
  await expect(page.getByRole("list", { name: "Replies" }).getByRole("link", { name: "replying to bobby" })).toBeVisible()
  await owner.dispose()
})

test("replies sit in the card of the comment they answer, and each comment's edit and remove are in its menu", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, issue } = await tracker(playwright, backend, hub.url)
  const top = await postComment(owner, backend, "/alice:tracker", issue, "The top comment")
  await postComment(owner, backend, "/alice:tracker", issue, "Another top comment")
  const answer = await postComment(owner, backend, "/alice:tracker", issue, "An answer", top)
  await postComment(owner, backend, "/alice:tracker", issue, "An answer to the answer", answer)
  const issuePath = `/repos/alice/tracker/issues/${issue}`
  await logIn(page, hub.url, alice, issuePath)

  const replies = cardOf(page, "The top comment").getByRole("region", { name: "2 replies" })
  await expect(replies.getByRole("article")).toHaveText([/An answer/, /An answer to the answer/])
  await expect(cardOf(page, "Another top comment").getByRole("region")).toHaveCount(0)
  // a reply to the card's own comment needs no reply context; a reply to a reply says whom it answers
  await expect(card(page, "An answer").first().getByRole("link", { name: /^replying to/ })).toHaveCount(0)
  await expect(card(page, "An answer to the answer").getByRole("link", { name: "replying to alice" })).toBeVisible()
  await expect(card(page, "An answer to the answer").getByRole("button", { name: "Reply" })).toBeVisible()

  await choose(page, card(page, "An answer to the answer"), "Edit")
  const editor = page.getByRole("form", { name: "Edit comment" })
  await editor.getByLabel("Comment").fill("A reworded reply")
  await editor.getByRole("button", { name: "Save comment" }).click()
  await expect(replies.getByRole("article")).toHaveText([/An answer/, /A reworded reply/])

  await choose(page, card(page, "The top comment"), "Remove")
  await page.getByRole("alertdialog", { name: "Remove this comment?" }).getByRole("button", { name: "Remove comment" }).click()
  await expect(comments(page).getByRole("article").first()).toContainText("(removed)")
  await page.reload()
  await expect(cardOf(page, "(removed)").getByRole("region", { name: "2 replies" }).getByRole("article")).toHaveCount(2)

  // on a comment's own page its replies' parent is outside the list, so each reply says whom it answers
  await page.goto(`${hub.url}${issuePath}/comments/${answer}`)
  await expect(page.getByRole("list", { name: "Replies" }).getByRole("article").getByRole("link", { name: "replying to alice" })).toBeVisible()
  await owner.dispose()
})

test("comment pages and permalinks live in the URL: a link to a comment on a later page opens at it after a refresh", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, issue } = await tracker(playwright, backend, hub.url)
  const ids: string[] = []
  for (let n = 1; n <= 12; n++) ids.push(await postComment(owner, backend, "/alice:tracker", issue, `Comment number ${n}.`))
  const replies: string[] = []
  for (let n = 1; n <= 11; n++) replies.push(await postComment(owner, backend, "/alice:tracker", issue, `Reply number ${n}.`, ids[0]))
  const issuePath = `/repos/alice/tracker/issues/${issue}`

  // the TUI's windows: ten comments (here replies are comments of the thread too), oldest first
  await page.goto(`${hub.url}${issuePath}`)
  await expect(comments(page).getByRole("article")).toHaveCount(10)
  await expect(comments(page).getByRole("article").first()).toContainText("Comment number 1.")
  const pages = page.getByRole("navigation", { name: "Comment pages" })
  await pages.getByRole("link", { name: "Next page" }).click()
  await expect(page).toHaveURL(new RegExp(`${issuePath}\\?comments=`))
  await expect(comments(page).getByRole("article").first()).toContainText("Comment number 11.")
  await page.reload()
  await expect(comments(page).getByRole("article").first()).toContainText("Comment number 11.")
  await pages.getByRole("link", { name: "Previous page" }).click()
  await expect(comments(page).getByRole("article").first()).toContainText("Comment number 1.")

  // a comment's permalink is its own page, which survives a refresh
  await pages.getByRole("link", { name: "Next page" }).click()
  await card(page, "Comment number 12.").getByRole("link", { name: "Permalink" }).click()
  await expect(page).toHaveURL(`${hub.url}${issuePath}/comments/${ids[11]}`)
  await page.reload()
  await expect(card(page, "Comment number 12.")).toBeVisible()
  await expect(page.getByRole("heading", { name: "0 replies" })).toBeVisible()

  // ... and leads into the thread at the page that holds it, focused on it, after a refresh too
  await page.getByRole("link", { name: "Show in the issue's comments" }).click()
  await expect(page).toHaveURL(new RegExp(`${issuePath}\\?comments=[^#]+#comment-${ids[11]}$`))
  await expect(card(page, "Comment number 12.")).toBeFocused()
  await page.reload()
  await expect(card(page, "Comment number 12.")).toBeFocused()
  await expect(card(page, "Comment number 12.")).toBeInViewport()

  // a comment's replies come in windows too, kept in the URL
  await page.goto(`${hub.url}${issuePath}/comments/${ids[0]}`)
  await expect(page.getByRole("heading", { name: "11 replies" })).toBeVisible()
  const replyList = page.getByRole("list", { name: "Replies" })
  await expect(replyList.getByRole("article")).toHaveCount(10)
  await page.getByRole("navigation", { name: "Reply pages" }).getByRole("link", { name: "Next page" }).click()
  await expect(page).toHaveURL(new RegExp(`/comments/${ids[0]}\\?replies=`))
  await page.reload()
  await expect(replyList.getByRole("article")).toHaveText([/Reply number 11\./])
  await owner.dispose()
})

test("authors edit and remove their own comments, the repository's owner moderates them, and others are offered neither", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, issue } = await tracker(playwright, backend, hub.url)
  await registerUser(backend, carol)
  const author = await signedIn(playwright, backend, hub.url, bob.name, bob.password)
  const bobs = await postComment(author, backend, "/alice:tracker", issue, "Frist")
  const issuePath = `/repos/alice/tracker/issues/${issue}`

  // another reader may reply, but neither edit nor remove
  await logIn(page, hub.url, carol, issuePath)
  await expect(card(page, "Frist").getByRole("button", { name: "Reply" })).toBeVisible()
  await expect(card(page, "Frist").getByRole("button", { name: "Comment actions" })).toHaveCount(0)
  await page.context().clearCookies()

  // the author edits it; an edit made after someone else's change is held back
  await logIn(page, hub.url, bob, issuePath)
  await choose(page, card(page, "Frist"), "Edit")
  const editor = page.getByRole("form", { name: "Edit comment" })
  await editor.getByLabel("Comment").fill("First!")
  await editor.getByRole("button", { name: "Save comment" }).click()
  await expect(card(page, "First!")).toBeVisible()
  await expect(editor).toHaveCount(0)
  await page.reload()
  await expect(card(page, "First!")).toBeVisible()
  expect(await tuiThreadPage(backend, "/alice:tracker", issue)).toContain("First!")

  await choose(page, card(page, "First!"), "Edit")
  await editor.getByLabel("Comment").fill("First! (mine)")
  await editCommentForm(owner, backend, "/alice:tracker", issue, bobs, "First! (moderated)")
  await editor.getByRole("button", { name: "Save comment" }).click()
  await expect(editor.getByText("Someone changed this comment since you started editing it")).toBeVisible()
  await expect(editor.getByLabel("Comment")).toHaveValue("First! (mine)")
  await editor.getByRole("button", { name: "Show the current version" }).click()
  await expect(editor.getByRole("region", { name: "Current version" })).toContainText("First! (moderated)")
  await editor.getByRole("button", { name: "Save comment" }).click()
  // the editor's own field holds the text too, so the card shows it before
  // the save lands; the editor closes once Haxy has answered
  await expect(editor).toHaveCount(0)
  await expect(card(page, "First! (mine)")).toBeVisible()
  expect(await tuiThreadPage(backend, "/alice:tracker", issue)).toContain("First! (mine)")
  await page.context().clearCookies()

  // the repository's owner removes it, after confirming; it stays in the thread as removed
  await logIn(page, hub.url, alice, issuePath)
  const writes = countWrites(page, /\/comments\/[0-9a-f]{32}$/)
  await choose(page, card(page, "First! (mine)"), "Remove")
  const confirm = page.getByRole("alertdialog", { name: "Remove this comment?" })
  await confirm.getByRole("button", { name: "Cancel" }).click()
  expect(writes).toEqual([])
  await choose(page, card(page, "First! (mine)"), "Remove")
  await confirm.getByRole("button", { name: "Remove comment" }).dblclick()
  await expect(comments(page).getByRole("article").first()).toContainText("(removed)")
  expect(writes).toEqual([`DELETE /api/v1/repos/alice/tracker/issues/${issue}/comments/${bobs}`])
  await page.reload()
  await expect(comments(page).getByRole("article").first()).toContainText("(removed)")
  await expect(comments(page).getByRole("article").first().getByRole("button", { name: "Comment actions" })).toHaveCount(0)
  const tui = await tuiThreadPage(backend, "/alice:tracker", issue)
  expect(tui).toContain("(removed)")
  expect(tui).not.toContain("First! (mine)")
  await owner.dispose()
  await author.dispose()
})

test("a post whose answer is lost is looked up by its id; a retry never posts twice", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, issue } = await tracker(playwright, backend, hub.url)
  const issuePath = `/repos/alice/tracker/issues/${issue}`
  const create = new RegExp(`/issues/${issue}/comments$`)
  await logIn(page, hub.url, bob, issuePath)
  const composer = page.getByRole("form", { name: "New comment" })

  // Haxy posts it, but its answer never arrives: the composer finds it, and opens it
  await onFirst(page, create, "POST", async (route) => {
    await route.fetch()
    await route.abort("connectionreset")
  })
  await composer.getByLabel("New comment").fill("Lost answer")
  await composer.getByRole("button", { name: "Comment" }).click()
  await expect(card(page, "Lost answer")).toBeFocused()
  expect(tuiCommentIds(await tuiThreadPage(backend, "/alice:tracker", issue), "/alice:tracker", issue)).toHaveLength(1)

  // the request never reaches Haxy: nothing was posted, and a retry posts it once
  await onFirst(page, create, "POST", (route) => route.abort("connectionreset"))
  await composer.getByLabel("New comment").fill("Never sent")
  await composer.getByRole("button", { name: "Comment" }).click()
  await expect(composer.getByText("nothing was posted")).toBeVisible()
  await expect(composer.getByLabel("New comment")).toHaveValue("Never sent")
  await composer.getByRole("button", { name: "Comment" }).click()
  await expect(card(page, "Never sent")).toBeFocused()
  expect(tuiCommentIds(await tuiThreadPage(backend, "/alice:tracker", issue), "/alice:tracker", issue)).toHaveLength(2)

  // an edit whose answer is lost is settled by reading the comment
  await onFirst(page, /\/comments\/[0-9a-f]{32}$/, "PATCH", async (route) => {
    await route.fetch()
    await route.abort("connectionreset")
  })
  await choose(page, card(page, "Never sent"), "Edit")
  await page.getByRole("form", { name: "Edit comment" }).getByLabel("Comment").fill("Sent after all")
  await page.getByRole("form", { name: "Edit comment" }).getByRole("button", { name: "Save comment" }).click()
  await expect(card(page, "Sent after all")).toBeVisible()
  await expect(page.getByRole("form", { name: "Edit comment" })).toHaveCount(0)
  await owner.dispose()
})

test("local mode comments, replies, edits and removes without logging in", async ({ page, request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const issue = await createIssue(request, backend, "", { title: "Offline bug" })
  const fromTui = await postComment(request, backend, "", issue, "From the TUI")

  await page.goto(`${hub.url}/repo/issues/${issue}`)
  await expect(card(page, "From the TUI")).toBeVisible()
  await card(page, "From the TUI").getByRole("button", { name: "Reply" }).click()
  await page.getByRole("form", { name: "Reply" }).getByLabel("Reply").fill("From Hub")
  await page.getByRole("form", { name: "Reply" }).getByRole("button", { name: "Post reply" }).click()
  await expect(card(page, "From Hub")).toBeFocused()
  await expect(cardOf(page, "From the TUI").getByRole("region", { name: "1 reply" }).getByRole("article")).toHaveText([/From Hub/])
  expect(await tuiCommentPage(backend, "", issue, fromTui)).toContain("From Hub")

  await choose(page, card(page, "From the TUI"), "Edit")
  await page.getByRole("form", { name: "Edit comment" }).getByLabel("Comment").fill("From the TUI, edited in Hub")
  await page.getByRole("form", { name: "Edit comment" }).getByRole("button", { name: "Save comment" }).click()
  // the card shows the editor's text before the save lands; the editor closes once Haxy has answered
  await expect(page.getByRole("form", { name: "Edit comment" })).toHaveCount(0)
  await expect(card(page, "edited in Hub")).toBeVisible()
  await choose(page, card(page, "From Hub"), "Remove")
  await page.getByRole("alertdialog", { name: "Remove this comment?" }).getByRole("button", { name: "Remove comment" }).click()
  await page.reload()
  await expect(comments(page).getByRole("article")).toHaveText([/edited in Hub/, /\(removed\)/])
  const tui = await tuiThreadPage(backend, "", issue)
  expect(tui).toContain("edited in Hub")
  expect(tui).toContain("(removed)")
})

test("an edit made after another tab switched accounts says who is signed in now, with a reload, and changes nothing", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, issue } = await tracker(playwright, backend, hub.url)
  await registerUser(backend, carol)
  const author = await signedIn(playwright, backend, hub.url, bob.name, bob.password)
  await postComment(author, backend, "/alice:tracker", issue, "Mine to edit")
  const issuePath = `/repos/alice/tracker/issues/${issue}`
  await logIn(page, hub.url, bob, issuePath)
  await choose(page, card(page, "Mine to edit"), "Edit")
  const editor = page.getByRole("form", { name: "Edit comment" })
  await editor.getByLabel("Comment").fill("Edited by whoever is signed in")

  // another tab of the same browser (sharing its cookies) signs in as carol meanwhile
  const shared = page.context().request
  const login = await shared.post(`${hub.url}/api/v1/session`, { headers: { ...(await writeHeaders(shared, hub.url)), "Content-Type": "application/json" }, data: JSON.stringify({ username: carol.name, password: carol.password }) })
  expect(login.status(), await login.text()).toBe(200)
  await editor.getByRole("button", { name: "Save comment" }).click()
  await expect(editor.getByRole("alert")).toContainText(`signed in as ${carol.name} now`)
  await expect(editor.getByText("has been removed")).toHaveCount(0)
  await expect(editor.getByLabel("Comment")).toHaveValue("Edited by whoever is signed in")
  expect(await tuiThreadPage(backend, "/alice:tracker", issue)).toContain("Mine to edit")
  await editor.getByRole("button", { name: "Reload" }).click()
  await expect(header(page)).toContainText(`Signed in as ${carol.name}`)
  await owner.dispose()
  await author.dispose()
})

test("edits and removals on two comments that overlap both show, without a refresh", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, issue } = await tracker(playwright, backend, hub.url)
  await postComment(owner, backend, "/alice:tracker", issue, "Keep me, edited later")
  await postComment(owner, backend, "/alice:tracker", issue, "Remove me")
  await logIn(page, hub.url, alice, `/repos/alice/tracker/issues/${issue}`)

  // Haxy's answers are held until both writes have been sent, then the edit's arrives last
  const held: Array<() => Promise<void>> = []
  let release: () => void = () => {}
  const bothSent = new Promise<void>((resolve) => { release = resolve })
  await page.route(/\/comments\/[0-9a-f]{32}$/, async (route) => {
    if (route.request().method() === "GET") return route.fallback()
    const response = await route.fetch()
    held.push(() => route.fulfill({ response }))
    if (held.length === 2) release()
    await bothSent
  })
  await choose(page, card(page, "Keep me"), "Edit")
  await page.getByRole("form", { name: "Edit comment" }).getByLabel("Comment").fill("Kept and edited")
  await page.getByRole("form", { name: "Edit comment" }).getByRole("button", { name: "Save comment" }).click()
  await choose(page, card(page, "Remove me"), "Remove")
  await page.getByRole("alertdialog", { name: "Remove this comment?" }).getByRole("button", { name: "Remove comment" }).click()
  await bothSent
  // the removal's answer first, then the edit's
  await held[1]()
  await expect(comments(page).getByRole("article").nth(1)).toContainText("(removed)")
  await held[0]()
  await expect(comments(page).getByRole("article")).toHaveText([/Kept and edited/, /\(removed\)/])
  await owner.dispose()
})

test("a malformed comment fragment in the URL is ignored", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, issue } = await tracker(playwright, backend, hub.url)
  await postComment(owner, backend, "/alice:tracker", issue, "Still shown")
  for (const fragment of ["comment-%", "comment-%E0%A4%A", "comment-not-an-id"]) {
    await page.goto(`${hub.url}/repos/alice/tracker/issues/${issue}#${fragment}`)
    await expect(page.getByRole("heading", { level: 2, name: "Crash on save" }), fragment).toBeVisible()
    await expect(card(page, "Still shown"), fragment).toBeVisible()
    await expect(card(page, "Still shown"), fragment).not.toBeFocused()
  }
  await owner.dispose()
})

test("a post that may still land keeps its text until its outcome is settled, so a retry posts exactly what was sent", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, issue } = await tracker(playwright, backend, hub.url)
  const issuePath = `/repos/alice/tracker/issues/${issue}`
  await logIn(page, hub.url, bob, issuePath)
  const composer = page.getByRole("form", { name: "New comment" })

  // the browser gives up on the post before Haxy has it; the same request reaches Haxy later
  let late: { headers: Record<string, string>; body: string } | null = null
  await onFirst(page, new RegExp(`/issues/${issue}/comments$`), "POST", async (route) => {
    late = { headers: await route.request().allHeaders(), body: route.request().postData() ?? "" }
    await route.abort("connectionreset")
  })
  await composer.getByLabel("New comment").fill("The original text")
  await composer.getByRole("button", { name: "Comment" }).click()
  await expect(composer.getByText("nothing was posted")).toBeVisible()
  // the retry can only be the same post: its text can't change meanwhile
  await expect(composer.getByLabel("New comment")).toBeDisabled()
  await expect(composer.getByLabel("New comment")).toHaveValue("The original text")

  const sent = late!
  const landed = await page.context().request.post(`${hub.url}/api/v1/repos/alice/tracker/issues/${issue}/comments`, {
    headers: { "Content-Type": "application/json", "X-Haxy-CSRF": sent.headers["x-haxy-csrf"], "X-Haxy-Viewer": sent.headers["x-haxy-viewer"], Origin: hub.url },
    data: sent.body,
  })
  expect(landed.status(), await landed.text()).toBe(201)
  await composer.getByRole("button", { name: "Comment" }).click()
  await expect(card(page, "The original text")).toBeFocused()
  expect(tuiCommentIds(await tuiThreadPage(backend, "/alice:tracker", issue), "/alice:tracker", issue)).toHaveLength(1)
  await owner.dispose()
})

test("an edit that lands after the comments were read again still shows, without a refresh", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, issue } = await tracker(playwright, backend, hub.url)
  await postComment(owner, backend, "/alice:tracker", issue, "Before the edit")
  await logIn(page, hub.url, alice, `/repos/alice/tracker/issues/${issue}`)

  // the edit is held before it reaches Haxy
  let releaseEdit: () => void = () => {}
  const editHeld = new Promise<void>((resolve) => { releaseEdit = resolve })
  let editSent: () => void = () => {}
  const editArrived = new Promise<void>((resolve) => { editSent = resolve })
  await page.route(/\/comments\/[0-9a-f]{32}$/, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback()
    editSent()
    await editHeld
    await route.continue()
  })
  await choose(page, card(page, "Before the edit"), "Edit")
  await page.getByRole("form", { name: "Edit comment" }).getByLabel("Comment").fill("After the edit")
  await page.getByRole("form", { name: "Edit comment" }).getByRole("button", { name: "Save comment" }).click()
  await editArrived

  // meanwhile a new comment is posted, and the window is read again without the edit
  const composer = page.getByRole("form", { name: "New comment" })
  await composer.getByLabel("New comment").fill("A new comment")
  await composer.getByRole("button", { name: "Comment" }).click()
  await expect(card(page, "A new comment")).toBeFocused()

  releaseEdit()
  await expect(page.getByRole("form", { name: "Edit comment" })).toHaveCount(0)
  await expect(comments(page).getByRole("article")).toHaveText([/After the edit/, /A new comment/])
  await owner.dispose()
})

test("a refresh that fails after a write keeps the comments and every open draft, and says so with a retry", async ({ page, playwright, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  const { owner, issue } = await tracker(playwright, backend, hub.url)
  const first = await postComment(owner, backend, "/alice:tracker", issue, "Being edited")
  await postComment(owner, backend, "/alice:tracker", issue, "To be removed")
  const issuePath = `/repos/alice/tracker/issues/${issue}`
  await logIn(page, hub.url, alice, issuePath)
  const internal = { status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Haxy failed." } }) }

  // the thread page: an edit and a new comment are being written when another comment is removed
  await choose(page, card(page, "Being edited"), "Edit")
  await page.getByRole("form", { name: "Edit comment" }).getByLabel("Comment").fill("Unsaved edit")
  await page.getByRole("form", { name: "New comment" }).getByLabel("New comment").fill("Unsent comment")
  await onFirst(page, new RegExp(`/issues/${issue}/comments(\\?.*)?$`), "GET", (route) => route.fulfill(internal))
  await choose(page, card(page, "To be removed"), "Remove")
  await page.getByRole("alertdialog", { name: "Remove this comment?" }).getByRole("button", { name: "Remove comment" }).click()
  const refresh = page.getByRole("alert").filter({ hasText: "Couldn't refresh the comments" })
  await expect(refresh).toBeVisible()
  await expect(page.getByRole("form", { name: "Edit comment" }).getByLabel("Comment")).toHaveValue("Unsaved edit")
  await expect(page.getByRole("form", { name: "New comment" }).getByLabel("New comment")).toHaveValue("Unsent comment")
  await expect(comments(page).getByRole("article").nth(1)).toContainText("(removed)")
  await refresh.getByRole("button", { name: "Retry" }).click()
  await expect(refresh).toHaveCount(0)
  await expect(page.getByRole("form", { name: "Edit comment" }).getByLabel("Comment")).toHaveValue("Unsaved edit")

  // the comment's own page: a reply is being written when one of its replies is removed
  const reply = await postComment(owner, backend, "/alice:tracker", issue, "A reply to remove", first)
  await page.goto(`${hub.url}${issuePath}/comments/${first}`)
  await card(page, "Being edited").getByRole("button", { name: "Reply" }).click()
  await page.getByRole("form", { name: "Reply" }).getByLabel("Reply").fill("Unsent reply")
  await onFirst(page, new RegExp(`/comments/${first}(\\?.*)?$`), "GET", (route) => route.fulfill(internal))
  await choose(page, page.locator(`#comment-${reply}`), "Remove")
  await page.getByRole("alertdialog", { name: "Remove this comment?" }).getByRole("button", { name: "Remove comment" }).click()
  const pageRefresh = page.getByRole("alert").filter({ hasText: "Couldn't refresh this comment" })
  await expect(pageRefresh).toBeVisible()
  await expect(page.getByRole("form", { name: "Reply" }).getByLabel("Reply")).toHaveValue("Unsent reply")
  await expect(page.locator(`#comment-${reply}`)).toContainText("(removed)")
  await pageRefresh.getByRole("button", { name: "Retry" }).click()
  await expect(pageRefresh).toHaveCount(0)
  await expect(page.getByRole("form", { name: "Reply" }).getByLabel("Reply")).toHaveValue("Unsent reply")
  await owner.dispose()
})
