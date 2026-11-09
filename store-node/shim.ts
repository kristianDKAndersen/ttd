// Dev shim (plan D5): lets the UI run in a plain browser without the Tauri shell.
//   GET  /api/doc     -> read envelope
//   POST /api/op      -> apply envelope for the op in the JSON body
//   GET  /api/events  -> SSE, named event `doc`, data = read envelope, on every change (store-node/watch.ts)
//   GET  /*           -> files from app/dist (TTD_SHIM_DIST overrides)
// Binds 127.0.0.1 only. A browser request must carry a loopback Host, and an Origin (when sent) must equal
// `http://<Host>`; that blocks cross-site POSTs and DNS rebinding. Clients that send no Origin (curl, tests) pass.
import { stat } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { createStore, resolveHomeDir } from "../plugin/hooks/store/index.ts"
import type { Op, ReadResult, ApplyResult, StoreOptions } from "../plugin/hooks/store/index.ts"
import { createNodeIO } from "./node-io.ts"
import { watchStore } from "./watch.ts"

type Env = Record<string, string | undefined>

export interface ShimOptions {
  homeDir: string
  distDir: string
  port: number // 0 = any free port
  host?: string // default 127.0.0.1; only tests/loopback aliases should change it
  storeOptions?: StoreOptions
  pollMs?: number
  keepAliveMs?: number
}

export interface Shim {
  url: string
  port: number
  stop(): Promise<void>
}

const MAX_BODY = 1024 * 1024
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"])
const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" }

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...NO_STORE, ...extra } })
const fail = (status: number, error: string, message: string, extra?: Record<string, string>) => json(status, { ok: false, error, message }, extra)

function statusFor(r: ReadResult | ApplyResult): number {
  if (r.ok) return 200
  if (r.error === "io_error") return 500
  if (r.error === "lock_timeout" || r.error === "conflict_exhausted") return 503
  return 422
}

// Refuses a body over MAX_BODY without buffering all of it.
async function readBody(req: Request): Promise<string | "too_large"> {
  const declared = Number(req.headers.get("content-length") ?? "0")
  if (declared > MAX_BODY) return "too_large"
  if (!req.body) return ""
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const r = await reader.read()
    if (r.done) break
    size += r.value.byteLength
    if (size > MAX_BODY) {
      void reader.cancel()
      return "too_large"
    }
    chunks.push(r.value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

function hostAllowed(host: string | null): boolean {
  if (!host) return false
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!
  return LOOPBACK.has(name.toLowerCase())
}

async function serveStatic(distDir: string, pathname: string): Promise<Response> {
  let rel: string
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    return fail(400, "invalid_op", "bad path encoding")
  }
  if (rel.includes("\0") || rel.includes("\\")) return fail(400, "invalid_op", "bad path")
  if (rel.endsWith("/")) rel += "index.html"
  const root = resolve(distDir)
  const file = resolve(root, "." + rel)
  if (file !== root && !file.startsWith(root + sep)) return fail(403, "forbidden", "outside the app directory")
  try {
    if (!(await stat(file)).isFile()) return fail(404, "not_found", "not found")
  } catch {
    return fail(404, "not_found", "not found")
  }
  const f = Bun.file(file)
  return new Response(f, { headers: { "content-type": f.type, ...NO_STORE } })
}

export function startShim(o: ShimOptions): Shim {
  const io = createNodeIO()
  const store = createStore(io, o.homeDir, o.storeOptions)
  const enc = new TextEncoder()
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  let lastFrame: Uint8Array | null = null
  let eventSeq = 0

  const frame = (r: ReadResult) => enc.encode(`event: doc\ndata: ${JSON.stringify(r)}\n\n`)
  const watcher = watchStore({
    homeDir: o.homeDir,
    io,
    intervalMs: o.pollMs,
    onEvent: (e) => {
      lastFrame = frame(e.result)
      eventSeq++
      for (const c of clients) {
        try {
          c.enqueue(lastFrame)
        } catch {
          clients.delete(c)
        }
      }
    },
  })
  const keepAlive = setInterval(() => {
    for (const c of clients) {
      try {
        c.enqueue(enc.encode(": keep-alive\n\n"))
      } catch {
        clients.delete(c)
      }
    }
  }, o.keepAliveMs ?? 10_000)

  // First frame is a fresh read (the watcher's last event can be one poll interval stale); if the watcher
  // published while that read ran, its newer frame follows.
  async function events(): Promise<Response> {
    const seenSeq = eventSeq
    const first = frame(await store.read())
    let self: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        self = c
        clients.add(c)
        c.enqueue(enc.encode("retry: 1000\n\n"))
        c.enqueue(first)
        if (eventSeq !== seenSeq && lastFrame) c.enqueue(lastFrame)
      },
      cancel() {
        clients.delete(self)
      },
    })
    return new Response(body, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-content-type-options": "nosniff" },
    })
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const host = req.headers.get("host")
    if (!hostAllowed(host)) return fail(403, "forbidden", "Host must be a loopback address")
    const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/")
    const origin = req.headers.get("origin")
    if (isApi && origin !== null && origin !== `http://${host}`) return fail(403, "forbidden", "Origin must equal Host")

    if (url.pathname === "/api/doc") {
      if (req.method !== "GET") return fail(405, "invalid_op", "use GET", { allow: "GET" })
      const r = await store.read()
      return json(statusFor(r), r)
    }
    if (url.pathname === "/api/events") {
      if (req.method !== "GET") return fail(405, "invalid_op", "use GET", { allow: "GET" })
      return events()
    }
    if (url.pathname === "/api/op") {
      if (req.method !== "POST") return fail(405, "invalid_op", "use POST", { allow: "POST" })
      const text = await readBody(req)
      if (text === "too_large") return fail(413, "too_long", `request body over ${MAX_BODY} bytes`)
      let op: unknown
      try {
        op = JSON.parse(text)
      } catch (e) {
        return fail(400, "invalid_op", `body is not valid JSON: ${(e as Error).message}`)
      }
      const r = await store.apply(op as Op)
      return json(statusFor(r), r)
    }
    if (isApi) return fail(404, "not_found", "unknown API path")
    if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "invalid_op", "use GET", { allow: "GET, HEAD" })
    return serveStatic(o.distDir, url.pathname)
  }

  const server = Bun.serve({
    hostname: o.host ?? "127.0.0.1",
    port: o.port,
    idleTimeout: 0, // SSE connections are long-lived
    fetch: (req) =>
      handle(req).catch((e: unknown) => fail(500, "io_error", e instanceof Error ? e.message : String(e))),
  })
  const port = server.port as number
  return {
    url: `http://${o.host ?? "127.0.0.1"}:${port}/`,
    port,
    async stop() {
      clearInterval(keepAlive)
      watcher.stop()
      for (const c of clients) {
        try {
          c.close()
        } catch {
          /* already closed */
        }
      }
      clients.clear()
      await server.stop(true)
    },
  }
}

