import { writeFile } from "node:fs/promises"
import path from "node:path"
import type { Page } from "@playwright/test"
import { expect, test } from "./support/fixtures"
import { alice as aliceAccount, registerUser } from "./support/accounts"
import type { FixtureRef } from "./support/backend"
import { addCommits, localGit } from "./support/history"
import { pushRepo } from "./support/push"
import { createIssue } from "./support/issues"
import { createRepo, signedIn } from "./support/repos"

// Browser workflows for commit history, full commit messages and commit
// search, against real Haxy fixtures through Vite's proxy.

/** The listed commits' summaries, in order. */
async function expectSummaries(page: Page, summaries: string[]) {
  const items = page.getByRole("list", { name: "Commits" }).getByRole("listitem")
  await expect(items).toHaveCount(summaries.length)
  for (const [index, summary] of summaries.entries()) await expect(items.nth(index)).toHaveAccessibleName(summary)
}

const bob = { name: "Bob", email: "bob@example.test" }
const carol = { name: "Carol", email: "carol@example.test" }
const latin1 = Uint8Array.from([...Buffer.from("caf"), 0xe9])

test("a reader pages through the history, opens a commit's whole message and comes back", async ({ page, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const git = localGit(backend)
  const long = ["A long explanation", "", ...Array.from({ length: 60 }, (_, index) => `detail line ${index + 1}`)].join("\n")
  addCommits(git, [
    { message: long },
    { message: "Applied by carol", author: bob, committer: carol },
    ...Array.from({ length: 21 }, (_, index) => ({ message: `change ${index + 1}` })),
  ])
  git(["checkout", "--quiet", "-b", "side"])
  addCommits(git, [{ message: "side work" }])
  git(["checkout", "--quiet", "main"])
  addCommits(git, [{ message: "Merge side", merge: "side" }])
  await page.goto(`${hub.url}/repo`)

  await page.getByRole("navigation", { name: "Repository sections" }).getByRole("link", { name: "Commits" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/commits`)
  const commits = page.getByRole("list", { name: "Commits" })
  await expect(commits.getByRole("listitem")).toHaveCount(20)
  const merge = commits.getByRole("listitem", { name: "Merge side" })
  await expect(merge).toContainText("Merge")
  // local git repositories have no statistics, which says so rather than zero
  await expect(merge).toContainText("Statistics unavailable")
  // and no commit search
  await expect(page.getByRole("status", { name: "Commit search" })).toContainText("Commit search is unavailable here.")
  await expect(page.getByRole("searchbox")).toHaveCount(0)

  // the next page is in the URL, survives a refresh, and back returns
  await page.getByRole("navigation", { name: "History pages" }).getByRole("link", { name: "Next page" }).click()
  await expect(page).toHaveURL(new RegExp("/repo/commits\\?cursor=[0-9a-f]{40}$"))
  await page.reload()
  const applied = page.getByRole("list", { name: "Commits" }).getByRole("listitem", { name: "Applied by carol" })
  await expect(applied).toContainText("by bob@example.test")
  await expect(applied).toContainText("committed by carol@example.test")
  // a committer who is the author isn't repeated
  await expect(page.getByRole("list", { name: "Commits" }).getByRole("listitem", { name: "A long explanation" })).not.toContainText("committed by")
  await page.goBack()
  await expect(page.getByRole("list", { name: "Commits" }).getByRole("listitem", { name: "Merge side" })).toBeVisible()
  await page.goForward()

  // the whole message, longer than the TUI's preview
  await page.getByRole("list", { name: "Commits" }).getByRole("link", { name: "A long explanation" }).click()
  await expect(page).toHaveURL(new RegExp("/repo/commits/[0-9a-f]{40}$"))
  const message = page.getByRole("region", { name: "Commit message" }).or(page.getByLabel("Commit message"))
  await expect(message).toContainText("detail line 60")
  await expect(page.getByRole("status", { name: "Truncated message" })).toHaveCount(0)
  await page.reload()
  await expect(message).toContainText("detail line 60")
  await page.getByRole("link", { name: "Back to the history" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/commits`)

  // from a commit to its files
  await page.getByRole("list", { name: "Commits" }).getByRole("link", { name: "Merge side" }).click()
  const id = /\/repo\/commits\/([0-9a-f]{40})$/.exec(page.url())?.[1]
  await page.getByRole("link", { name: "Browse files at this commit" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo?ref=commit:${id}`)
  await expect(page.getByRole("region", { name: "Ref" })).toContainText(`Commit ${id}`)
})

test("a message past Haxy's limit opens cut short, and says so", async ({ page, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  const [id] = addCommits(localGit(backend), [{ message: `Huge\n\n${"x".repeat(110 * 1024)}\nthe end` }])
  await page.goto(`${hub.url}/repo/commits/${id}`)
  await expect(page.getByRole("status", { name: "Truncated message" })).toBeVisible()
  await expect(page.getByLabel("Commit message")).not.toContainText("the end")
  await expect(page.getByRole("heading", { name: "Huge" })).toBeVisible()
})

const refs: FixtureRef[] = [
  { kind: "branch", name: "feature/a b", files: { "which.txt": "feature/a b\n" } },
  { kind: "branch", name: "naïve/ünï", files: { "which.txt": "naïve/ünï\n" } },
  { kind: "branch", name: "x%41y", files: { "which.txt": "x%41y\n" } },
  { kind: "branch", name: "a%2Fb", files: { "which.txt": "a%2Fb\n" } },
  { kind: "branch", name: latin1, files: { "which.txt": "latin-1\n" } },
]

for (const [label, search, name, id] of [
  ["a slash and a space", "feature", "feature/a b", "branch:feature/a%20b"],
  ["Unicode", "na", "naïve/ünï", "branch:na%C3%AFve/%C3%BCn%C3%AF"],
  ["a literal %41", "x", "x%41y", "branch:x%2541y"],
  ["a literal %2F", "a", "a%2Fb", "branch:a%252Fb"],
  ["a byte that isn't UTF-8", "caf", "caf�", "branch:caf%E9"],
] as const) {
  test(`the history of a branch whose name holds ${label} follows it through links, refresh and back/forward`, async ({ page, launch }) => {
    const backend = await launch.local({ files: { "which.txt": "main\n" }, refs })
    const hub = await launch.hub(backend.port)
    await page.goto(`${hub.url}/repo/branches?search=${encodeURIComponent(search)}`)
    await page.getByRole("list", { name: "Branches" }).getByRole("link", { name, exact: true }).click()
    await expect(page).toHaveURL(`${hub.url}/repo?ref=${id}`)

    // the files view's ref bar leads to that ref's history
    await page.getByRole("region", { name: "Ref" }).getByRole("link", { name: "History" }).click()
    await expect(page).toHaveURL(`${hub.url}/repo/commits?ref=${id}`)
    await expect(page.getByRole("region", { name: "Ref" })).toContainText(`Branch ${name}`)
    const commits = page.getByRole("list", { name: "Commits" })
    await expect(commits.getByRole("listitem")).toHaveCount(2)
    await expect(commits.getByRole("listitem").first()).toContainText(/Commit for ref \d/)
    await page.reload()
    await expect(page.getByRole("region", { name: "Ref" })).toContainText(`Branch ${name}`)

    // a commit keeps the ref for its way back
    await commits.getByRole("link", { name: /Commit for ref/ }).click()
    await expect(page).toHaveURL(new RegExp(`/repo/commits/[0-9a-f]{40}\\?ref=${id.replace(/[%.*+?^${}()|[\]\\]/g, "\\$&")}$`))
    await page.getByRole("link", { name: "Back to the history" }).click()
    await expect(page).toHaveURL(`${hub.url}/repo/commits?ref=${id}`)
    await page.goBack()
    await page.goBack()
    await expect(page).toHaveURL(`${hub.url}/repo/commits?ref=${id}`)
    await expect(page.getByRole("region", { name: "Ref" })).toContainText(`Branch ${name}`)

    // and back to the default branch's history
    await page.getByRole("region", { name: "Ref" }).getByRole("link", { name: "Default branch" }).click()
    await expect(page).toHaveURL(`${hub.url}/repo/commits`)
    await expect(page.getByRole("list", { name: "Commits" }).getByRole("listitem")).toHaveCount(1)
  })
}

test("a reader searches an indexed history, tells no matches from unavailable search, and sees statistics", async ({ page, playwright, launch }) => {
  const backend = await launch.server({ ssh: true })
  const hub = await launch.hub(backend.port)
  await registerUser(backend, aliceAccount)
  const context = await signedIn(playwright, backend, hub.url, aliceAccount.name, aliceAccount.password)
  await createRepo(context, backend, { name: "parser", access: "public" })
  await pushRepo(playwright, backend, hub.url, aliceAccount, { owner: "alice", name: "parser" }, {
    files: { "README.md": "# parser\n" },
    refs: [{ kind: "branch", name: "feature/café", files: { "notes.txt": "lexer notes\n" } }],
    history: (git) => addCommits(git, [
      { message: "Add the tokenizer", files: { "src/tokenizer.txt": "one\ntwo\nthree\n" } },
      { message: "Fix the tokenizer's whitespace", files: { "src/tokenizer.txt": "one\ntwo\nthree four\n" } },
      { message: "Document the lexer" },
    ]),
  })
  await context.dispose()
  await page.goto(`${hub.url}/repos/alice/parser/commits`)

  await expect(page.getByText("4 commits")).toBeVisible()
  const added = page.getByRole("list", { name: "Commits" }).getByRole("listitem", { name: "Add the tokenizer" })
  await expect(added.getByLabel("Statistics")).toContainText("3 lines added")
  await expect(added.getByLabel("Statistics")).toContainText("1 file added")
  // a commit's email that an account holds shows as that account
  await expect(added.getByRole("link", { name: "alice", exact: true })).toHaveAttribute("href", "/users/alice")

  await page.getByRole("searchbox", { name: "Search commits" }).fill("tokenizer")
  await page.getByRole("button", { name: "Search" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/parser/commits?ref=branch:main&search=tokenizer`)
  await expect(page.getByRole("status", { name: "Active search" })).toContainText("tokenizer")
  await expectSummaries(page, ["Fix the tokenizer's whitespace", "Add the tokenizer"])
  await page.reload()
  await expectSummaries(page, ["Fix the tokenizer's whitespace", "Add the tokenizer"])

  // no matches is its own state
  await page.getByRole("searchbox", { name: "Search commits" }).fill("nothing")
  await page.getByRole("button", { name: "Search" }).click()
  await expect(page.getByRole("region", { name: "No commits match “nothing”" })).toBeVisible()

  // a branch named with Unicode is indexed too
  await page.goto(`${hub.url}/repos/alice/parser/commits?ref=branch:feature/caf%C3%A9`)
  await expect(page.getByRole("region", { name: "Ref" })).toContainText("Branch feature/café")
  await page.getByRole("searchbox", { name: "Search commits" }).fill("initial")
  await page.getByRole("button", { name: "Search" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/parser/commits?ref=branch:feature/caf%C3%A9&search=initial`)
  await expectSummaries(page, ["Initial commit"])

  // a commit's own history searches the default branch
  const commit = await page.evaluate(async () => (await (await fetch("/api/v1/repos/alice/parser/commits")).json()).items[2].id as string)
  await page.goto(`${hub.url}/repos/alice/parser/commits?ref=commit:${commit}`)
  await page.getByRole("searchbox", { name: "Search commits" }).fill("lexer")
  await page.getByRole("button", { name: "Search" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/alice/parser/commits?ref=branch:main&search=lexer`)
  await expectSummaries(page, ["Document the lexer"])

  // a shared search URL where Haxy can't search shows it as unavailable, not as no matches
  await page.goto(`${hub.url}/repos/alice/parser/commits?ref=commit:${commit}&search=lexer`)
  await expect(page.getByRole("region", { name: "Commit search is unavailable" })).toBeVisible()
})

test("a local history with search in its URL shows search as unavailable", async ({ page, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)
  await page.goto(`${hub.url}/repo/commits?search=initial`)
  await expect(page.getByRole("region", { name: "Commit search is unavailable" })).toBeVisible()
  await page.getByRole("link", { name: "Show the history" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/commits`)
  await expect(page.getByRole("list", { name: "Commits" }).getByRole("listitem")).toHaveCount(1)
})

test("Haxy's own commits links lead to the matching Hub pages, on a server and in local mode", async ({ page, request, launch }) => {
  const oid = "0123456789abcdef0123456789abcdef01234567"
  const server = await launch.server()
  // the documented way to change the about page: edit admin/ABOUT.md in the server dir
  await writeFile(path.join(server.dataDir, "admin", "ABOUT.md"), [
    "# Links",
    "",
    `[history](/bobby:linux/commits) [at branch](/bobby:linux/commits/branch:a%2Fb%20c/search:fix%20it/from:${oid}) [at tag](/bobby:linux/commits/tag:v1)`,
    `[one](/bobby:linux/commits/object:${oid}) [message](/bobby:linux/commits/object:${oid}/message)`,
    `[bounded](/bobby:linux/commits/object:${oid}/base:${oid}) [merged](/bobby:linux/commits/merge:${oid})`,
  ].join("\n"))
  const serverHub = await launch.hub(server.port)
  await page.goto(`${serverHub.url}/about`)
  const main = page.getByRole("main")
  for (const [name, href] of [
    ["history", "/repos/bobby/linux/commits"],
    // a page's `from:` is dropped, as Hub cursors are opaque
    ["at branch", "/repos/bobby/linux/commits?ref=branch:a/b%20c&search=fix+it"],
    ["at tag", "/repos/bobby/linux/commits?ref=tag:v1"],
    ["one", `/repos/bobby/linux/commits/${oid}`],
    ["message", `/repos/bobby/linux/commits/${oid}`],
    // no Hub equivalent yet
    ["bounded", `/bobby:linux/commits/object:${oid}/base:${oid}`],
    ["merged", `/bobby:linux/commits/merge:${oid}`],
  ]) await expect(main.getByRole("link", { name, exact: true }), name).toHaveAttribute("href", href)

  // local Haxy's URLs leave the repository out
  const local = await launch.local()
  const localHub = await launch.hub(local.port)
  const [id] = addCommits(localGit(local), [{ message: "Linked commit" }])
  const linker = await createIssue(request, local, "", { title: "Links", description: `[history](/commits) [one](/commits/object:${id})` })
  await page.goto(`${localHub.url}/repo/issues/${linker}`)
  const description = page.getByRole("region", { name: "Description" })
  await expect(description.getByRole("link", { name: "history" })).toHaveAttribute("href", "/repo/commits")
  await description.getByRole("link", { name: "one" }).click()
  await expect(page).toHaveURL(`${localHub.url}/repo/commits/${id}`)
  await expect(page.getByRole("heading", { name: "Linked commit" })).toBeVisible()
})

test("a repository named commits, owned by someone whose name starts with commits, shows its history and commits", async ({ page, playwright, launch }) => {
  const backend = await launch.server({ ssh: true })
  const hub = await launch.hub(backend.port)
  const owner = { name: "commitsbot", email: "commitsbot@example.test", password: "correct horse battery" }
  await registerUser(backend, owner)
  const context = await signedIn(playwright, backend, hub.url, owner.name, owner.password)
  await createRepo(context, backend, { name: "commits", access: "public" })
  await context.dispose()
  await pushRepo(playwright, backend, hub.url, owner, { owner: "commitsbot", name: "commits" }, {
    history: (git) => addCommits(git, [{ message: "Second commit" }]),
  })

  await page.goto(`${hub.url}/repos/commitsbot/commits`)
  await page.getByRole("navigation", { name: "Repository sections" }).getByRole("link", { name: "Commits" }).click()
  await expect(page).toHaveURL(`${hub.url}/repos/commitsbot/commits/commits`)
  await expectSummaries(page, ["Second commit", "Initial commit"])
  await page.getByRole("list", { name: "Commits" }).getByRole("link", { name: "Second commit" }).click()
  await expect(page).toHaveURL(new RegExp("/repos/commitsbot/commits/commits/[0-9a-f]{40}$"))
  await expect(page.getByRole("heading", { name: "Second commit" })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("heading", { name: "Second commit" })).toBeVisible()
})

test("the Files and Commits section tabs keep the ref the page is at", async ({ page, request, launch }) => {
  const backend = await launch.local({ files: { "which.txt": "main\n" }, refs })
  const hub = await launch.hub(backend.port)
  const first = await (await request.get(`${hub.url}/api/v1/repo/commits?ref=branch:x%2541y`)).json()
  for (const [id, label] of [
    ["branch:feature/a%20b", "Branch feature/a b"],
    ["branch:x%2541y", "Branch x%41y"],
    ["branch:caf%E9", "Branch caf�"],
    [`commit:${first.items[0].id}`, `Commit ${first.items[0].id}`],
  ]) {
    await page.goto(`${hub.url}/repo?ref=${id}`)
    const sections = page.getByRole("navigation", { name: "Repository sections" })
    await sections.getByRole("link", { name: "Commits" }).click()
    await expect(page).toHaveURL(`${hub.url}/repo/commits?ref=${id}`)
    await expect(page.getByRole("region", { name: "Ref" })).toContainText(label)
    await sections.getByRole("link", { name: "Files" }).click()
    await expect(page).toHaveURL(`${hub.url}/repo?ref=${id}`)
    await expect(page.getByRole("region", { name: "Ref" })).toContainText(label)
  }
  // a page without a ref stays on the default branch
  await page.goto(`${hub.url}/repo/branches`)
  await page.getByRole("navigation", { name: "Repository sections" }).getByRole("link", { name: "Commits" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/commits`)
})

test("commit pages open however the URL spells the repository's segments", async ({ page, playwright, request, launch }) => {
  const backend = await launch.server({ ssh: true })
  const hub = await launch.hub(backend.port)
  await registerUser(backend, aliceAccount)
  const context = await signedIn(playwright, backend, hub.url, aliceAccount.name, aliceAccount.password)
  await createRepo(context, backend, { name: "parser", access: "public" })
  await context.dispose()
  await pushRepo(playwright, backend, hub.url, aliceAccount, { owner: "alice", name: "parser" }, {
    history: (git) => addCommits(git, [{ message: "Spelled commit" }]),
  })
  const id = (await (await request.get(`${hub.url}/api/v1/repos/alice/parser/commits`)).json()).items[0].id as string

  for (const path of [`/repos/%61lice/parser/commits/${id}`, `/repos/alice/parser/COMMITS/${id}`, `/repos/alice/%70arser/Commits/${id}`]) {
    await page.goto(`${hub.url}${path}`)
    await expect(page.getByRole("heading", { name: "Spelled commit" }), path).toBeVisible()
    await expect(page.getByLabel("Commit message"), path).toContainText("Spelled commit")
  }
  await page.goto(`${hub.url}/repos/%61lice/parser/COMMITS`)
  await expectSummaries(page, ["Spelled commit", "Initial commit"])
})
