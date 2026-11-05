// D5 dev shim: a real `bun store-node/shim.ts` process per test, a fresh temp TTD_HOME, a random free port
// (TTD_SHIM_PORT=0; the shim prints one JSON line `{"listening":url,"home":dir,"dist":dir}` once it is bound).
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { networkInterfaces, tmpdir } from "node:os"
import { connect } from "node:net"
import { join } from "node:path"

const SHIM = join(import.meta.dir, "../shim.ts")
const CLI = join(import.meta.dir, "../cli.ts")
const REAL_DIST = join(import.meta.dir, "../../app/dist")

const tmps: string[] = []
const procs: Array<ReturnType<typeof Bun.spawn>> = []
afterEach(() => {
  for (const p of procs.splice(0)) p.kill()
})
afterAll(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true })
})
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmps.push(d)
  return d
}

interface Shim {
  url: string
  host: string // 127.0.0.1:port
  port: number
  home: string
  dist: string
  proc: ReturnType<typeof Bun.spawn>
}

async function firstLine(stream: ReadableStream<Uint8Array>, ms: number): Promise<string> {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let buf = ""
  const deadline = Date.now() + ms
  while (!buf.includes("\n")) {
    const left = deadline - Date.now()
    if (left <= 0) throw new Error(`shim printed no line within ${ms}ms; got ${JSON.stringify(buf)}`)
    const r = await Promise.race([reader.read(), new Promise<null>((res) => setTimeout(() => res(null), left))])
    if (r === null) continue
    if (r.done) throw new Error(`shim stdout closed; got ${JSON.stringify(buf)}`)
    buf += dec.decode(r.value)
  }
  reader.releaseLock()
  return buf.slice(0, buf.indexOf("\n"))
}

async function startShim(opts: { home?: string; dist?: string; env?: Record<string, string> } = {}): Promise<Shim> {
  const home = opts.home ?? tmp("ttd-shim-home-")
  const env: Record<string, string> = { ...(process.env as Record<string, string>), TTD_HOME: home, TTD_SHIM_PORT: "0", ...opts.env }
  if (opts.dist) env.TTD_SHIM_DIST = opts.dist
  const proc = Bun.spawn(["bun", SHIM], { env, stdout: "pipe", stderr: "pipe" })
  procs.push(proc)
  const info = JSON.parse(await firstLine(proc.stdout as ReadableStream<Uint8Array>, 10_000)) as { listening: string; home: string; dist: string }
  const u = new URL(info.listening)
  return { url: info.listening, host: u.host, port: Number(u.port), home: info.home, dist: info.dist, proc }
}

async function cliApply(home: string, op: unknown) {
  const p = Bun.spawn(["bun", CLI, "apply", JSON.stringify(op)], { env: { ...(process.env as Record<string, string>), TTD_HOME: home }, stdout: "pipe", stderr: "pipe" })
  const out = await new Response(p.stdout as ReadableStream).text()
  await p.exited
  return JSON.parse(out)
}

const post = (s: Shim, body: string, headers: Record<string, string> = {}) =>
  fetch(s.url + "api/op", { method: "POST", headers: { "content-type": "application/json", ...headers }, body })
const todosJson = (home: string) => JSON.parse(readFileSync(join(home, "todos.json"), "utf8"))

// Raw HTTP so the request line (`..` segments) and the Host header go out exactly as written.
// Resolves once Content-Length bytes of body have arrived (or the socket ends).
function raw(port: number, request: string): Promise<{ status: number; head: string; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1")
    let data = Buffer.alloc(0)
    let done = false
    const finish = () => {
      if (done) return
      done = true
      sock.destroy()
      const text = data.toString("utf8")
      const i = text.indexOf("\r\n\r\n")
      const head = i < 0 ? text : text.slice(0, i)
      resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0), head, body: i < 0 ? "" : text.slice(i + 4) })
    }
    sock.on("connect", () => sock.write(request))
    sock.on("data", (c: Buffer) => {
      data = Buffer.concat([data, c])
      const i = data.indexOf("\r\n\r\n")
      if (i < 0) return
      const cl = /content-length:\s*(\d+)/i.exec(data.subarray(0, i).toString("utf8"))
      if (cl && data.length - (i + 4) >= Number(cl[1])) finish()
    })
    sock.on("error", (e) => (done ? undefined : reject(e)))
    sock.on("end", finish)
    sock.on("close", finish)
    setTimeout(() => (done ? undefined : reject(new Error("raw request timed out"))), 4000)
  })
}

