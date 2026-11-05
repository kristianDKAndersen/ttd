// STORE.md section 7 change detection: stat poll + 2 s forced read, publish on normalised-JSON change.
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStore } from "../../plugin/hooks/store/index.ts"
import type { Doc } from "../../plugin/hooks/store/index.ts"
import { createNodeIO } from "../node-io.ts"
import { watchStore } from "../watch.ts"
import type { WatchEvent } from "../watch.ts"

const CLI = join(import.meta.dir, "../cli.ts")
const homes: string[] = []
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }) })
const tmpHome = () => { const h = mkdtempSync(join(tmpdir(), "ttd-watch-")); homes.push(h); return h }
const NOW = "2026-01-01T09:00:00.000Z"
const doc = (rev: number, titles: string[]): Doc => ({
  schemaVersion: 1, rev,
  items: titles.map((t, i) => ({ id: `i${i}`, title: t, body: "", status: "todo", order: i, createdAt: NOW, updatedAt: NOW })),
})
const write = (home: string, d: unknown) => writeFileSync(join(home, "todos.json"), JSON.stringify(d, null, 2) + "\n")

async function until(pred: () => boolean, ms: number, what: string) {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

function start(home: string, extra: Record<string, unknown> = {}) {
  const events: WatchEvent[] = []
  const h = watchStore({ homeDir: home, io: createNodeIO(), intervalMs: 30, onEvent: (e) => events.push(e), ...extra })
  return { events, stop: () => h.stop(), done: h.done }
}
const revs = (events: WatchEvent[]) => events.map((e) => (e.result.ok ? e.result.doc.rev : e.result.error))

test("initial state is published; an absent file is the empty doc rev 0", async () => {
  const home = tmpHome()
  const w = start(home)
  await until(() => w.events.length === 1, 3000, "initial event")
  expect(revs(w.events)).toEqual([0])
  w.stop(); await w.done
})

test("in-place write is detected", async () => {
  const home = tmpHome()
  write(home, doc(1, ["a"]))
  const w = start(home)
  await until(() => w.events.length === 1, 3000, "initial")
  write(home, doc(2, ["a", "b"])) // truncate + write in the same inode
  await until(() => w.events.length === 2, 3000, "in-place change")
  expect(revs(w.events)).toEqual([1, 2])
  w.stop(); await w.done
})

test("rename-replace (new inode, as every conforming writer does) is detected", async () => {
  const home = tmpHome()
  write(home, doc(1, ["a"]))
  const w = start(home)
  await until(() => w.events.length === 1, 3000, "initial")
  writeFileSync(join(home, ".tmp-x"), JSON.stringify(doc(2, ["a", "b"]), null, 2) + "\n")
  renameSync(join(home, ".tmp-x"), join(home, "todos.json"))
  await until(() => w.events.length === 2, 3000, "rename-replace change")
  w.stop(); await w.done
})

test("delete and recreate is detected (absent doc, then the new content)", async () => {
  const home = tmpHome()
  write(home, doc(4, ["a"]))
  const w = start(home)
  await until(() => w.events.length === 1, 3000, "initial")
  unlinkSync(join(home, "todos.json"))
  await until(() => w.events.length === 2, 3000, "delete")
  expect(w.events[1].result.ok && w.events[1].result.doc.rev).toBe(0)
  write(home, doc(5, ["z"]))
  await until(() => w.events.length === 3, 3000, "recreate")
  expect(revs(w.events)).toEqual([4, 0, 5])
  w.stop(); await w.done
})

test("identical normalised content is not republished; self-writes are published like any other", async () => {
  const home = tmpHome()
  write(home, doc(1, ["a"]))
  const w = start(home)
  await until(() => w.events.length === 1, 3000, "initial")
  write(home, doc(1, ["a"])) // new mtime, same content
  await new Promise((r) => setTimeout(r, 250))
  expect(w.events.length).toBe(1)
  await createStore(createNodeIO(), home).apply({ op: "add", title: "mine" }, { now: NOW })
  await until(() => w.events.length === 2, 3000, "self-write")
  w.stop(); await w.done
})

test("the forced read (every 2 s) catches a change that leaves (mtime, size) identical", async () => {
  const home = tmpHome()
  const p = join(home, "todos.json")
  write(home, doc(1, ["aaaa"]))
  utimesSync(p, 1000, 1000)
  const w = start(home) // default forceReadMs = 2000
  await until(() => w.events.length === 1, 3000, "initial")
  const size = statSync(p).size
  write(home, doc(1, ["bbbb"])) // same rev, same byte length, different content
  utimesSync(p, 1000, 1000)
  expect(statSync(p).size).toBe(size)
  await new Promise((r) => setTimeout(r, 600))
  expect(w.events.length).toBe(1) // stat alone cannot see it
  await until(() => w.events.length === 2, 3500, "forced read")
  expect(w.events[1].result.ok && w.events[1].result.doc.items[0].title).toBe("bbbb")
  w.stop(); await w.done
}, 15000)

test("corrupt and unsupported states are published as error events, then recovery", async () => {
  const home = tmpHome()
  write(home, doc(1, ["a"]))
  const w = start(home)
  await until(() => w.events.length === 1, 3000, "initial")
  writeFileSync(join(home, "todos.json"), "{torn")
  await until(() => w.events.length === 2, 4000, "corrupt")
  write(home, doc(2, ["a"]))
  await until(() => w.events.length === 3, 4000, "recovery")
  expect(revs(w.events)).toEqual([1, "corrupt", 2])
  w.stop(); await w.done
})

test("maxEvents and timeoutMs end the watch on their own", async () => {
  const home = tmpHome()
  write(home, doc(1, ["a"]))
  const t0 = Date.now()
  const a = start(home, { timeoutMs: 300 })
  await a.done
  expect(a.events.length).toBe(1)
  expect(Date.now() - t0).toBeGreaterThanOrEqual(280)

  const b = start(home, { maxEvents: 2 })
  await new Promise((r) => setTimeout(r, 100))
  write(home, doc(2, ["a", "b"]))
  await b.done
  expect(b.events.length).toBe(2)
})

test("cli watch --max-events prints the documented lines and exits 0", async () => {
  const home = tmpHome()
  write(home, doc(3, ["a", "b"]))
  const p = Bun.spawn([process.execPath, CLI, "watch", "--interval-ms", "40", "--max-events", "2"], {
    env: { ...process.env, TTD_HOME: home }, stdout: "pipe", stderr: "pipe",
  })
  await new Promise((r) => setTimeout(r, 400))
  const apply = Bun.spawn([process.execPath, CLI, "apply", '{"op":"add","title":"c"}'], { env: { ...process.env, TTD_HOME: home }, stdout: "pipe" })
  await apply.exited
  const code = await p.exited
  const out = (await new Response(p.stdout).text()).trim().split("\n")
  expect(code).toBe(0)
  expect(out.length).toBe(2)
  const l0 = JSON.parse(out[0]), l1 = JSON.parse(out[1])
  expect(Object.keys(l0).sort()).toEqual(["at", "count", "rev"])
  expect([l0.rev, l0.count]).toEqual([3, 2])
  expect([l1.rev, l1.count]).toEqual([4, 3])
  expect(typeof l0.at).toBe("number")
  expect(l1.at).toBeGreaterThanOrEqual(l0.at)
}, 20000)

test("cli watch --timeout-ms exits 0 after T ms with the initial line; absent file is rev 0 count 0", async () => {
  const home = tmpHome()
  const t0 = Date.now()
  const p = Bun.spawn([process.execPath, CLI, "watch", "--timeout-ms", "400"], { env: { ...process.env, TTD_HOME: home }, stdout: "pipe", stderr: "pipe" })
  const code = await p.exited
  const out = (await new Response(p.stdout).text()).trim().split("\n")
  expect(code).toBe(0)
  expect(Date.now() - t0).toBeGreaterThanOrEqual(380)
  expect(out.map((l) => JSON.parse(l))).toEqual([{ rev: 0, at: expect.any(Number), count: 0 }])
}, 20000)
