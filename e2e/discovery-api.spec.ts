import { writeHeaders } from "./support/accounts"
import { expect, test } from "./support/fixtures"

// HTTP contract checks for the discovery routes, through the same Vite proxy
// the browser uses. They cover what a browser can't show directly: exact
// shapes, hidden resources and the absence of leaks.

test("about returns the admin repo's about page, parsed as the TUI parses it", async ({ request, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)

  const response = await request.get(`${hub.url}/api/v1/about`)

  expect(response.status()).toBe(200)
  expect(response.headers()["cache-control"]).toBe("no-store")
  const body = await response.json()
  // a fresh server's ABOUT.md starts with "# HAXY", which the TUI shows as its title
  expect(body.title).toBe("HAXY")
  expect(body.blocks[0]).toEqual({
    kind: "paragraph",
    center: false,
    pre: false,
    inlines: [{ text: "Welcome to your Haxy instance!", bold: false, italic: false, strike: false, code: false, link: null }],
  })
  expect(body.blocks[1].inlines.map((inline: { text: string; code: boolean }) => [inline.text, inline.code])).toEqual([
    ["Edit ", false],
    ["admin/ABOUT.md", true],
    [" in the server dir to change what this page says.", false],
  ])
})

const demoUsers = [
  "admin", "alice", "bobby", "carol", "david", "evelyn", "frank", "grace", "henry", "irene", "jacob",
  "katie", "logan", "molly", "nolan", "olivia", "peter", "quinn", "rachel", "simon", "tessa",
]

test.describe("with the demo data", () => {
  test.skip(!process.env.HAXY_E2E_DEMO_BIN, "HAXY_BIN was given without HAXY_TRY_BIN")

  test("the user directory pages through users by name with an opaque cursor", async ({ request, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)

    const first = await request.get(`${hub.url}/api/v1/users`)
    expect(first.status()).toBe(200)
    const firstBody = await first.json()
    // the TUI's window size, by name
    expect(firstBody.items).toEqual(demoUsers.slice(0, 20).map((name) => ({ name })))
    expect(firstBody.page).toEqual({ has_more: true, next_cursor: expect.any(String), count: { kind: "unknown" } })

    const second = await (await request.get(`${hub.url}/api/v1/users?cursor=${encodeURIComponent(firstBody.page.next_cursor)}`)).json()
    expect(second).toEqual({ items: [{ name: "tessa" }], page: { has_more: false, next_cursor: null, count: { kind: "unknown" } } })

    const small = await (await request.get(`${hub.url}/api/v1/users?page_size=2`)).json()
    expect(small.items).toEqual([{ name: "admin" }, { name: "alice" }])
    expect(small.page.has_more).toBe(true)
  })

  test("the user directory search narrows to names starting with the term", async ({ request, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)

    expect(await (await request.get(`${hub.url}/api/v1/users?search=a`)).json()).toEqual({
      items: [{ name: "admin" }, { name: "alice" }],
      page: { has_more: false, next_cursor: null, count: { kind: "unknown" } },
    })
    const paged = await (await request.get(`${hub.url}/api/v1/users?search=a&page_size=1`)).json()
    expect(paged.items).toEqual([{ name: "admin" }])
    const rest = await (await request.get(`${hub.url}/api/v1/users?search=a&page_size=1&cursor=${encodeURIComponent(paged.page.next_cursor)}`)).json()
    expect(rest.items).toEqual([{ name: "alice" }])
    expect((await (await request.get(`${hub.url}/api/v1/users?search=zz`)).json()).items).toEqual([])
  })

  test("a user is found by name; an unknown name is not found", async ({ request, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)

    const bobby = await request.get(`${hub.url}/api/v1/users/bobby`)
    expect(bobby.status()).toBe(200)
    expect(await bobby.json()).toEqual({ name: "bobby" })

    for (const path of ["users/nobody", "users/nobody/repos"]) {
      const missing = await request.get(`${hub.url}/api/v1/${path}`)
      expect(missing.status(), path).toBe(404)
      expect(await missing.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } })
    }
  })

  test("an anonymous viewer gets only an owner's public repositories, with no trace of private ones", async ({ request, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)

    // bobby owns linux and scikit-learn (public) and neovim (private)
    const response = await request.get(`${hub.url}/api/v1/users/bobby/repos`)
    expect(response.status()).toBe(200)
    const body = await response.json()
    expect([...body.items].sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))).toEqual([
      { name: "linux", description: "Linux kernel source tree", access: "public" },
      { name: "scikit-learn", description: "Machine learning in Python", access: "public" },
    ])
    expect(body.page).toEqual({ has_more: false, next_cursor: null, count: { kind: "unknown" } })
    expect(JSON.stringify(body)).not.toContain("neovim")

    // searching by the private repo's name finds nothing, exactly like a name that doesn't exist
    const searched = await (await request.get(`${hub.url}/api/v1/users/bobby/repos?search=neo`)).json()
    const nonexistent = await (await request.get(`${hub.url}/api/v1/users/bobby/repos?search=xyz`)).json()
    expect(searched).toEqual({ items: [], page: { has_more: false, next_cursor: null, count: { kind: "unknown" } } })
    expect(searched).toEqual(nonexistent)
    expect((await (await request.get(`${hub.url}/api/v1/users/bobby/repos?search=lin`)).json()).items).toEqual([
      { name: "linux", description: "Linux kernel source tree", access: "public" },
    ])

    // admin's dotfiles is private too
    const admin = await (await request.get(`${hub.url}/api/v1/users/admin/repos`)).json()
    expect(admin.items.map((repo: { name: string }) => repo.name)).toEqual(["toolbox"])
  })

  test("repository pages count readable repositories only, so hidden ones can't be inferred from paging", async ({ request, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)

    // Follows every page from `path`, recording what a client can observe of each.
    const walk = async (path: string) => {
      const pages: Array<{ names: string[]; has_more: boolean }> = []
      let cursor: string | null = null
      do {
        const separator = path.includes("?") ? "&" : "?"
        const url: string = cursor ? `${hub.url}${path}${separator}cursor=${encodeURIComponent(cursor)}` : `${hub.url}${path}`
        const body = await (await request.get(url)).json()
        pages.push({ names: body.items.map((repo: { name: string }) => repo.name), has_more: body.page.has_more })
        cursor = body.page.next_cursor
      } while (cursor)
      return pages
    }
    const shape = (pages: Array<{ names: string[]; has_more: boolean }>) => pages.map((page) => [page.names.length, page.has_more])

    // bobby: linux and scikit-learn are public, neovim (between them) is private.
    // Two readable repos page exactly like a user who only has two repos.
    const bobby = await walk("/api/v1/users/bobby/repos?page_size=1")
    expect(shape(bobby)).toEqual([[1, true], [1, false]])
    expect(bobby.flatMap((page) => page.names).sort()).toEqual(["linux", "scikit-learn"])
    expect(shape(await walk("/api/v1/users/bobby/repos?page_size=2"))).toEqual([[2, false]])
    expect(shape(await walk("/api/v1/users/bobby/repos"))).toEqual([[2, false]])

    // admin has public toolbox and private dotfiles; katie has only public svelte
    const admin = await walk("/api/v1/users/admin/repos?page_size=1")
    expect(shape(admin)).toEqual(shape(await walk("/api/v1/users/katie/repos?page_size=1")))
    expect(shape(admin)).toEqual([[1, false]])

    // a search matching only a private repo pages like one matching nothing
    expect(await walk("/api/v1/users/admin/repos?search=d&page_size=1")).toEqual(await walk("/api/v1/users/admin/repos?search=q&page_size=1"))
  })

  test("a signed-in owner also gets their private repositories, an unrelated user does not", async ({ playwright, launch }) => {
    const backend = await launch.demo()
    const hub = await launch.hub(backend.port)

    // Sign in through Haxy's existing login form with the demo's seeded password
    // (until Haxy Hub has its own login, #03). Cookies ignore ports, so the
    // session cookie the backend sets also reaches it through the hub's proxy.
    const signedIn = async (username: string) => {
      const context = await playwright.request.newContext({ baseURL: hub.url })
      const login = await context.post(`${backend.origin}/login`, { form: { username, password: "password" }, maxRedirects: 0 })
      expect(login.status()).toBe(303)
      return context
    }

    const owner = await signedIn("bobby")
    const ownerRepos = await (await owner.get("/api/v1/users/bobby/repos")).json()
    expect(ownerRepos.items).toContainEqual({ name: "neovim", description: "Hyperextensible Vim-based text editor", access: "private" })
    expect((await (await owner.get("/api/v1/users/bobby/repos?search=neo")).json()).items).toHaveLength(1)
    const ownerPage = await (await owner.get("/api/v1/users/bobby/repos?page_size=2")).json()
    expect(ownerPage.items).toHaveLength(2)
    expect(ownerPage.page.has_more).toBe(true)

    const unrelated = await signedIn("alice")
    const unrelatedRepos = await (await unrelated.get("/api/v1/users/bobby/repos")).json()
    expect(JSON.stringify(unrelatedRepos)).not.toContain("neovim")

    await owner.dispose()
    await unrelated.dispose()
  })
})