interface Frame {
  event: string
  data: string
}
// Minimal SSE client over fetch: frames are `event:`/`data:` lines ended by a blank line; `:` lines are comments.
async function openSse(url: string, init?: RequestInit) {
  const ctl = new AbortController()
  const res = await fetch(url, { ...init, signal: ctl.signal })
  const frames: Frame[] = []
  let buf = ""
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  void (async () => {
    try {
      for (;;) {
        const r = await reader.read()
        if (r.done) return
        buf += dec.decode(r.value, { stream: true })
        let i: number
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i)
          buf = buf.slice(i + 2)
          let event = "message"
          const data: string[] = []
          for (const line of block.split("\n")) {
            if (line.startsWith(":")) continue
            if (line.startsWith("event:")) event = line.slice(6).trim()
            else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
          }
          if (data.length) frames.push({ event, data: data.join("\n") })
        }
      }
    } catch {
      /* aborted */
    }
  })()
  return { res, frames, close: () => ctl.abort() }
}

async function until<T>(f: () => T | undefined | false, ms: number, what: string): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = f()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error(`timeout (${ms}ms) waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 15))
  }
}

describe("GET /api/doc and POST /api/op", () => {
  test("empty home reads as the empty document", async () => {
    const s = await startShim()
    const res = await fetch(s.url + "api/doc")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.doc).toMatchObject({ schemaVersion: 1, rev: 0, items: [] })
  })

  test("the listening line names the temp home, never the real ~/.ttd", async () => {
    const home = tmp("ttd-shim-home-")
    const s = await startShim({ home })
    expect(s.home).toBe(home)
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
  })

  test("POST add returns the apply envelope, lands on disk, and GET reflects it", async () => {
    const s = await startShim()
    const res = await post(s, JSON.stringify({ op: "add", title: "buy milk", body: "2 l" }))
    expect(res.status).toBe(200)
    const env = await res.json()
    expect(env).toMatchObject({ ok: true, changed: true, rev: 1 })
    expect(env.doc.items.map((i: { title: string }) => i.title)).toEqual(["buy milk"])
    expect(todosJson(s.home).items[0]).toMatchObject({ title: "buy milk", body: "2 l", status: "todo" })
    const read = await (await fetch(s.url + "api/doc")).json()
    expect(read.doc.rev).toBe(1)
  })

  test("a store failure is a JSON error envelope with a 4xx status (not_found)", async () => {
    const s = await startShim()
    const res = await post(s, JSON.stringify({ op: "set_status", id: "nope", status: "done" }))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ ok: false, error: "not_found" })
  })

  test("an invalid op shape is an invalid_op envelope", async () => {
    const s = await startShim()
    const res = await post(s, JSON.stringify({ op: "explode" }))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_op" })
  })

  test("bad JSON -> 400 with an invalid_op envelope, nothing written", async () => {
    const s = await startShim()
    const res = await post(s, "{not json")
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toMatchObject({ ok: false, error: "invalid_op" })
    expect(body.message).toBeString()
    await expect(Bun.file(join(s.home, "todos.json")).exists()).resolves.toBe(false)
  })

  test("an oversized body -> 413", async () => {
    const s = await startShim()
    const res = await post(s, JSON.stringify({ op: "add", title: "x", body: "y".repeat(2 * 1024 * 1024) }))
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ ok: false })
  })

  test("wrong methods -> 405 with Allow", async () => {
    const s = await startShim()
    const a = await fetch(s.url + "api/doc", { method: "POST", body: "{}" })
    expect(a.status).toBe(405)
    expect(a.headers.get("allow")).toBe("GET")
    const b = await fetch(s.url + "api/op")
    expect(b.status).toBe(405)
    expect(b.headers.get("allow")).toBe("POST")
  })

  test("unknown /api path -> 404 JSON", async () => {
    const s = await startShim()
    const res = await fetch(s.url + "api/nope")
    expect(res.status).toBe(404)
  })

  test("corrupt file: GET shows the corrupt envelope, reset_corrupt recovers", async () => {
    const home = tmp("ttd-shim-home-")
    writeFileSync(join(home, "todos.json"), "{ truncated")
    const s = await startShim({ home })
    const read = await fetch(s.url + "api/doc")
    expect(read.status).toBe(422)
    expect(await read.json()).toMatchObject({ ok: false, error: "corrupt" })
    const refused = await post(s, JSON.stringify({ op: "add", title: "x" }))
    expect(await refused.json()).toMatchObject({ ok: false, error: "corrupt_no_backup" })
    const reset = await post(s, JSON.stringify({ op: "reset_corrupt" }))
    expect(await reset.json()).toMatchObject({ ok: true })
    const after = await (await fetch(s.url + "api/doc")).json()
    expect(after).toMatchObject({ ok: true })
  })
})

describe("Origin and Host checks", () => {
  test("a foreign Origin on POST is rejected 403 and writes nothing", async () => {
    const s = await startShim()
    const res = await post(s, JSON.stringify({ op: "add", title: "evil" }), { origin: "http://evil.example" })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ ok: false })
    await expect(Bun.file(join(s.home, "todos.json")).exists()).resolves.toBe(false)
  })

  test("Origin equal to Host is accepted; no Origin (curl, tests) is accepted", async () => {
    const s = await startShim()
    const ok = await post(s, JSON.stringify({ op: "add", title: "a" }), { origin: `http://${s.host}` })
    expect(ok.status).toBe(200)
    const none = await post(s, JSON.stringify({ op: "add", title: "b" }))
    expect(none.status).toBe(200)
  })

  test("a foreign Origin on GET /api/doc and /api/events is rejected", async () => {
    const s = await startShim()
    expect((await fetch(s.url + "api/doc", { headers: { origin: "http://evil.example" } })).status).toBe(403)
    expect((await fetch(s.url + "api/events", { headers: { origin: "http://evil.example" } })).status).toBe(403)
  })

  test("a non-loopback Host header (DNS rebinding) is rejected even with a matching Origin", async () => {
    const s = await startShim()
    const body = JSON.stringify({ op: "add", title: "x" })
    const r = await raw(
      s.port,
      `POST /api/op HTTP/1.1\r\nHost: evil.example:${s.port}\r\nOrigin: http://evil.example:${s.port}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
    )
    expect(r.status).toBe(403)
    await expect(Bun.file(join(s.home, "todos.json")).exists()).resolves.toBe(false)
  })

  test("localhost:<other port> Host with the same Origin is accepted (vite dev proxy)", async () => {
    const s = await startShim()
    const body = JSON.stringify({ op: "add", title: "via proxy" })
    const r = await raw(
      s.port,
      `POST /api/op HTTP/1.1\r\nHost: localhost:5173\r\nOrigin: http://localhost:5173\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
    )
    expect(r.status).toBe(200)
  })
})

