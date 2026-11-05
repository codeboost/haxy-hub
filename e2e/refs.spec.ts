import { writeFile } from "node:fs/promises"
import path from "node:path"
import { expect, test } from "./support/fixtures"
import type { FixtureRef } from "./support/backend"

// Browser workflows for choosing a branch or tag and viewing files at any
// ref, commit or patch revision, against real Haxy fixtures through Vite's proxy.

const latin1 = Uint8Array.from([...Buffer.from("caf"), 0xe9])
const pad = (index: number) => String(index).padStart(3, "0")

const refs: FixtureRef[] = [
  ...Array.from({ length: 120 }, (_, index): FixtureRef => ({ kind: "branch", name: `topic/${pad(index + 1)}` })),
  { kind: "branch", name: "feature/a b", files: { "docs/which.txt": "feature/a b\n" } },
  { kind: "branch", name: "naïve/ünï", files: { "docs/which.txt": "naïve/ünï\n" } },
  { kind: "branch", name: "x%41y", files: { "docs/which.txt": "x%41y\n" } },
  { kind: "branch", name: "a%2Fb", files: { "docs/which.txt": "a%2Fb\n" } },
  { kind: "branch", name: latin1, files: { "docs/which.txt": "latin-1\n" } },
  // git allows leading whitespace other than an ASCII space
  { kind: "branch", name: "\u00a0release", files: { "docs/which.txt": "nbsp\n" } },
  { kind: "tag", name: "v1.0", files: { "docs/which.txt": "v1.0\n" } },
  { kind: "tag", name: "release/2026 q4", files: { "docs/which.txt": "release\n" }, annotated: true },
]
const files = { "README.md": "# Refs fixture\n\nSee [which](docs/which.txt).\n", "docs/which.txt": "main\n" }

