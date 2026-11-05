// Engine protocol (STORE.md sections 4-8) against real files in temp homes.
import { afterAll, expect, test } from "bun:test"
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStore } from "../../plugin/hooks/store/index.ts"
import type { Doc, IO, Item } from "../../plugin/hooks/store/index.ts"
import { createNodeIO } from "../node-io.ts"

const homes: string[] = []
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }) })
const tmpHome = (): string => {
  const h = mkdtempSync(join(tmpdir(), "ttd-eng-"))
  homes.push(h)
  return h
}
const NOW = "2026-01-01T09:00:00.000Z"
const item = (id: string, order: number, extra: Partial<Item> = {}): Item => ({
  id, title: id.toUpperCase(), body: "", status: "todo", order, createdAt: NOW, updatedAt: NOW, ...extra,
})
const docOf = (ids: string[], rev: number): Doc => ({ schemaVersion: 1, rev, items: ids.map((id, i) => item(id, i)) })
const text = (d: unknown) => JSON.stringify(d, null, 2) + "\n"
const put = (home: string, name: string, d: unknown) => writeFileSync(join(home, name), typeof d === "string" ? d : text(d))
const ls = (home: string) => readdirSync(home).sort()
const tmpFiles = (home: string) => ls(home).filter((f) => f.startsWith(".todos.json.tmp-"))
const readDoc = (home: string): Doc => JSON.parse(readFileSync(join(home, "todos.json"), "utf8"))
const add = (title: string, id?: string) => (id ? { op: "add" as const, title, id } : { op: "add" as const, title })

function wrapIO(base: IO, over: Partial<IO>): IO {
  return { ...base, ...over }
}

test("8 concurrent applies in one process: all land, rev 8, nothing left behind", async () => {
  const home = tmpHome()
  const store = createStore(createNodeIO(), home)
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => store.apply(add(`task ${i}`), { now: NOW })))
  for (const r of results) expect(r.ok).toBe(true)
  const d = readDoc(home)
  expect(d.rev).toBe(8)
  expect(d.items.map((i) => i.title).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `task ${i}`))
  expect(new Set(d.items.map((i) => i.id)).size).toBe(8)
  expect(d.items.map((i) => i.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  expect(existsSync(join(home, "store.lock"))).toBe(false)
  expect(tmpFiles(home)).toEqual([])
}, 30000)

test("a not-yet-existing TTD_HOME is created and the write is fast (no lock_timeout spin)", async () => {
  const parent = tmpHome()
  const home = join(parent, "nested", ".ttd")
  const t0 = Date.now()
  const r = await createStore(createNodeIO(), home).apply(add("first"), { now: NOW })
  expect(r.ok).toBe(true)
  expect(Date.now() - t0).toBeLessThan(1500)
  expect(readDoc(home).rev).toBe(1)
})

test("file format: pretty JSON, trailing newline, bak is the previous content", async () => {
  const home = tmpHome()
  const store = createStore(createNodeIO(), home)
  await store.apply(add("one", "a"), { now: NOW })
  const first = readFileSync(join(home, "todos.json"), "utf8")
  expect(first).toBe(text(readDoc(home)))
  expect(first.endsWith("}\n")).toBe(true)
  expect(existsSync(join(home, "todos.json.bak"))).toBe(false) // nothing existed before the first commit
  await store.apply(add("two", "b"), { now: NOW })
  expect(readFileSync(join(home, "todos.json.bak"), "utf8")).toBe(first)
})

test("no-op ops and validation errors do not write: content, mtime and rev unchanged, no bak, no tmp", async () => {
  const home = tmpHome()
  put(home, "todos.json", docOf(["a", "b"], 4))
  utimesSync(join(home, "todos.json"), 1000, 1000)
  const before = readFileSync(join(home, "todos.json"), "utf8")
  const store = createStore(createNodeIO(), home)
  const ops: any[] = [
    { op: "add", id: "a", title: "dup" }, { op: "delete", id: "zz" }, { op: "set_status", id: "a", status: "todo" },
    { op: "update", id: "a", title: "A" }, { op: "move", id: "b", after: "a" },
    { op: "add", title: "" }, { op: "update", id: "zz", title: "x" }, { op: "bogus" },
  ]
  for (const op of ops) await store.apply(op, { now: NOW })
  expect(readFileSync(join(home, "todos.json"), "utf8")).toBe(before)
  expect(statSync(join(home, "todos.json")).mtimeMs).toBe(1000000)
  expect(ls(home)).toEqual(["todos.json"])
})