describe("binding", () => {
  test("listens on loopback only: the LAN address refuses the connection", async () => {
    const s = await startShim()
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((n) => n && n.family === "IPv4" && !n.internal)
    if (!lan) return // no external interface on this machine: nothing to probe
    await expect(fetch(`http://${lan.address}:${s.port}/api/doc`, { signal: AbortSignal.timeout(2000) })).rejects.toBeDefined()
  })

  test("a port that is already taken makes the shim exit non-zero with a message", async () => {
    const first = await startShim()
    const p = Bun.spawn(["bun", SHIM], {
      env: { ...(process.env as Record<string, string>), TTD_HOME: tmp("ttd-shim-home-"), TTD_SHIM_PORT: String(first.port) },
      stdout: "pipe",
      stderr: "pipe",
    })
    procs.push(p)
    const code = await p.exited
    expect(code).not.toBe(0)
    expect(await new Response(p.stderr as ReadableStream).text()).toMatch(/port|address|in use/i)
  })

  test("an invalid TTD_SHIM_PORT exits 2 with a message", async () => {
    const p = Bun.spawn(["bun", SHIM], {
      env: { ...(process.env as Record<string, string>), TTD_HOME: tmp("ttd-shim-home-"), TTD_SHIM_PORT: "banana" },
      stdout: "pipe",
      stderr: "pipe",
    })
    procs.push(p)
    expect(await p.exited).toBe(2)
    expect(await new Response(p.stderr as ReadableStream).text()).toContain("TTD_SHIM_PORT")
  })
})