test("paging parameters the backend can't use are validation errors keyed by parameter", async ({ request, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)

  for (const [query, field] of [["page_size=0", "page_size"], ["page_size=ten", "page_size"], ["cursor=not-a-cursor", "cursor"]]) {
    const response = await request.get(`${hub.url}/api/v1/users?${query}`)
    expect(response.status(), query).toBe(400)
    expect(await response.json()).toEqual({ error: { code: "validation", message: expect.any(String), field_errors: { [field]: expect.any(String) } } })
  }
})

test("an empty server has an empty user directory", async ({ request, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)

  expect(await (await request.get(`${hub.url}/api/v1/users`)).json()).toEqual({
    items: [],
    page: { has_more: false, next_cursor: null, count: { kind: "unknown" } },
  })
})

test("local mode reports the discovery routes as unsupported, not empty", async ({ request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)

  for (const path of ["about", "users", "users/alice", "users/alice/repos"]) {
    const response = await request.get(`${hub.url}/api/v1/${path}`)
    expect(response.status(), path).toBe(405)
    expect(await response.json()).toEqual({ error: { code: "unsupported", message: expect.stringContaining("local mode") } })
  }
})

test("the discovery routes only read", async ({ request, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)

  // A write with a valid CSRF token passes the guard and reaches the route.
  const response = await request.post(`${hub.url}/api/v1/users`, { data: {}, headers: await writeHeaders(request, hub.url) })
  expect(response.status()).toBe(405)
  expect(response.headers()["allow"]).toBe("GET, HEAD")
  expect(await response.json()).toEqual({ error: { code: "unsupported", message: expect.any(String) } })
})