test("invalid ops and bad ctx.now are rejected without touching the filesystem", async () => {
  const parent = tmpHome()
  const home = join(parent, "never-created")
  const store = createStore(createNodeIO(), home)
  expect(await store.apply({ op: "add", title: "" }, { now: NOW })).toEqual({ ok: false, error: "invalid_title" })
  const r = await store.apply(add("x"), { now: "yesterday" })
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error).toBe("invalid_op")
  expect(existsSync(home)).toBe(false)
})

test("tmp file is removed on a CAS conflict and the op is re-applied on the new base", async () => {
  const home = tmpHome()
  put(home, "todos.json", docOf(["x"], 1))
  let seen: string[] = []
  const r = await createStore(createNodeIO(), home).apply(add("mine", "m"), {
    now: NOW,
    beforeCommit: async () => {
      if (seen.length) return
      seen = tmpFiles(home)
      put(home, "todos.json", docOf(["x", "f"], 2))
    },
  })
  expect(seen.length).toBe(1) // the temp file existed at the seam
  expect(r.ok && r.attempts).toBe(2)
  expect(readDoc(home).items.map((i) => i.id)).toEqual(["x", "f", "m"])
  expect(readDoc(home).rev).toBe(3)
  expect(tmpFiles(home)).toEqual([])
})

test("CAS compares raw text, not only rev: a same-rev foreign rewrite forces a retry", async () => {
  const home = tmpHome()
  put(home, "todos.json", docOf(["x"], 5))
  let fired = false
  const r = await createStore(createNodeIO(), home).apply(add("mine", "m"), {
    now: NOW,
    beforeCommit: async () => {
      if (fired) return
      fired = true
      put(home, "todos.json", { ...docOf(["x", "sneaky"], 5) }) // same rev, different content
    },
  })
  expect(r.ok && r.attempts).toBe(2)
  expect(readDoc(home).items.map((i) => i.id)).toEqual(["x", "sneaky", "m"])
})

test("a generated id is stable across CAS retries", async () => {
  const home = tmpHome()
  put(home, "todos.json", docOf(["x"], 1))
  const ids: string[] = []
  let n = 0
  const r = await createStore(createNodeIO(), home).apply(add("gen"), {
    now: NOW,
    beforeCommit: async () => {
      ids.push(readdirSync(home).filter((f) => f.startsWith(".todos.json.tmp-"))[0])
      if (n++ === 0) put(home, "todos.json", docOf(["x", "f"], 2))
    },
  })
  expect(r.ok && r.attempts).toBe(2)
  const added = readDoc(home).items.filter((i) => i.id.startsWith("t_"))
  expect(added.length).toBe(1)
  expect(r.ok && (r.result as { item: Item }).item.id).toBe(added[0].id)
})

test("conflict_exhausted after 5 forced conflicts; tmp removed, lock released, file is the foreign one", async () => {
  const home = tmpHome()
  put(home, "todos.json", docOf(["x"], 1))
  let calls = 0
  const r = await createStore(createNodeIO(), home).apply(add("never"), {
    now: NOW,
    beforeCommit: async () => { calls++; put(home, "todos.json", docOf(["x"], 1 + calls)) },
  })
  expect(r).toEqual({ ok: false, error: "conflict_exhausted" })
  expect(calls).toBe(5)
  expect(tmpFiles(home)).toEqual([])
  expect(existsSync(join(home, "store.lock"))).toBe(false)
  expect(readDoc(home).rev).toBe(6)
})

test("injected rename failure: io_error, tmp removed, lock released, todos.json untouched", async () => {
  const home = tmpHome()
  put(home, "todos.json", docOf(["x"], 1))
  const before = readFileSync(join(home, "todos.json"), "utf8")
  const base = createNodeIO()
  const io = wrapIO(base, {
    async rename(from, to) {
      if (to.endsWith("todos.json")) throw new Error("injected EIO")
      return base.rename(from, to)
    },
  })
  const r = await createStore(io, home).apply(add("a"), { now: NOW })
  expect(r.ok).toBe(false)
  if (!r.ok) { expect(r.error).toBe("io_error"); expect(r.message).toContain("injected EIO") }
  expect(readFileSync(join(home, "todos.json"), "utf8")).toBe(before)
  expect(tmpFiles(home)).toEqual([])
  expect(existsSync(join(home, "store.lock"))).toBe(false)
})

