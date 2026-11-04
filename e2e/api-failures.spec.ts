import { chmod } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { alice, registerUser, writeHeaders } from "./support/accounts"
import type { Backend } from "./support/backend"
import { expect, test } from "./support/fixtures"

// HTTP-level robustness of the /api/ routes added with the session slice:
// cases a browser can't produce. The Expect cases talk to Haxy directly,
// because Vite's Node server answers `Expect: 100-continue` itself.

/** This client's CSRF nonce cookie and token, read from the backend itself. */
async function directToken(backend: Backend): Promise<{ cookie: string; token: string }> {
  const response = await fetch(`${backend.origin}/api/v1/session`)
  const cookie = /haxy_csrf=[0-9a-f]+/.exec(response.headers.get("set-cookie") ?? "")![0]
  const { csrf_token: token } = (await response.json()) as { csrf_token: string }
  return { cookie, token }
}

/**
 * Sends `head` on a raw connection, as a client using `Expect: 100-continue`
 * would: the body is sent only once the server says 100 Continue. Resolves
 * with everything received once a final (non-100) response is complete, or
 * rejects if none arrives in time.
 */
function exchange(port: number, head: string, body: string, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1")
    let received = ""
    let sentBody = false
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no final response within ${timeoutMs}ms; received:\n${received}`)) }, timeoutMs)
    const finish = () => { clearTimeout(timer); socket.destroy(); resolve(received) }
    socket.on("error", (error) => { clearTimeout(timer); reject(error) })
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1")
      if (!sentBody && /^HTTP\/1\.1 100 /.test(received)) {
        sentBody = true
        socket.write(body)
      }
      const final = received.replace(/^HTTP\/1\.1 100 [^\r]*\r\n\r\n/, "")
      const end = final.indexOf("\r\n\r\n")
      if (end < 0) return
      const length = Number(/content-length: (\d+)/i.exec(final.slice(0, end))?.[1] ?? 0)
      if (final.length >= end + 4 + length) finish()
    })
    socket.on("end", () => { if (received.includes("\r\n\r\n")) finish() })
    socket.write(head)
  })
}

const statusLine = (response: string) => response.replace(/^HTTP\/1\.1 100 [^\r]*\r\n\r\n/, "").split("\r\n")[0]

test("API answers to writes sent with Expect: 100-continue never stall", async ({ launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const { cookie, token } = await directToken(backend)
  const host = `127.0.0.1:${backend.port}`
  const head = (method: string, target: string, length: number) =>
    `${method} ${target} HTTP/1.1\r\nHost: ${host}\r\nCookie: ${cookie}\r\nX-Haxy-CSRF: ${token}\r\n` +
    `Content-Type: application/json\r\nContent-Length: ${length}\r\nExpect: 100-continue\r\n\r\n`

  // routes that answer without reading the body
  const body = "{}"
  expect(statusLine(await exchange(backend.port, head("DELETE", "/api/v1/session", body.length), body))).toBe("HTTP/1.1 200 OK")
  expect(statusLine(await exchange(backend.port, head("POST", "/api/v1/status", body.length), body))).toBe("HTTP/1.1 405 Method Not Allowed")
  expect(statusLine(await exchange(backend.port, head("PUT", "/api/v1/no-such-thing", body.length), body))).toBe("HTTP/1.1 404 Not Found")

  // and the login route, which reads it
  const login = JSON.stringify({ username: alice.name, password: alice.password })
  const response = await exchange(backend.port, head("POST", "/api/v1/session", login.length), login)
  expect(statusLine(response)).toBe("HTTP/1.1 200 OK")
  expect(response).toContain(`"viewer":{"name":"${alice.name}"}`)
})

test("a backend failure in an API route answers with a generic internal error envelope", async ({ request, launch }) => {
  const backend = await launch.server()
  await registerUser(backend, alice)
  const hub = await launch.hub(backend.port)
  const headers = await writeHeaders(request, hub.url)

  // the session store can't create the session file
  const sessions = path.join(backend.dataDir, "sessions")
  await chmod(sessions, 0o555)
  try {
    const response = await request.post(`${hub.url}/api/v1/session`, { data: { username: alice.name, password: alice.password }, headers })

    expect(response.status()).toBe(500)
    expect(response.headers()["content-type"]).toContain("application/json")
    expect(response.headers()["cache-control"]).toBe("no-store")
    const body = await response.json()
    expect(body).toEqual({ error: { code: "internal", message: expect.stringMatching(/\S/) } })
    // no error names or paths
    expect(body.error.message).not.toMatch(/AccessDenied|PermissionDenied|\//)
    expect(response.headers()["set-cookie"] ?? "").not.toContain("haxy_session=")
  } finally {
    await chmod(sessions, 0o755)
  }

  // the backend keeps serving, and logs the details
  const session = await request.get(`${hub.url}/api/v1/session`)
  expect(session.status()).toBe(200)
  expect(backend.output()).toMatch(/api request failed/)
})
