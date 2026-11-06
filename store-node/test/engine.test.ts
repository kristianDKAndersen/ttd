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

test("file format: pretty JSON, trailing newline, bak is a byte-identical copy of the latest commit", async () => {
  const home = tmpHome()
  const store = createStore(createNodeIO(), home)
  await store.apply(add("one", "a"), { now: NOW })
  const first = readFileSync(join(home, "todos.json"), "utf8")
  expect(first).toBe(text(readDoc(home)))
  expect(first.endsWith("}\n")).toBe(true)
  expect(readFileSync(join(home, "todos.json.bak"), "utf8")).toBe(first) // even the first commit has a bak
  await store.apply(add("two", "b"), { now: NOW })
  const second = readFileSync(join(home, "todos.json"), "utf8")
  expect(second).not.toBe(first)
  expect(readFileSync(join(home, "todos.json.bak"), "utf8")).toBe(second)
  expect(tmpFiles(home)).toEqual([])
})

test("no-op ops leave bak as it was (it still equals todos.json)", async () => {
  const home = tmpHome()
  const store = createStore(createNodeIO(), home)
  await store.apply(add("one", "a"), { now: NOW })
  await store.apply(add("again", "a"), { now: NOW }) // idempotent add: changed false
  expect(readFileSync(join(home, "todos.json.bak"), "utf8")).toBe(readFileSync(join(home, "todos.json"), "utf8"))
})

// ---- the bak contract (STORE.md section 8): latest commit, atomic, recovery never loses an acknowledged write ----

/** An IO that records every call and can fail chosen ones. `todosAbsent` collects every call after which todos.json was missing. */
function spyIO(home: string, fail: (call: string, args: string[]) => boolean = () => false) {
  const base = createNodeIO()
  const calls: string[] = []
  const todosAbsent: string[] = []
  const existedAtStart = existsSync(join(home, "todos.json"))
  const tap = <A extends string[], R>(name: string, f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    const label = `${name}(${a.map((x) => x.replace(home, "")).join(", ")})`
    calls.push(label)
    if (fail(name, a)) throw new Error(`injected failure in ${label}`)
    const r = await f(...a)
    if (existedAtStart && !existsSync(join(home, "todos.json"))) todosAbsent.push(label)
    return r
  }
  const io = {
    ...base,
    writeText: tap("writeText", (p: string, t: string) => base.writeText(p, t)),
    rename: tap("rename", (f: string, t: string) => base.rename(f, t)),
    removeTree: tap("removeTree", (p: string) => base.removeTree(p)),
    copyFile: tap("copyFile", (f: string, t: string) => (base as any).copyFile(f, t)),
  } as unknown as IO
  return { io, calls, todosAbsent }
}

test("bak is written atomically (tmp then rename), never with a direct write to todos.json.bak", async () => {
  const home = tmpHome()
  const spy = spyIO(home)
  const store = createStore(spy.io, home)
  await store.apply(add("one", "a"), { now: NOW })
  await store.apply(add("two", "b"), { now: NOW })
  expect(spy.calls.filter((c) => c.startsWith("writeText(/todos.json.bak"))).toEqual([])
  expect(spy.calls.filter((c) => /^rename\(\/\.todos\.json\.tmp-[a-z0-9]+, \/todos\.json\.bak\)$/.test(c)).length).toBe(2)
})

test("bak is renamed in after the commit rename, so a crash between them leaves bak one version behind", async () => {
  const home = tmpHome()
  const store0 = createStore(createNodeIO(), home)
  await store0.apply(add("one", "a"), { now: NOW })
  const v1 = readFileSync(join(home, "todos.json"), "utf8")
  // "crash" at the bak rename of the second commit: the commit itself must already be durable, the bak one behind
  const spy = spyIO(home, (name, a) => name === "rename" && a[1]!.endsWith("todos.json.bak"))
  const r = await createStore(spy.io, home).apply(add("two", "b"), { now: NOW })
  expect(r.ok).toBe(true)
  expect(readDoc(home).items.map((i) => i.id)).toEqual(["a", "b"])
  expect(readFileSync(join(home, "todos.json.bak"), "utf8")).toBe(v1)
  expect(tmpFiles(home)).toEqual([]) // the unused bak temp file is removed
  // and the next successful commit catches the bak up
  await store0.apply(add("three", "c"), { now: NOW })
  expect(readFileSync(join(home, "todos.json.bak"), "utf8")).toBe(readFileSync(join(home, "todos.json"), "utf8"))
})