describe("GET /api/events (SSE)", () => {
  test("sends the current state first, then an event for an external cli.ts apply", async () => {
    const s = await startShim()
    const sse = await openSse(s.url + "api/events")
    expect(sse.res.status).toBe(200)
    expect(sse.res.headers.get("content-type")).toContain("text/event-stream")
    expect(sse.res.headers.get("cache-control")).toContain("no-cache")
    const first = await until(() => sse.frames[0], 3000, "initial doc event")
    expect(first.event).toBe("doc")
    expect(JSON.parse(first.data)).toMatchObject({ ok: true, doc: { rev: 0, items: [] } })

    const env = await cliApply(s.home, { op: "add", title: "from the agent" })
    expect(env.ok).toBe(true)
    const t0 = Date.now()
    const hit = await until(
      () =>
        sse.frames.find((f) => {
          const d = JSON.parse(f.data)
          return d.ok && d.doc.rev === 1
        }),
      3000,
      "doc event for rev 1",
    )
    expect(Date.now() - t0).toBeLessThan(2500)
    expect(hit.event).toBe("doc")
    expect(JSON.parse(hit.data).doc.items[0].title).toBe("from the agent")
    sse.close()
  })

  test("a client that connects later still gets the current state at once", async () => {
    const s = await startShim()
    await cliApply(s.home, { op: "add", title: "already here" })
    const sse = await openSse(s.url + "api/events")
    const first = await until(() => sse.frames[0], 3000, "initial doc event")
    expect(JSON.parse(first.data).doc.items[0].title).toBe("already here")
    sse.close()
  })

  test("a corrupt file is published as an error envelope on the same event", async () => {
    const s = await startShim()
    const sse = await openSse(s.url + "api/events")
    await until(() => sse.frames[0], 3000, "initial doc event")
    writeFileSync(join(s.home, "todos.json"), "{ nope")
    const hit = await until(() => sse.frames.find((f) => JSON.parse(f.data).ok === false), 3000, "corrupt event")
    expect(hit.event).toBe("doc")
    expect(JSON.parse(hit.data)).toMatchObject({ ok: false, error: "corrupt" })
    sse.close()
  })

  test("a write through POST /api/op is also published", async () => {
    const s = await startShim()
    const sse = await openSse(s.url + "api/events")
    await until(() => sse.frames[0], 3000, "initial doc event")
    await post(s, JSON.stringify({ op: "add", title: "via post" }))
    await until(() => sse.frames.find((f) => JSON.parse(f.data).doc?.rev === 1), 3000, "event for rev 1")
    sse.close()
  })
})

describe("static files", () => {
  function fakeDist() {
    const base = tmp("ttd-shim-dist-")
    const dist = join(base, "dist")
    mkdirSync(join(dist, "assets"), { recursive: true })
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>fake</title><div id=app></div>")
    writeFileSync(join(dist, "assets", "app.js"), "export const x = 1")
    writeFileSync(join(dist, "assets", "app.css"), "body{}")
    writeFileSync(join(base, "ttd-shim-secret.txt"), "secret")
    return dist
  }

  test("/ serves index.html, assets get a real content-type", async () => {
    const s = await startShim({ dist: fakeDist() })
    const root = await fetch(s.url)
    expect(root.status).toBe(200)
    expect(root.headers.get("content-type")).toContain("text/html")
    expect(await root.text()).toContain("<title>fake</title>")
    const js = await fetch(s.url + "assets/app.js")
    expect(js.headers.get("content-type")).toMatch(/javascript/)
    expect(await js.text()).toBe("export const x = 1")
    expect((await fetch(s.url + "assets/app.css")).headers.get("content-type")).toContain("text/css")
    expect((await fetch(s.url + "index.html")).status).toBe(200)
  })

  test("missing file -> 404; POST to a static path -> 405", async () => {
    const s = await startShim({ dist: fakeDist() })
    expect((await fetch(s.url + "assets/missing.js")).status).toBe(404)
    expect((await fetch(s.url, { method: "POST", body: "x" })).status).toBe(405)
  })

  test("path traversal (literal and percent-encoded) never leaves the dist directory", async () => {
    const s = await startShim({ dist: fakeDist() })
    for (const p of ["/../ttd-shim-secret.txt", "/assets/../../ttd-shim-secret.txt", "/%2e%2e/ttd-shim-secret.txt", "/assets/%2e%2e%2f%2e%2e%2fttd-shim-secret.txt", "/..%5cttd-shim-secret.txt"]) {
      const r = await raw(s.port, `GET ${p} HTTP/1.1\r\nHost: ${s.host}\r\nConnection: close\r\n\r\n`)
      expect(r.body).not.toContain("secret")
      expect([400, 403, 404]).toContain(r.status)
    }
  })

  test("a missing dist directory still serves the API and 404s the page", async () => {
    const s = await startShim({ dist: join(tmp("ttd-shim-nodist-"), "absent") })
    expect((await fetch(s.url)).status).toBe(404)
    expect((await fetch(s.url + "api/doc")).status).toBe(200)
  })

  test("the default dist is the built app/dist", async () => {
    const s = await startShim()
    expect(s.dist).toBe(REAL_DIST)
    const res = await fetch(s.url)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<div id="app">')
  })
})