test("a reader searches and pages through branches, switches to tags and opens the files at a tag", async ({ page, launch }) => {
  const backend = await launch.local({ files, refs })
  const hub = await launch.hub(backend.port)
  await page.goto(`${hub.url}/repo`)

  await page.getByRole("navigation", { name: "Repository sections" }).getByRole("link", { name: "Refs" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/branches`)
  const branches = page.getByRole("list", { name: "Branches" })
  await expect(branches.getByRole("link").first()).toHaveText("a%2Fb")
  await expect(branches.getByRole("link", { name: "main", exact: true })).toBeVisible()

  // the next page, and back to the first with the browser
  await page.getByRole("navigation", { name: "Branches pages" }).getByRole("link", { name: "Next page" }).click()
  await expect(page).toHaveURL(new RegExp("/repo/branches\\?cursor="))
  await expect(branches.getByRole("link", { name: "main", exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("list", { name: "Branches" }).getByRole("link").first()).toHaveText(/^topic\//)
  await page.goBack()
  await expect(page.getByRole("list", { name: "Branches" }).getByRole("link", { name: "main", exact: true })).toBeVisible()

  // search narrows by prefix and stays in the URL
  await page.getByRole("searchbox", { name: "Search branches" }).fill("topic/11")
  await page.getByRole("button", { name: "Search" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/branches?search=topic%2F11`)
  await expect(page.getByRole("list", { name: "Branches" }).getByRole("link")).toHaveText(Array.from({ length: 10 }, (_, index) => `topic/${110 + index}`))
  await page.getByRole("searchbox", { name: "Search branches" }).fill("nothing")
  await page.getByRole("button", { name: "Search" }).click()
  await expect(page.getByRole("region", { name: "No branches match “nothing”" })).toBeVisible()

  // tags, and the files at one
  await page.getByRole("navigation", { name: "Ref kinds" }).getByRole("link", { name: "Tags" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/tags`)
  await page.getByRole("list", { name: "Tags" }).getByRole("link", { name: "release/2026 q4" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo?ref=tag:release/2026%20q4`)
  await expect(page.getByRole("region", { name: "Ref" })).toContainText("Tag release/2026 q4")
  await page.getByRole("list", { name: "Files" }).getByRole("link", { name: "docs" }).click()
  await page.getByRole("list", { name: "Files" }).getByRole("link", { name: "which.txt" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/files/docs/which.txt?ref=tag:release/2026%20q4`)
  await expect(page.getByRole("table", { name: "which.txt" })).toContainText("release")
  await page.reload()
  await expect(page.getByRole("table", { name: "which.txt" })).toContainText("release")
  await expect(page.getByRole("region", { name: "Ref" })).toContainText("Tag release/2026 q4")

  // back to the default branch from the ref bar
  await page.getByRole("region", { name: "Ref" }).getByRole("link", { name: "Default branch" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/files/docs/which.txt`)
  await expect(page.getByRole("table", { name: "which.txt" })).toContainText("main")
  await page.goBack()
  await expect(page.getByRole("table", { name: "which.txt" })).toContainText("release")
})

for (const [label, search, name, id, content] of [
  ["a slash and a space", "feature", "feature/a b", "branch:feature/a%20b", "feature/a b"],
  ["Unicode", "na", "naïve/ünï", "branch:na%C3%AFve/%C3%BCn%C3%AF", "naïve/ünï"],
  ["a literal %41", "x", "x%41y", "branch:x%2541y", "x%41y"],
  ["a literal %2F", "a", "a%2Fb", "branch:a%252Fb", "a%2Fb"],
  ["a byte that isn't UTF-8", "caf", "caf�", "branch:caf%E9", "latin-1"],
] as const) {
  test(`a branch whose name holds ${label} round-trips through the URL, refresh and back/forward`, async ({ page, launch }) => {
    const backend = await launch.local({ files, refs })
    const hub = await launch.hub(backend.port)
    await page.goto(`${hub.url}/repo/branches?search=${encodeURIComponent(search)}`)

    await page.getByRole("list", { name: "Branches" }).getByRole("link", { name, exact: true }).click()
    await expect(page).toHaveURL(`${hub.url}/repo?ref=${id}`)
    await expect(page.getByRole("region", { name: "Ref" })).toContainText(`Branch ${name}`)
    await page.getByRole("list", { name: "Files" }).getByRole("link", { name: "docs" }).click()
    await expect(page).toHaveURL(`${hub.url}/repo/files/docs?ref=${id}`)
    await page.getByRole("list", { name: "Files" }).getByRole("link", { name: "which.txt" }).click()
    await expect(page).toHaveURL(`${hub.url}/repo/files/docs/which.txt?ref=${id}`)
    const code = page.getByRole("table", { name: "which.txt" })
    await expect(code).toContainText(content)

    // a line link keeps the ref, and the view survives a refresh
    await code.getByRole("link", { name: "Line 1" }).click()
    await expect(page).toHaveURL(`${hub.url}/repo/files/docs/which.txt?ref=${id}#L1`)
    await page.reload()
    await expect(page.getByRole("table", { name: "which.txt" }).locator("tr[aria-current='location']")).toContainText(content)
    await expect(page.getByRole("region", { name: "Ref" })).toContainText(`Branch ${name}`)

    // back up through the breadcrumb, then back and forward again
    await page.getByRole("navigation", { name: "Path" }).getByRole("link", { name: "docs" }).click()
    await expect(page).toHaveURL(`${hub.url}/repo/files/docs?ref=${id}`)
    await page.goBack()
    await expect(page).toHaveURL(`${hub.url}/repo/files/docs/which.txt?ref=${id}#L1`)
    await expect(page.getByRole("table", { name: "which.txt" })).toContainText(content)
    await page.goForward()
    await expect(page).toHaveURL(`${hub.url}/repo/files/docs?ref=${id}`)
    await expect(page.getByRole("list", { name: "Files" }).getByRole("link", { name: "which.txt" })).toBeVisible()
  })
}

test("the ref search matches exactly what was typed, leading and trailing whitespace included", async ({ page, launch }) => {
  const backend = await launch.local({ files, refs })
  const hub = await launch.hub(backend.port)
  await page.goto(`${hub.url}/repo/branches`)

  const search = page.getByRole("searchbox", { name: "Search branches" })
  await search.fill("\u00a0rel")
  await page.getByRole("button", { name: "Search" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/branches?search=%C2%A0rel`)
  const links = page.getByRole("list", { name: "Branches" }).getByRole("link")
  await expect(links).toHaveCount(1)
  expect(await links.first().textContent()).toBe("\u00a0release")
  await page.reload()
  await expect(page.getByRole("searchbox", { name: "Search branches" })).toHaveValue("\u00a0rel")
  await links.first().click()
  await expect(page).toHaveURL(`${hub.url}/repo?ref=branch:%C2%A0release`)
  await page.getByRole("list", { name: "Files" }).getByRole("link", { name: "docs" }).click()
  await page.getByRole("list", { name: "Files" }).getByRole("link", { name: "which.txt" }).click()
  await expect(page.getByRole("table", { name: "which.txt" })).toContainText("nbsp")

  // a trailing space is part of the prefix, so it matches no branch here
  await page.goto(`${hub.url}/repo/branches`)
  await page.getByRole("searchbox", { name: "Search branches" }).fill("topic/1 ")
  await page.getByRole("button", { name: "Search" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/branches?search=topic%2F1+`)
  await expect(page.getByRole("region", { name: /^No branches match/ })).toBeVisible()
})

test("files view at a commit id, and an unknown ref says what's missing", async ({ page, request, launch }) => {
  const backend = await launch.local({ files, refs })
  const hub = await launch.hub(backend.port)
  const tag = await (await request.get(`${hub.url}/api/v1/repo/files?ref=tag:v1.0`)).json()

  await page.goto(`${hub.url}/repo/files/docs/which.txt?ref=commit:${tag.ref.commit}`)
  await expect(page.getByRole("region", { name: "Ref" })).toContainText(`Commit ${tag.ref.commit}`)
  await expect(page.getByRole("table", { name: "which.txt" })).toContainText("v1.0")
  await page.getByRole("navigation", { name: "Path" }).getByRole("link", { name: "repo" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo?ref=commit:${tag.ref.commit}`)
  // the README's links stay at the commit too
  await page.getByRole("region", { name: "README.md" }).getByRole("link", { name: "which" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/files/docs/which.txt?ref=commit:${tag.ref.commit}`)
  await expect(page.getByRole("table", { name: "which.txt" })).toContainText("v1.0")

  await page.goto(`${hub.url}/repo/files/docs?ref=branch:no-such-branch`)
  await expect(page.getByRole("region", { name: "Nothing here at this ref" })).toBeVisible()
  await page.getByRole("link", { name: "view this path on the default branch" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/files/docs`)
  await expect(page.getByRole("list", { name: "Files" }).getByRole("link", { name: "which.txt" })).toBeVisible()

  await page.goto(`${hub.url}/repo?ref=main`)
  await expect(page.getByRole("region", { name: "This isn't a ref Haxy knows how to read" })).toBeVisible()
})

test("a long directory at a ref pages forward and back, keeping the ref", async ({ page, launch }) => {
  const many = Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`many/f${String(index).padStart(4, "0")}.txt`, "x\n"]))
  const backend = await launch.local({ files: { "README.md": "# Pages\n" }, refs: [{ kind: "branch", name: "big/one", files: many }] })
  const hub = await launch.hub(backend.port)
  await page.goto(`${hub.url}/repo/files/many?ref=branch:big/one`)

  await page.getByRole("navigation", { name: "Files pages" }).getByRole("link", { name: "Next page" }).click()
  await expect(page).toHaveURL(new RegExp("/repo/files/many\\?ref=branch:big/one&cursor="))
  await expect(page.getByRole("list", { name: "Files" }).getByRole("link", { name: "f1000.txt" })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("list", { name: "Files" }).getByRole("link", { name: "f1000.txt" })).toBeVisible()
  await page.getByRole("navigation", { name: "Files pages" }).getByRole("link", { name: "First page" }).click()
  await expect(page).toHaveURL(`${hub.url}/repo/files/many?ref=branch:big/one`)
  await expect(page.getByRole("list", { name: "Files" }).getByRole("link", { name: "f0000.txt" })).toBeVisible()
})

test("a repository whose default branch has no commits still opens its other branches and tags", async ({ page, launch }) => {
  const backend = await launch.local({ files, refs: [{ kind: "tag", name: "v1.0", files: { "docs/which.txt": "v1.0\n" } }], head: "unborn" })
  const hub = await launch.hub(backend.port)

  await page.goto(`${hub.url}/repo`)
  await expect(page.getByRole("region", { name: "This repository is empty" })).toBeVisible()
  await page.getByRole("navigation", { name: "Repository sections" }).getByRole("link", { name: "Refs" }).click()
  await page.getByRole("list", { name: "Branches" }).getByRole("link", { name: "main", exact: true }).click()
  await expect(page).toHaveURL(`${hub.url}/repo?ref=branch:main`)
  await expect(page.getByRole("region", { name: "Ref" })).toContainText("Branch main")
  await expect(page.getByRole("region", { name: "This repository is empty" })).toHaveCount(0)
  await page.getByRole("list", { name: "Files" }).getByRole("link", { name: "docs" }).click()
  await page.getByRole("list", { name: "Files" }).getByRole("link", { name: "which.txt" }).click()
  await expect(page.getByRole("table", { name: "which.txt" })).toContainText("main")
  await page.reload()
  await expect(page.getByRole("table", { name: "which.txt" })).toContainText("main")

  await page.goto(`${hub.url}/repo/tags`)
  await page.getByRole("list", { name: "Tags" }).getByRole("link", { name: "v1.0" }).click()
  await expect(page.getByRole("region", { name: "Ref" })).toContainText("Tag v1.0")
})

test.describe("with the demo data", () => {
  test.skip(!process.env.HAXY_E2E_DEMO_BIN, "HAXY_BIN was given without HAXY_TRY_BIN")

  test("a server repository's tags page through and open at a tag; a private repository's refs stay hidden", async ({ page, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)
    await page.goto(`${hub.url}/repos/bobby/linux`)
    await expect(page.getByRole("region", { name: "Ref" })).toContainText("Branch master")
    await page.getByRole("region", { name: "Ref" }).getByRole("link", { name: "Branches and tags" }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/bobby/linux/branches`)
    await expect(page.getByRole("list", { name: "Branches" }).getByRole("link", { name: "feature", exact: true })).toBeVisible()

    await page.getByRole("navigation", { name: "Ref kinds" }).getByRole("link", { name: "Tags" }).click()
    const tags = page.getByRole("list", { name: "Tags" })
    await expect(tags.getByRole("link").first()).toHaveText("v1")
    await page.getByRole("navigation", { name: "Tags pages" }).getByRole("link", { name: "Next page" }).click()
    await expect(page).toHaveURL(new RegExp("/repos/bobby/linux/tags\\?cursor="))
    await expect(tags.getByRole("link").first()).not.toHaveText("v1")
    const tag = (await tags.getByRole("link").first().textContent()) ?? ""
    expect(tag).toMatch(/^v\d+$/)
    await tags.getByRole("link").first().click()
    await expect(page).toHaveURL(`${hub.url}/repos/bobby/linux?ref=tag:${tag}`)
    await expect(page.getByRole("region", { name: "Ref" })).toContainText(`Tag ${tag}`)
    await expect(page.getByRole("list", { name: "Files" }).getByRole("link", { name: "README.md" })).toBeVisible()

    await page.goto(`${hub.url}/repos/bobby/neovim/branches`)
    await expect(page.getByRole("heading", { level: 1, name: "Repository not found" })).toBeVisible()
    await page.goto(`${hub.url}/repos/bobby/neovim?ref=branch:master`)
    await expect(page.getByRole("heading", { level: 1, name: "Repository not found" })).toBeVisible()
  })

  test("Haxy's repository, files and refs links lead to the matching Haxy Hub routes", async ({ page, launch }) => {
    const backend = await launch.demo()
    const oid = "0123456789abcdef0123456789abcdef01234567"
    await writeFile(path.join(backend.dataDir, "admin", "ABOUT.md"), [
      "# Links",
      "",
      "[linux](/bobby:linux) [readme at v1](/bobby:linux/files/tag:v1/line:2/path:README.md) [feature docs](/bobby:linux/files/branch:feature/path:docs)",
      "[slashed](/bobby:linux/files/branch:a%2Fb%20c/path:src/caf%C3%A9) [at commit](/bobby:linux/files/object:" + oid + ") [revision](/bobby:linux/files/patchrev:00ff/path:x.txt)",
      "[tags](/bobby:linux/refs/tag:v3/search:v) [refs](/bobby:linux/refs) [finder](/bobby:linux/files/find:main) [commits](/bobby:linux/commits)",
    ].join("\n"))
    const hub = await launch.hub(backend.port)
    await page.goto(`${hub.url}/about`)

    const main = page.getByRole("main")
    const expected: Array<[string, string]> = [
      ["linux", "/repos/bobby/linux"],
      ["readme at v1", "/repos/bobby/linux/files/README.md?ref=tag:v1&line=2"],
      ["feature docs", "/repos/bobby/linux/files/docs?ref=branch:feature"],
      ["slashed", "/repos/bobby/linux/files/src/caf%C3%A9?ref=branch:a/b%20c"],
      ["at commit", `/repos/bobby/linux?ref=commit:${oid}`],
      ["revision", "/repos/bobby/linux/files/x.txt?ref=revision:00ff"],
      ["tags", "/repos/bobby/linux/tags?search=v"],
      ["refs", "/repos/bobby/linux/branches"],
      ["finder", "/repos/bobby/linux/find?search=main"],
      ["commits", "/repos/bobby/linux/commits"],
    ]
    for (const [name, href] of expected) await expect(main.getByRole("link", { name, exact: true }), name).toHaveAttribute("href", href)

    await main.getByRole("link", { name: "readme at v1" }).click()
    await expect(page).toHaveURL(`${hub.url}/repos/bobby/linux/files/README.md?ref=tag:v1&line=2`)
    await expect(page.getByRole("region", { name: "Ref" })).toContainText("Tag v1")
    await expect(page.getByRole("status", { name: "Partial content" })).toContainText("Showing lines 2–")
  })
})