test("a bak that cannot be written fails the op BEFORE the commit: nothing changes, no temp file left", async () => {
  const home = tmpHome()
  const store0 = createStore(createNodeIO(), home)
  await store0.apply(add("one", "a"), { now: NOW })
  const before = readFileSync(join(home, "todos.json"), "utf8")
  let writes = 0
  const spy = spyIO(home, (name) => name === "writeText" && ++writes === 2) // 1st = new todos tmp, 2nd = bak tmp
  const r = await createStore(spy.io, home).apply(add("two", "b"), { now: NOW })
  expect(r.ok === false && r.error).toBe("io_error")
  expect(readFileSync(join(home, "todos.json"), "utf8")).toBe(before)
  expect(tmpFiles(home)).toEqual([])
  expect(existsSync(join(home, "store.lock"))).toBe(false)
})

test("restoring from bak after corruption loses NO acknowledged write, including the last status flip", async () => {
  const home = tmpHome()
  const store = createStore(createNodeIO(), home)
  await store.apply(add("one", "a"), { now: NOW })
  await store.apply(add("two", "b"), { now: NOW })
  await store.apply({ op: "set_status", id: "b", status: "in_progress" }, { now: NOW }) // the last acknowledged write
  const rev = readDoc(home).rev
  const live = readFileSync(join(home, "todos.json"), "utf8")
  const torn = live.slice(0, Math.floor(live.length / 2))
  writeFileSync(join(home, "todos.json"), torn)
  const r = await store.apply(add("three", "c"), { now: NOW })
  expect(r.ok && r.warnings).toEqual(["corrupt_quarantined", "restored_from_bak"])
  expect(r.ok && r.rev).toBe(rev + 1)
  const d = readDoc(home)
  expect(d.items.map((i) => [i.id, i.status])).toEqual([["a", "todo"], ["b", "in_progress"], ["c", "todo"]])
  const q = ls(home).filter((f) => f.startsWith("todos.corrupt-"))
  expect(q.length).toBe(1)
  expect(readFileSync(join(home, q[0]!), "utf8")).toBe(torn)
  expect(readFileSync(join(home, "todos.json.bak"), "utf8")).toBe(readFileSync(join(home, "todos.json"), "utf8"))
})

test("m3: todos.json is never absent while a corrupt file is quarantined and replaced (every IO step checked)", async () => {
  const home = tmpHome()
  put(home, "todos.json", '{"rev":9,"items":[')
  put(home, "todos.json.bak", docOf(["a"], 4))
  const spy = spyIO(home)
  const r = await createStore(spy.io, home).apply(add("b", "b"), { now: NOW })
  expect(r.ok).toBe(true)
  expect(spy.todosAbsent).toEqual([])
  expect(ls(home).filter((f) => f.startsWith("todos.corrupt-")).length).toBe(1)
})

test("m3: a crash before the final rename leaves the corrupt todos.json in place, plus a valid bak; the next writer recovers", async () => {
  const home = tmpHome()
  const torn = '{"rev":9,"items":[{"id":"a'
  put(home, "todos.json", torn)
  put(home, "todos.json.bak", docOf(["a"], 4))
  const spy = spyIO(home, (name, a) => name === "rename" && a[1]!.endsWith("/todos.json"))
  const r = await createStore(spy.io, home).apply(add("b", "b"), { now: NOW })
  expect(r.ok === false && r.error).toBe("io_error")
  expect(readFileSync(join(home, "todos.json"), "utf8")).toBe(torn) // still there, still the same bytes
  expect(JSON.parse(readFileSync(join(home, "todos.json.bak"), "utf8")).rev).toBe(4)
  expect(tmpFiles(home)).toEqual([])
  expect(spy.todosAbsent).toEqual([])
  const r2 = await createStore(createNodeIO(), home).apply(add("b", "b"), { now: NOW })
  expect(r2.ok && r2.warnings).toEqual(["corrupt_quarantined", "restored_from_bak", "backup_stale"])
  expect(readDoc(home).items.map((i) => i.id)).toEqual(["a", "b"])
  for (const f of ls(home).filter((x) => x.startsWith("todos.corrupt-"))) expect(readFileSync(join(home, f), "utf8")).toBe(torn)
})

