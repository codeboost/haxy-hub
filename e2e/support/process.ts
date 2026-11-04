import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import net from "node:net"
import { setTimeout as delay } from "node:timers/promises"

/** Asks the OS for a currently free TCP port on 127.0.0.1. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))))
    })
  })
}

export type Managed = {
  child: ChildProcess
  /** Recent combined stdout/stderr, for failure messages. */
  output(): string
  /** Resolves with the first match of `pattern` in the output. */
  waitForOutput(pattern: RegExp, timeoutMs: number): Promise<RegExpMatchArray>
  stop(): Promise<void>
}

/** Every process started in this worker that has not exited yet. */
const live = new Set<Managed>()

/**
 * Stops every process this worker started that is still running, including
 * ones whose startup is still being awaited. Fixture teardown calls this so a
 * test that times out mid-startup cannot leak a backend or Vite process.
 */
export async function stopAllProcesses(): Promise<void> {
  await Promise.all([...live].map((managed) => managed.stop()))
}

export function startProcess(name: string, command: string, args: string[], options: SpawnOptions): Managed {
  const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] })
  let log = ""
  const listeners = new Set<() => void>()
  const append = (chunk: Buffer) => {
    log = (log + chunk.toString("utf8")).slice(-20_000)
    for (const listener of listeners) listener()
  }
  child.stdout?.on("data", append)
  child.stderr?.on("data", append)
  let exited = false
  // A failed spawn emits "error" and may never emit "exit", so either one
  // settles the lifecycle; otherwise readiness waits and stop() would hang.
  const exit = new Promise<void>((resolve) => {
    const settle = () => { exited = true; live.delete(managed); resolve() }
    child.once("exit", settle)
    child.once("error", (error) => {
      log += `\n[${name}] failed to start: ${error.message}`
      if (child.pid === undefined) settle()
    })
  })

  const managed: Managed = {
    child,
    output: () => log,
    waitForOutput(pattern, timeoutMs) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const match = log.match(pattern)
          if (match) { done(); resolve(match) } else if (exited) { done(); reject(new Error(`${name} exited before printing ${pattern}:\n${log}`)) }
        }
        const timer = setTimeout(() => { done(); reject(new Error(`${name} did not print ${pattern} within ${timeoutMs}ms:\n${log}`)) }, timeoutMs)
        const done = () => { clearTimeout(timer); listeners.delete(check) }
        listeners.add(check)
        void exit.then(check)
        check()
      })
    },
    async stop() {
      if (exited) return
      child.kill("SIGTERM")
      const killed = await Promise.race([exit.then(() => true), delay(5_000).then(() => false)])
      if (!killed) {
        child.kill("SIGKILL")
        await exit
      }
    },
  }
  live.add(managed)
  if (exited) live.delete(managed)
  return managed
}

/** Polls `check` until it returns a value, failing with `describe()` after `timeoutMs`. */
export async function waitUntil<T>(check: () => Promise<T | undefined>, timeoutMs: number, describe: () => string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check().catch(() => undefined)
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(describe())
    await delay(100)
  }
}
