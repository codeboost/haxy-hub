export type BackendStatus = {
  service: "haxy"
  api_version: 1
  mode: "local" | "server"
}

export async function getBackendStatus(signal?: AbortSignal): Promise<BackendStatus> {
  const timeout = AbortSignal.timeout(10_000)
  const response = await fetch("/api/v1/status", {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!response.ok) {
    throw new Error(`The backend returned HTTP ${response.status}. Check that the updated Zig server is running.`)
  }
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("This server does not provide the status API yet. Rebuild and restart Haxy.")
  }
  const data: unknown = await response.json()
  if (
    typeof data !== "object" || data === null ||
    !("service" in data) || data.service !== "haxy" ||
    !("api_version" in data) || data.api_version !== 1 ||
    !("mode" in data) || (data.mode !== "local" && data.mode !== "server")
  ) {
    throw new Error("The backend returned an unsupported status response.")
  }
  return { service: data.service, api_version: data.api_version, mode: data.mode }
}