test("rename retry lives in node-io: EPERM twice then success commits; six EPERMs is io_error", async () => {
  const home = tmpHome()
  put(home, "todos.json", docOf(["x"], 1))
  const calls: string[] = []
  const realRename = (await import("node:fs/promises")).rename
  let failures = 2
  const io = createNodeIO({
    renameRetryDelayMs: 1,
    rawRename: async (a, b) => {
      calls.push(b)
      if (b.endsWith("todos.json") && failures-- > 0) throw Object.assign(new Error("busy"), { code: "EPERM" })
      return realRename(a, b)
    },
  })
  const r = await createStore(io, home).apply(add("a", "a"), { now: NOW })
  expect(r.ok).toBe(true)
  expect(calls.filter((c) => c.endsWith("todos.json")).length).toBe(3)

  failures = 100
  const r2 = await createStore(io, home).apply(add("b", "b"), { now: NOW })
  expect(r2.ok).toBe(false)
  if (!r2.ok) expect(r2.error).toBe("io_error")
  expect(readDoc(home).items.map((i) => i.id)).toEqual(["x", "a"])
  expect(tmpFiles(home)).toEqual([])
  expect(existsSync(join(home, "store.lock"))).toBe(false)
})

test("non-retryable rename errors fail immediately", async () => {
  const calls: string[] = []
  const io = createNodeIO({
    renameRetryDelayMs: 1,
    rawRename: async (_a, b) => { calls.push(b); throw Object.assign(new Error("nope"), { code: "ENOENT" }) },
  })
  await expect(io.rename("/x/a", "/x/b")).rejects.toThrow()
  expect(calls.length).toBe(1)
})

test("lock_timeout leaves a foreign lock and its owner.json alone", async () => {
  const home = tmpHome()
  put(home, "todos.json", docOf(["x"], 1))
  mkdirSync(join(home, "store.lock"))
  const owner = JSON.stringify({ token: "someoneelse1", pid: 7, ts: Date.now() })
  writeFileSync(join(home, "store.lock", "owner.json"), owner)
  const t0 = Date.now()
  const r = await createStore(createNodeIO(), home, { lockTimeoutMs: 250 }).apply(add("a"), { now: NOW })
  expect(r).toEqual({ ok: false, error: "lock_timeout" })
  expect(Date.now() - t0).toBeGreaterThanOrEqual(240)
  expect(readFileSync(join(home, "store.lock", "owner.json"), "utf8")).toBe(owner)
  expect(readDoc(home).rev).toBe(1)
})

test("stale lock (old owner.json ts) is broken: warning, lock gone, stale dir removed", async () => {
  const home = tmpHome()
  mkdirSync(join(home, "store.lock"))
  writeFileSync(join(home, "store.lock", "owner.json"), JSON.stringify({ token: "dead", pid: 1, ts: Date.now() - 60000 }))
  const r = await createStore(createNodeIO(), home).apply(add("a"), { now: NOW })
  expect(r.ok && r.warnings).toEqual(["stale_lock_broken"])
  expect(ls(home)).toEqual(["todos.json"])
})

test("stale rule honours lockStaleMs and falls back to the lock dir mtime without owner.json", async () => {
  const home = tmpHome()
  mkdirSync(join(home, "store.lock"))
  // no owner.json, fresh mtime: not stale
  let r = await createStore(createNodeIO(), home, { lockTimeoutMs: 150 }).apply(add("a"), { now: NOW })
  expect(r).toEqual({ ok: false, error: "lock_timeout" })
  // unparseable owner.json with an old mtime: stale
  writeFileSync(join(home, "store.lock", "owner.json"), "{garbage")
  utimesSync(join(home, "store.lock", "owner.json"), 1, 1)
  utimesSync(join(home, "store.lock"), 1, 1)
  r = await createStore(createNodeIO(), home, { lockTimeoutMs: 150 }).apply(add("a"), { now: NOW })
  expect(r.ok && r.warnings).toEqual(["stale_lock_broken"])
  // a lock younger than a tiny lockStaleMs is still respected, an older one is not
  mkdirSync(join(home, "store.lock"))
  writeFileSync(join(home, "store.lock", "owner.json"), JSON.stringify({ token: "t", pid: 1, ts: Date.now() - 500 }))
  r = await createStore(createNodeIO(), home, { lockTimeoutMs: 100, lockStaleMs: 60000 }).apply(add("b"), { now: NOW })
  expect(r).toEqual({ ok: false, error: "lock_timeout" })
  r = await createStore(createNodeIO(), home, { lockTimeoutMs: 100, lockStaleMs: 100 }).apply(add("b"), { now: NOW })
  expect(r.ok && r.warnings).toEqual(["stale_lock_broken"])
})

