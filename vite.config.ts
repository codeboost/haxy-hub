import { fileURLToPath, URL } from "node:url"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig, loadEnv } from "vite"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "HAXY_")
  const target = process.env.HAXY_BACKEND_URL ?? env.HAXY_BACKEND_URL ?? "http://127.0.0.1:8080"
  const url = new URL(target)
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("HAXY_BACKEND_URL must be an HTTP(S) origin, such as http://127.0.0.1:8080")
  }
  const proxy = {
    "^/api(?:/|$)": {
      target: url.origin,
      // Preserve the browser Origin and Host for future same-origin write checks.
      changeOrigin: false,
      proxyTimeout: 10_000,
    },
  }
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy },
    preview: { host: "127.0.0.1", port: 4173, strictPort: true, proxy },
  }
})