function posInt(v: string | undefined): number | undefined {
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw new Error(`needs a non-negative integer, got ${JSON.stringify(v)}`)
  return n
}

export function main(env: Env, out: (l: string) => void, err: (l: string) => void): number {
  const homeDir = resolveHomeDir({ TTD_HOME: env.TTD_HOME, USERPROFILE: env.USERPROFILE, HOME: env.HOME })
  if (!homeDir) {
    err("cannot resolve the TTD home directory (set TTD_HOME)")
    return 2
  }
  let port: number
  const storeOptions: StoreOptions = {}
  try {
    const raw = env.TTD_SHIM_PORT
    port = raw === undefined || raw === "" ? 7878 : (posInt(raw) as number)
    if (port > 65535) throw new Error(`needs a port 0-65535, got ${JSON.stringify(raw)}`)
  } catch (e) {
    err(`TTD_SHIM_PORT ${(e as Error).message}`)
    return 2
  }
  try {
    const t = posInt(env.TTD_LOCK_TIMEOUT_MS)
    const s = posInt(env.TTD_LOCK_STALE_MS)
    if (t !== undefined) storeOptions.lockTimeoutMs = t
    if (s !== undefined) storeOptions.lockStaleMs = s
  } catch (e) {
    err(`TTD_LOCK_TIMEOUT_MS / TTD_LOCK_STALE_MS ${(e as Error).message}`)
    return 2
  }
  const distDir = resolve(env.TTD_SHIM_DIST ?? join(import.meta.dir, "..", "app", "dist"))
  let shim: Shim
  try {
    shim = startShim({ homeDir, distDir, port, storeOptions })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    err(/EADDRINUSE|in use/i.test(msg) || (e as { code?: string }).code === "EADDRINUSE" ? `port ${port} is already in use (set TTD_SHIM_PORT): ${msg}` : `cannot start the shim: ${msg}`)
    return 1
  }
  out(JSON.stringify({ listening: shim.url, home: homeDir, dist: distDir }))
  err(`TTD shim: ${shim.url}  (todos in ${homeDir}; Ctrl-C to stop)`)
  const bye = () => void shim.stop().then(() => process.exit(0))
  process.on("SIGINT", bye)
  process.on("SIGTERM", bye)
  // Exit when the spawning process dies (SIGKILL sends no signal here), so a crashed runner leaves no orphan.
  // Probe the start-time parent pid: Bun's process.ppid is cached and never changes after reparenting.
  // Skipped when already orphaned at start (ppid 1), e.g. deliberately daemonized.
  const parent = process.ppid
  if (parent > 1) {
    const poll = setInterval(() => {
      try {
        process.kill(parent, 0)
      } catch (e) {
        if ((e as { code?: string }).code !== "ESRCH") return
        clearInterval(poll)
        bye()
      }
    }, 500)
  }
  return 0
}

if (import.meta.main) {
  const code = main(process.env, (l) => process.stdout.write(l + "\n"), (l) => process.stderr.write(l + "\n"))
  if (code !== 0) process.exit(code)
}