test("an unbreakable stale lock still ends in lock_timeout (no spin), foreign lock left in place", async () => {
  const home = tmpHome()
  mkdirSync(join(home, "store.lock"))
  const owner = JSON.stringify({ token: "dead", pid: 1, ts: Date.now() - 60000 })
  writeFileSync(join(home, "store.lock", "owner.json"), owner)
  const base = createNodeIO()
  const io = wrapIO(base, {
    async rename(from, to) {
      if (from.endsWith("store.lock")) throw new Error("EPERM injected")
      return base.rename(from, to)
    },
  })
  const t0 = Date.now()
  const r = await createStore(io, home, { lockTimeoutMs: 200 }).apply(add("a"), { now: NOW })
  expect(r).toEqual({ ok: false, error: "lock_timeout" })
  expect(Date.now() - t0).toBeLessThan(1500)
  expect(readFileSync(join(home, "store.lock", "owner.json"), "utf8")).toBe(owner)
})

test("mod-style mkdirExclusive (false on any failure) with no lock dir ends in io_error, not a spin", async () => {
  const home = tmpHome()
  const io = wrapIO(createNodeIO(), { async mkdirExclusive() { return false } })
  const t0 = Date.now()
  const r = await createStore(io, home, { lockTimeoutMs: 200 }).apply(add("a"), { now: NOW })
  expect(r.ok === false && r.error).toBe("io_error")
  expect(Date.now() - t0).toBeLessThan(1500)
  expect(ls(home)).toEqual([])
})

test("a writer whose lock was broken under it must not delete the successor's lock", async () => {
  const home = tmpHome()
  put(home, "todos.json", docOf(["x"], 1))
  const successor = JSON.stringify({ token: "successor123", pid: 9, ts: Date.now() })
  const r = await createStore(createNodeIO(), home).apply(add("a", "a"), {
    now: NOW,
    beforeCommit: async () => {
      rmSync(join(home, "store.lock"), { recursive: true })
      mkdirSync(join(home, "store.lock"))
      writeFileSync(join(home, "store.lock", "owner.json"), successor)
    },
  })
  expect(r.ok).toBe(true)
  expect(readFileSync(join(home, "store.lock", "owner.json"), "utf8")).toBe(successor)
})

test("read: absent file is the empty doc and nothing is created", async () => {
  const home = tmpHome()
  const r = await createStore(createNodeIO(), home).read()
  expect(r).toEqual({ ok: true, doc: { schemaVersion: 1, rev: 0, items: [] }, warnings: [] })
  expect(ls(home)).toEqual([])
})

test("read never writes: mtime and directory listing unchanged, even for corrupt and unsupported files", async () => {
  const home = tmpHome()
  put(home, "todos.json", docOf(["b", "a"], 3).items.length ? { ...docOf(["b", "a"], 3), items: [item("b", 7), item("a", 7)] } : {})
  utimesSync(join(home, "todos.json"), 1000, 1000)
  const store = createStore(createNodeIO(), home)
  const r = await store.read()
  expect(r.ok && r.doc.items.map((i) => [i.id, i.order])).toEqual([["a", 0], ["b", 1]])
  expect(statSync(join(home, "todos.json")).mtimeMs).toBe(1000000)
  expect(ls(home)).toEqual(["todos.json"])

  put(home, "todos.json", "{torn")
  const c = await store.read()
  expect(c).toEqual({ ok: false, error: "corrupt" })
  put(home, "todos.json", { schemaVersion: 7, rev: 1, items: [] })
  expect(await store.read()).toEqual({ ok: false, error: "unsupported_version" })
  expect(ls(home)).toEqual(["todos.json"])
})

