import { fileURLToPath, URL } from "node:url"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig, loadEnv, type Connect, type Plugin } from "vite"

/**
 * Repository paths in app URLs are percent-encoded bytes and may not be UTF-8
 * (docs/api-conventions.md, Repository paths), e.g. `/repo/files/caf%E9.txt`.
 * Vite's own index.html fallback decodes the URL first and answers 404 when
 * it can't, so such a page would not survive a refresh. Serve the app for
 * them instead; the client reads the raw pathname itself.
 */
function undecodableAppPaths(): Plugin {
  // whether the URL's escapes decode to UTF-8, as Vite's decodeURI needs
  const decodable = (path: string): boolean => {
    const bytes = Buffer.from(path.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))), "latin1")
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      return true
    } catch {
      return false
    }
  }
  const fallback: Connect.NextHandleFunction = (request, _response, next) => {
    const path = (request.url ?? "/").split(/[?#]/, 1)[0]
    if ((request.method === "GET" || request.method === "HEAD") && !/^\/api(?:\/|$)/.test(path) && !decodable(path)) request.url = "/index.html"
    next()
  }
  return {
    name: "haxy-undecodable-app-paths",
    configureServer: (server) => { server.middlewares.use(fallback) },
    configurePreviewServer: (server) => { server.middlewares.use(fallback) },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "HAXY_")
  const target = process.env.HAXY_BACKEND_URL ?? env.HAXY_BACKEND_URL ?? "http://127.0.0.1:8080"
  const url = new URL(target)
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("HAXY_BACKEND_URL must be an HTTP(S) origin, such as http://127.0.0.1:8080")
  }
  // Preserve the browser Origin and Host for the backend's same-origin write checks.
  const backend = { target: url.origin, changeOrigin: false }
  // Vite uses the first entry that matches, so routes listed before the
  // catch-all get their own timeout (docs/api-conventions.md, Timeouts).
  const proxy = {
    // Creating a repository may copy a large one. Like every write it has no
    // client timeout, so the proxy waits for Haxy's answer too.
    "^/api/v1/repos(?:\\?|$)": backend,
    "^/api(?:/|$)": { ...backend, proxyTimeout: 10_000 },
  }
  return {
    plugins: [undecodableAppPaths(), react(), tailwindcss()],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    // No CORS: Vite's default would answer preflights for any localhost
    // origin itself. Haxy Hub is same-origin only, and Zig checks the Origin
    // and CSRF token of every write (docs/api-conventions.md, Security notes).
    server: { host: "127.0.0.1", port: 5173, strictPort: true, cors: false, proxy },
    preview: { host: "127.0.0.1", port: 4173, strictPort: true, cors: false, proxy },
  }
})
