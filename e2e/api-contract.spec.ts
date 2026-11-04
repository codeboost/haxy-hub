import { expect, test } from "./support/fixtures"

// HTTP contract checks through the same Vite proxy the browser uses. They
// cover failures the UI has no screen for yet; see docs/api-conventions.md.

test("unknown API paths answer with a not_found error envelope", async ({ request, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)

  const response = await request.get(`${hub.url}/api/v1/no-such-thing`)

  expect(response.status()).toBe(404)
  expect(response.headers()["content-type"]).toContain("application/json")
  const body = await response.json()
  expect(body).toEqual({ error: { code: "not_found", message: expect.any(String) } })
  expect(body.error.message).not.toBe("")
})

test("the status route rejects other methods with an unsupported error and an Allow header", async ({ request, launch }) => {
  const backend = await launch.local()
  const hub = await launch.hub(backend.port)

  const response = await request.post(`${hub.url}/api/v1/status`, { data: {} })

  expect(response.status()).toBe(405)
  expect(response.headers()["allow"]).toBe("GET, HEAD")
  expect(await response.json()).toEqual({ error: { code: "unsupported", message: expect.any(String) } })
})

test("the browser API client turns error envelopes into typed errors", async ({ page, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await page.goto(hub.url)

  // Load the client module the app itself uses, as served by Vite.
  const outcome = await page.evaluate(`
    import("/src/lib/api.ts").then(({ getJson, ApiError }) =>
      getJson("/api/v1/no-such-thing").then(
        () => ({ resolved: true }),
        (error) => ({ isApiError: error instanceof ApiError, code: error.code, status: error.status, message: error.message }),
      ))
  `)

  expect(outcome).toEqual({ isApiError: true, code: "not_found", status: 404, message: expect.stringMatching(/\S/) })
})

test("API paths that look like Git smart-HTTP requests still answer with the JSON API", async ({ request, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)

  const receivePack = await request.post(`${hub.url}/api/v1/admin/repo/git-receive-pack`, { data: "" })
  expect(receivePack.status()).toBe(404)
  expect(receivePack.headers()["content-type"]).toContain("application/json")
  expect(await receivePack.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } })

  const infoRefs = await request.get(`${hub.url}/api/v1/admin/repo/info/refs?service=git-upload-pack`)
  expect(infoRefs.status()).toBe(404)
  expect(await infoRefs.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } })
})

test("the browser API client keeps headers given as a Headers instance or as tuples", async ({ page, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await page.route("**/api/v1/echo-headers", (route) => route.fulfill({ json: route.request().headers() }))
  await page.goto(hub.url)

  const echoed = await page.evaluate(`
    import("/src/lib/api.ts").then(async ({ requestJson }) => ({
      fromHeaders: await requestJson("/api/v1/echo-headers", { method: "POST", body: "x", headers: new Headers({ "Content-Type": "text/plain", "X-Probe": "a" }) }),
      fromTuples: await requestJson("/api/v1/echo-headers", { method: "POST", body: "x", headers: [["Content-Type", "text/plain"], ["X-Probe", "b"]] }),
      overridden: await requestJson("/api/v1/echo-headers", { headers: { Accept: "text/plain, application/json" } }),
    }))
  `) as Record<string, Record<string, string>>

  expect(echoed.fromHeaders).toMatchObject({ "content-type": "text/plain", "x-probe": "a", accept: "application/json" })
  expect(echoed.fromTuples).toMatchObject({ "content-type": "text/plain", "x-probe": "b", accept: "application/json" })
  expect(echoed.overridden).toMatchObject({ accept: "text/plain, application/json" })
})

test("the browser API client reads validation field errors keyed by field", async ({ page, launch }) => {
  const backend = await launch.server()
  const hub = await launch.hub(backend.port)
  await page.route("**/api/v1/validate", (route) => route.fulfill({
    status: 400,
    json: { error: { code: "validation", message: "Check the highlighted fields.", field_errors: { name: "Name is required.", email: "Email is invalid.", bogus: 7 } } },
  }))
  await page.goto(hub.url)

  const outcome = await page.evaluate(`
    import("/src/lib/api.ts").then(({ requestJson }) =>
      requestJson("/api/v1/validate", { method: "POST", body: "{}" }).catch((error) => ({
        code: error.code,
        fieldErrors: error.fieldErrors,
        name: error.fieldError("name"),
        missing: error.fieldError("password") ?? null,
        inherited: error.fieldError("toString") ?? null,
      })))
  `)

  expect(outcome).toEqual({
    code: "validation",
    fieldErrors: { name: "Name is required.", email: "Email is invalid." },
    name: "Name is required.",
    missing: null,
    inherited: null,
  })
})