test("read retries a torn file 3x at 50 ms before reporting corrupt; a repair in the window is picked up", async () => {
  const home = tmpHome()
  put(home, "todos.json", '{"schemaVersion":1,"rev":2,"items":[{"id":"t')
  const store = createStore(createNodeIO(), home)
  const t0 = Date.now()
  const bad = await store.read()
  const took = Date.now() - t0
  expect(bad).toEqual({ ok: false, error: "corrupt" })
  expect(took).toBeGreaterThanOrEqual(140)
  expect(took).toBeLessThan(1500)

  setTimeout(() => put(home, "todos.json", docOf(["a"], 3)), 70)
  const good = await store.read()
  expect(good.ok && good.doc.rev).toBe(3)
})

test("sleep and now come from IO (injected, deterministic retry count)", async () => {
  const home = tmpHome()
  put(home, "todos.json", "{torn")
  const sleeps: number[] = []
  const io = wrapIO(createNodeIO(), { async sleep(ms) { sleeps.push(ms) } })
  expect(await createStore(io, home).read()).toEqual({ ok: false, error: "corrupt" })
  expect(sleeps).toEqual([50, 50, 50])
})

test("unsupported schemaVersion: write refused, file untouched, no quarantine", async () => {
  const home = tmpHome()
  put(home, "todos.json", { schemaVersion: 2, rev: 1, items: [], extra: 1 })
  const before = readFileSync(join(home, "todos.json"), "utf8")
  const r = await createStore(createNodeIO(), home).apply(add("a"), { now: NOW })
  expect(r).toEqual({ ok: false, error: "unsupported_version" })
  expect(readFileSync(join(home, "todos.json"), "utf8")).toBe(before)
  expect(ls(home)).toEqual(["todos.json"])
})

test("corrupt + valid bak + an op that fails validation: nothing is quarantined or moved", async () => {
  const home = tmpHome()
  put(home, "todos.json", '{"rev":9,"items":[')
  put(home, "todos.json.bak", docOf(["a"], 4))
  const r = await createStore(createNodeIO(), home).apply({ op: "update", id: "zz", title: "x" }, { now: NOW })
  expect(r).toEqual({ ok: false, error: "not_found" })
  expect(ls(home)).toEqual(["todos.json", "todos.json.bak"])
  expect(readFileSync(join(home, "todos.json"), "utf8")).toBe('{"rev":9,"items":[')
})

test("corrupt + valid bak + no-op op: still writes (rev jumps), reports changed:true, bak untouched", async () => {
  const home = tmpHome()
  put(home, "todos.json", '{"rev":9,"items":[')
  put(home, "todos.json.bak", docOf(["a"], 4))
  const bakBefore = readFileSync(join(home, "todos.json.bak"), "utf8")
  const r = await createStore(createNodeIO(), home).apply({ op: "delete", id: "zz" }, { now: NOW })
  expect(r.ok && r.changed).toBe(true)
  expect(r.ok && r.rev).toBe(10)
  expect(r.ok && r.warnings).toEqual(["corrupt_quarantined", "restored_from_bak"])
  expect(readFileSync(join(home, "todos.json.bak"), "utf8")).toBe(bakBefore)
  expect(readDoc(home).items.map((i) => i.id)).toEqual(["a"])
})

test("corrupt + torn bak: corrupt_no_backup, everything left as found", async () => {
  const home = tmpHome()
  put(home, "todos.json", "{x")
  put(home, "todos.json.bak", "{also torn")
  const r = await createStore(createNodeIO(), home).apply(add("a"), { now: NOW })
  expect(r).toEqual({ ok: false, error: "corrupt_no_backup" })
  expect(ls(home)).toEqual(["todos.json", "todos.json.bak"])
})

test("reset_corrupt with a valid bak restores the bak (never an empty list over recoverable items)", async () => {
  const home = tmpHome()
  put(home, "todos.json", '{"rev":11,"items":[{"id":"zz')
  put(home, "todos.json.bak", docOf(["a", "b"], 8))
  const r = await createStore(createNodeIO(), home).apply({ op: "reset_corrupt" }, { now: NOW })
  expect(r.ok && r.rev).toBe(12)
  expect(r.ok && r.result).toEqual({})
  expect(r.ok && r.warnings).toEqual(["corrupt_quarantined", "restored_from_bak"])
  expect(readDoc(home).items.map((i) => i.id)).toEqual(["a", "b"])
  expect(ls(home).filter((f) => f.startsWith("todos.corrupt-")).length).toBe(1)
})