test("node IO copyFile: byte-identical, survives the source being replaced by a rename", async () => {
  const home = tmpHome()
  const raw = Buffer.from([0xff, 0x00, 0x80, 0x0a])
  writeFileSync(join(home, "src"), raw)
  const io = createNodeIO() as any
  await io.copyFile(join(home, "src"), join(home, "copy"))
  writeFileSync(join(home, "next"), "other")
  await io.rename(join(home, "next"), join(home, "src"))
  expect(readFileSync(join(home, "copy")).equals(raw)).toBe(true)
  await expect(io.copyFile(join(home, "missing"), join(home, "c2"))).rejects.toThrow()
  expect(existsSync(join(home, "c2"))).toBe(false)
})

test("quarantine is byte-identical for non-UTF-8 content", async () => {
  const home = tmpHome()
  const raw = Buffer.from([0xff, 0xfe, ...Buffer.from('{"rev" :  41, garbage '), 0x00, 0x80])
  writeFileSync(join(home, "todos.json"), raw)
  put(home, "todos.json.bak", docOf(["a"], 2))
  const r = await createStore(createNodeIO(), home).apply(add("b", "b"), { now: NOW })
  expect(r.ok && r.rev).toBe(42)
  const q = ls(home).filter((f) => f.startsWith("todos.corrupt-"))
  expect(q.length).toBe(1)
  expect(readFileSync(join(home, q[0]!)).equals(raw)).toBe(true)
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
  expect(seen.length).toBe(2) // the todos temp file and the bak temp file existed at the seam
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
  expect(ls(home)).toEqual(["todos.json", "todos.json.bak"])
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

test("corrupt + valid bak + no-op op: still writes (rev jumps), reports changed:true, bak becomes the restored file", async () => {
  const home = tmpHome()
  put(home, "todos.json", '{"rev":9,"items":[')
  put(home, "todos.json.bak", docOf(["a"], 4))
  const r = await createStore(createNodeIO(), home).apply({ op: "delete", id: "zz" }, { now: NOW })
  expect(r.ok && r.changed).toBe(true)
  expect(r.ok && r.rev).toBe(10)
  expect(r.ok && r.warnings).toEqual(["corrupt_quarantined", "restored_from_bak", "backup_stale"])
  expect(readFileSync(join(home, "todos.json.bak"), "utf8")).toBe(readFileSync(join(home, "todos.json"), "utf8"))
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
  expect(r.ok && r.warnings).toEqual(["corrupt_quarantined", "restored_from_bak", "backup_stale"])
  expect(readDoc(home).items.map((i) => i.id)).toEqual(["a", "b"])
  expect(ls(home).filter((f) => f.startsWith("todos.corrupt-")).length).toBe(1)
  expect(readFileSync(join(home, "todos.json.bak"), "utf8")).toBe(readFileSync(join(home, "todos.json"), "utf8"))
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

// ---- backup_stale (STORE.md sections 4 and 8): a bak that is provably or possibly behind is never silent ----

const failBakRename = (home: string, times: number) => {
  let left = times
  const calls: string[] = []
  const spy = spyIO(home, (name, a) => {
    if (name === "rename" && a[1]!.endsWith("todos.json.bak")) {
      calls.push(a[1]!)
      return left-- > 0
    }
    return false
  })
  return { io: spy.io, calls }
}

test("backup_stale: a bak rename that fails once is retried and the commit reports no warning", async () => {
  const home = tmpHome()
  await createStore(createNodeIO(), home).apply(add("one", "a"), { now: NOW })
  const f = failBakRename(home, 1)
  const r = await createStore(f.io, home).apply(add("two", "b"), { now: NOW })
  expect(r.ok && r.warnings).toEqual([])
  expect(f.calls.length).toBe(2)
  expect(readFileSync(join(home, "todos.json.bak"), "utf8")).toBe(readFileSync(join(home, "todos.json"), "utf8"))
  expect(tmpFiles(home)).toEqual([])
})

test("backup_stale: a bak rename that fails twice leaves the commit standing and adds the warning to its envelope", async () => {
  const home = tmpHome()
  await createStore(createNodeIO(), home).apply(add("one", "a"), { now: NOW })
  const v1 = readFileSync(join(home, "todos.json"), "utf8")
  const f = failBakRename(home, 2)
  const r = await createStore(f.io, home).apply(add("two", "b"), { now: NOW })
  expect(r.ok && r.warnings).toEqual(["backup_stale"])
  expect(r.ok && r.rev).toBe(2)
  expect(f.calls.length).toBe(2) // one try plus one retry
  expect(readDoc(home).items.map((i) => i.id)).toEqual(["a", "b"])
  expect(readFileSync(join(home, "todos.json.bak"), "utf8")).toBe(v1)
  expect(tmpFiles(home)).toEqual([])
})

test("backup_stale: the worst case of the review (ack c, bak refresh fails, file torn) is reported at both ends", async () => {
  const home = tmpHome()
  const store0 = createStore(createNodeIO(), home)
  await store0.apply(add("a", "a"), { now: NOW })
  await store0.apply(add("b", "b"), { now: NOW })
  const f = failBakRename(home, 2)
  const c = await createStore(f.io, home).apply(add("c-acknowledged", "c"), { now: NOW })
  expect(c.ok && c.warnings).toEqual(["backup_stale"])
  const live = readFileSync(join(home, "todos.json"), "utf8")
  const torn = live.slice(0, Math.floor(live.length / 2))
  writeFileSync(join(home, "todos.json"), torn)
  const d = await store0.apply(add("d", "d"), { now: NOW })
  expect(d.ok && d.warnings).toEqual(["corrupt_quarantined", "restored_from_bak", "backup_stale"])
  expect(readDoc(home).items.map((i) => i.id)).toEqual(["a", "b", "d"]) // c is not in the live list ...
  const q = ls(home).filter((n) => n.startsWith("todos.corrupt-"))
  expect(readFileSync(join(home, q[0]!), "utf8")).toBe(torn) // ... but it is in the quarantined file
})

test("backup_stale: restore warns only when the scraped rev is greater than bak.rev", async () => {
  for (const [rawRev, stale] of [[4, false], [5, true], [9, true]] as const) {
    const home = tmpHome()
    put(home, "todos.json", `{"schemaVersion":1,"rev":${rawRev},"items":[{"id":"a`)
    put(home, "todos.json.bak", docOf(["a"], 4))
    const r = await createStore(createNodeIO(), home).apply(add("b", "b"), { now: NOW })
    expect(r.ok && r.warnings, `rev ${rawRev}`).toEqual(stale ? ["corrupt_quarantined", "restored_from_bak", "backup_stale"] : ["corrupt_quarantined", "restored_from_bak"])
  }
})

test("backup_stale: a corrupt file with no readable rev, or no bak at all, never claims staleness", async () => {
  const home = tmpHome()
  put(home, "todos.json", "{not json")
  put(home, "todos.json.bak", docOf(["a"], 4))
  const r = await createStore(createNodeIO(), home).apply(add("b", "b"), { now: NOW })
  expect(r.ok && r.warnings).toEqual(["corrupt_quarantined", "restored_from_bak"])
  const home2 = tmpHome()
  put(home2, "todos.json", '{"rev":9,"items":[')
  const r2 = await createStore(createNodeIO(), home2).apply({ op: "reset_corrupt" }, { now: NOW })
  expect(r2.ok && r2.warnings).toEqual(["corrupt_quarantined"])
})

test("backup_stale: reset_corrupt restoring a stale bak warns too", async () => {
  const home = tmpHome()
  put(home, "todos.json", '{"schemaVersion":1,"rev":9,"items":[')
  put(home, "todos.json.bak", docOf(["a"], 4))
  const r = await createStore(createNodeIO(), home).apply({ op: "reset_corrupt" }, { now: NOW })
  expect(r.ok && r.warnings).toEqual(["corrupt_quarantined", "restored_from_bak", "backup_stale"])
  expect(r.ok && r.rev).toBe(10)
})

test("m2 parity: node IO treats a todos.json that is not valid UTF-8 as corrupt (like Rust), even when the JSON structure survives", async () => {
  const home = tmpHome()
  const t = Buffer.from(text(docOf(["a"], 3)).replace('"A"', '"AXB"'))
  const i = t.indexOf("X")
  const bad = Buffer.concat([t.subarray(0, i), Buffer.from([0xe2, 0x82]), t.subarray(i + 1)])
  writeFileSync(join(home, "todos.json"), bad)
  put(home, "todos.json.bak", docOf(["a"], 3))
  const r = await createStore(createNodeIO(), home).apply(add("b", "b"), { now: NOW })
  expect(r.ok && r.warnings).toEqual(["corrupt_quarantined", "restored_from_bak"])
  const q = ls(home).filter((n) => n.startsWith("todos.corrupt-"))
  expect(readFileSync(join(home, q[0]!)).equals(bad)).toBe(true)
  expect(readDoc(home).items.map((x) => x.title)).toEqual(["A", "b"])
})
