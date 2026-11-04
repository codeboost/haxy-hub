import { proxyFailureStatuses, readJsonBody, timeouts } from "@/lib/api"

export type BackendMode = "local" | "server"

export type BackendStatus = {
  service: "haxy"
  api_version: 1
  mode: BackendMode
}

/** The outcome of one status check, as the app shell presents it. */
export type BackendCheck =
  | { kind: "connected"; status: BackendStatus }
  /** Nothing answered: the backend is down, the address is wrong, or it timed out. */
  | { kind: "unreachable"; message: string }
  /** Something answered, but not a Haxy backend this app can use. */
  | { kind: "incompatible"; message: string }

/** Only the status check is this short; see `timeouts` for other requests. */
const statusTimeoutMs = timeouts.status

export async function checkBackend(signal?: AbortSignal): Promise<BackendCheck> {
  const timeout = AbortSignal.timeout(statusTimeoutMs)
  // A timeout or dropped connection can also strike while the body is still
  // arriving: that is unreachable, not incompatible. Cancellation propagates.
  let response: Response
  let body: unknown
  try {
    response = await fetch("/api/v1/status", {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    body = proxyFailureStatuses.has(response.status) ? undefined : await readJsonBody(response)
  } catch (error) {
    if (signal?.aborted) throw error
    return {
      kind: "unreachable",
      message: timeout.aborted
        ? `Haxy did not answer within ${statusTimeoutMs / 1000} seconds.`
        : "The Haxy Hub server could not be reached.",
    }
  }

  if (proxyFailureStatuses.has(response.status)) {
    return { kind: "unreachable", message: "Haxy Hub could not connect to the Haxy backend. Check that Haxy is running at the configured address." }
  }

  if (response.ok && isStatus(body)) return { kind: "connected", status: body }
  return { kind: "incompatible", message: incompatibility(response.status, body) }
}

function incompatibility(httpStatus: number, body: unknown): string {
  if (typeof body !== "object" || body === null) {
    return `This server does not provide the Haxy status API (HTTP ${httpStatus}). It may be an older Haxy or a different service; update and restart Haxy.`
  }
  if (!("service" in body) || body.service !== "haxy") {
    return "The backend answered, but it is not a Haxy server."
  }
  if ("api_version" in body && body.api_version !== 1) {
    return `The backend speaks Haxy API version ${String(body.api_version)}; this Haxy Hub needs API version 1.`
  }
  return `The backend returned an unsupported status response (HTTP ${httpStatus}).`
}

function isStatus(body: unknown): body is BackendStatus {
  return typeof body === "object" && body !== null &&
    "service" in body && body.service === "haxy" &&
    "api_version" in body && body.api_version === 1 &&
    "mode" in body && (body.mode === "local" || body.mode === "server")
}