test("reset_corrupt on an absent or healthy file is not_corrupt and writes nothing", async () => {
  const home = tmpHome()
  const store = createStore(createNodeIO(), home)
  expect(await store.apply({ op: "reset_corrupt" }, { now: NOW })).toEqual({ ok: false, error: "not_corrupt" })
  expect(ls(home)).toEqual([])
  put(home, "todos.json", docOf(["a"], 1))
  expect(await store.apply({ op: "reset_corrupt" }, { now: NOW })).toEqual({ ok: false, error: "not_corrupt" })
  expect(ls(home)).toEqual(["todos.json"])
})

test("quarantine name carries the op timestamp and a 12-char token", async () => {
  const home = tmpHome()
  put(home, "todos.json", "{x")
  await createStore(createNodeIO(), home).apply({ op: "reset_corrupt" }, { now: "2026-03-04T05:06:07.890Z" })
  const q = ls(home).filter((f) => f.startsWith("todos.corrupt-"))
  expect(q.length).toBe(1)
  expect(q[0]).toMatch(/^todos\.corrupt-20260304T050607Z-[a-z0-9]{12}\.json$/)
})

test("size limit: an add that pushes the file over 1 MiB is limit_exceeded and writes nothing", async () => {
  const home = tmpHome()
  const body = "y".repeat(10000)
  const items = Array.from({ length: 102 }, (_, i) => item(`i${i}`, i, { body }))
  put(home, "todos.json", { schemaVersion: 1, rev: 1, items })
  const size = statSync(join(home, "todos.json")).size
  expect(size).toBeLessThan(1048576)
  expect(size).toBeGreaterThan(1048576 - 10300)
  const store = createStore(createNodeIO(), home)
  const r = await store.apply({ op: "add", title: "big", body }, { now: NOW })
  expect(r).toEqual({ ok: false, error: "limit_exceeded" })
  expect(statSync(join(home, "todos.json")).size).toBe(size)
  // shrinking ops are never blocked by the size rule
  const d = await store.apply({ op: "delete", id: "i0" }, { now: NOW })
  expect(d.ok).toBe(true)
})

test("IO failures surface as io_error, with the lock released", async () => {
  const home = tmpHome()
  const base = createNodeIO()
  const io = wrapIO(base, { async readText(p) { if (p.endsWith("todos.json")) throw new Error("EIO read"); return base.readText(p) } })
  const r = await createStore(io, home).apply(add("a"), { now: NOW })
  expect(r.ok).toBe(false)
  if (!r.ok) { expect(r.error).toBe("io_error"); expect(r.message).toContain("EIO read") }
  expect(existsSync(join(home, "store.lock"))).toBe(false)
  const rd = await createStore(io, home).read()
  expect(rd.ok).toBe(false)
  if (!rd.ok) expect(rd.error).toBe("io_error")

  const io2 = wrapIO(base, { async mkdirExclusive() { throw new Error("EACCES lock") } })
  const r2 = await createStore(io2, home).apply(add("a"), { now: NOW })
  expect(r2.ok === false && r2.error).toBe("io_error")
})

test("a platform that cannot lock never writes unlocked", async () => {
  const home = tmpHome()
  const io = wrapIO(createNodeIO(), { async mkdirExclusive() { throw new Error("cannot write safely here") } })
  const r = await createStore(io, home).apply(add("a"), { now: NOW })
  expect(r.ok === false && r.error).toBe("io_error")
  expect(existsSync(join(home, "todos.json"))).toBe(false)
  // reads still work
  expect((await createStore(io, home).read()).ok).toBe(true)
})

test("unknown top-level and item fields survive restore-from-bak and normal writes", async () => {
  const home = tmpHome()
  put(home, "todos.json", { ...docOf(["a"], 1), meta: { k: 1 }, items: [{ ...item("a", 0), color: "red" }] })
  await createStore(createNodeIO(), home).apply({ op: "set_status", id: "a", status: "done" }, { now: NOW })
  const d: any = readDoc(home)
  expect(d.meta).toEqual({ k: 1 })
  expect(d.items[0].color).toBe("red")
})
