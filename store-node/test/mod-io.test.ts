// The mod's IO adapter (plugin/hooks/mod-io.ts) against REAL files and directories: the host is a thin node
// wrapper over fs and child_process, so `mv`, `ln`, `mkdir` and `rm` really run (STORE.md section 12).
import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createModIO } from "../../plugin/hooks/mod-io.ts"
import type { ModHost } from "../../plugin/hooks/mod-io.ts"
import { createStore, parseDoc } from "../../plugin/hooks/store/index.ts"

const roots: string[] = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })
const tmp = (): string => {
  const r = mkdtempSync(join(tmpdir(), "ttd-modio-"))
  roots.push(r)
  return r
}

const realHost: ModHost = {
  fs: {
    // Documented host behaviour (claude-code.d.ts FsReadCall): text by default (lossy UTF-8), { base64 } only for { as: "bytes" }.
    async read(p, o) { return o?.as === "bytes" ? { base64: readFileSync(p).toString("base64") } : readFileSync(p, "utf8") },
    async write(p, t) { writeFileSync(p, t) },
    async exists(p) { return existsSync(p) },
    async stat(p) { return { mtimeMs: statSync(p).mtimeMs } },
  },
  process: {
    async run(argv) {
      const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" })
      return { exitCode: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
    },
  },
  clock: { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
}
const io = createModIO(realHost, { windows: false })

test("m1: renaming a directory onto an existing non-empty directory is refused, never nested", async () => {
  const d = tmp()
  mkdirSync(join(d, "moved"))
  writeFileSync(join(d, "moved", "owner.json"), "old")
  mkdirSync(join(d, "store.lock"))
  writeFileSync(join(d, "store.lock", "owner.json"), "live")
  await expect(io.rename(join(d, "moved"), join(d, "store.lock"))).rejects.toThrow()
  expect(readdirSync(join(d, "store.lock"))).toEqual(["owner.json"]) // nothing nested inside the live lock
  expect(readFileSync(join(d, "store.lock", "owner.json"), "utf8")).toBe("live")
  expect(readFileSync(join(d, "moved", "owner.json"), "utf8")).toBe("old") // the source is untouched
})

test("m1: an empty destination directory is refused as well, and so is a file onto a directory", async () => {
  const d = tmp()
  mkdirSync(join(d, "src"))
  mkdirSync(join(d, "dst"))
  await expect(io.rename(join(d, "src"), join(d, "dst"))).rejects.toThrow()
  expect(readdirSync(join(d, "dst"))).toEqual([])
  writeFileSync(join(d, "f"), "x")
  await expect(io.rename(join(d, "f"), join(d, "dst"))).rejects.toThrow()
  expect(readdirSync(join(d, "dst"))).toEqual([])
  expect(existsSync(join(d, "f"))).toBe(true)
})

test("rename still moves a directory to a free name and replaces an existing file", async () => {
  const d = tmp()
  mkdirSync(join(d, "a"))
  writeFileSync(join(d, "a", "x"), "1")
  await io.rename(join(d, "a"), join(d, "b"))
  expect(existsSync(join(d, "a"))).toBe(false)
  expect(readFileSync(join(d, "b", "x"), "utf8")).toBe("1")
  writeFileSync(join(d, "new"), "new")
  writeFileSync(join(d, "old"), "old")
  await io.rename(join(d, "new"), join(d, "old"))
  expect(readFileSync(join(d, "old"), "utf8")).toBe("new")
  expect(existsSync(join(d, "new"))).toBe(false)
})

test("rename of a missing source fails; paths with spaces and quotes survive the shell wrapper", async () => {
  const d = tmp()
  await expect(io.rename(join(d, "nope"), join(d, "x"))).rejects.toThrow()
  const odd = join(d, `it's a "file" $HOME`)
  writeFileSync(odd, "v")
  await io.rename(odd, join(d, "dst $x"))
  expect(readFileSync(join(d, "dst $x"), "utf8")).toBe("v")
})

test("copyFile makes a byte-identical copy (non-UTF-8 included) and leaves the source", async () => {
  const d = tmp()
  const raw = Buffer.from([0xff, 0xfe, 0x7b, 0x00, 0x80, 0x0a])
  writeFileSync(join(d, "src"), raw)
  await io.copyFile(join(d, "src"), join(d, "copy"))
  expect(readFileSync(join(d, "copy")).equals(raw)).toBe(true)
  expect(readFileSync(join(d, "src")).equals(raw)).toBe(true)
  // the copy survives the source being replaced (a hard link must not alias the later rename-over)
  writeFileSync(join(d, "next"), "other")
  await io.rename(join(d, "next"), join(d, "src"))
  expect(readFileSync(join(d, "copy")).equals(raw)).toBe(true)
})

test("a whole recovery through the mod IO on real files: quarantine byte-identical, nothing lost, bak = latest commit", async () => {
  const home = join(tmp(), "ttd")
  const store = createStore(io, home)
  const NOW = "2026-01-01T09:00:00.000Z"
  await store.apply({ op: "add", id: "a", title: "A" }, { now: NOW })
  await store.apply({ op: "add", id: "b", title: "B" }, { now: NOW })
  await store.apply({ op: "set_status", id: "b", status: "done" }, { now: NOW })
  const live = readFileSync(join(home, "todos.json"), "utf8")
  expect(readFileSync(join(home, "todos.json.bak"), "utf8")).toBe(live)
  const torn = live.slice(0, 40)
  writeFileSync(join(home, "todos.json"), torn)
  const r = await store.apply({ op: "add", id: "c", title: "C" }, { now: NOW })
  expect(r.ok && r.warnings).toEqual(["corrupt_quarantined", "restored_from_bak"])
  const d = JSON.parse(readFileSync(join(home, "todos.json"), "utf8"))
  expect(d.items.map((i: any) => [i.id, i.status])).toEqual([["a", "todo"], ["b", "done"], ["c", "todo"]])
  const q = readdirSync(home).filter((f) => f.startsWith("todos.corrupt-"))
  expect(q.length).toBe(1)
  expect(readFileSync(join(home, q[0]!), "utf8")).toBe(torn)
  expect(readdirSync(home).filter((f) => f.startsWith(".todos.json.tmp-"))).toEqual([])
})

// ---- M2: a non-UTF-8 todos.json is CORRUPT for the mod, never "absent" and never silently rewritten with U+FFFD ----

const NOW = "2026-01-01T09:00:00.000Z"
const docText = (title: string, rev = 3): string =>
  JSON.stringify({ schemaVersion: 1, rev, items: [{ id: "t1", title, body: "", status: "todo", order: 0, createdAt: NOW, updatedAt: NOW }] }, null, 2) + "\n"
/** valid JSON structure, but the title holds the lone bytes E2 82 (a torn 3-byte character) */
const invalidUtf8Doc = (): Buffer => {
  const t = Buffer.from(docText("AXB"))
  const i = t.indexOf("X")
  return Buffer.concat([t.subarray(0, i), Buffer.from([0xe2, 0x82]), t.subarray(i + 1)])
}

test("m2: readText returns the exact text of valid multi-byte UTF-8 (read as bytes, decoded strictly)", async () => {
  const d = tmp()
  const text = "Åäö 日本語 😀 \u{10FFFF} end\n"
  writeFileSync(join(d, "f"), text)
  expect(await io.readText(join(d, "f"))).toBe(text)
  expect(await io.readText(join(d, "missing"))).toBeNull()
})

test("m2: a host that answers { base64 } is decoded, not mapped to absent", async () => {
  const d = tmp()
  writeFileSync(join(d, "f"), "héllo")
  const b64Host: ModHost = { ...realHost, fs: { ...realHost.fs, async read(p) { return { base64: readFileSync(p).toString("base64") } } } }
  expect(await createModIO(b64Host, { windows: false }).readText(join(d, "f"))).toBe("héllo")
})

test("m2: invalid UTF-8 is returned as a value that never parses (so the engine sees CORRUPT, not absent)", async () => {
  const d = tmp()
  writeFileSync(join(d, "f"), invalidUtf8Doc())
  const raw = await io.readText(join(d, "f"))
  expect(raw).not.toBeNull()
  expect(parseDoc(raw!).kind).toBe("corrupt")
  expect(await io.readText(join(d, "f"))).toBe(raw) // deterministic: the engine's CAS compares two reads
  writeFileSync(join(d, "g"), Buffer.from([0xff, 0xfe, 0x00]))
  expect(parseDoc((await io.readText(join(d, "g")))!).kind).toBe("corrupt")
})

test("m2: a non-UTF-8 todos.json is quarantined byte-exact and the good bak restored, never overwritten", async () => {
  const home = join(tmp(), "ttd")
  mkdirSync(home, { recursive: true })
  const bad = invalidUtf8Doc()
  writeFileSync(join(home, "todos.json"), bad)
  writeFileSync(join(home, "todos.json.bak"), docText("Good"))
  const r = await createStore(io, home).apply({ op: "add", id: "x", title: "new" }, { now: NOW })
  expect(r.ok && r.warnings).toEqual(["corrupt_quarantined", "restored_from_bak"])
  const q = readdirSync(home).filter((f) => f.startsWith("todos.corrupt-"))
  expect(q.length).toBe(1)
  expect(readFileSync(join(home, q[0]!)).equals(bad)).toBe(true)
  const d = JSON.parse(readFileSync(join(home, "todos.json"), "utf8"))
  expect(d.items.map((i: any) => i.title)).toEqual(["Good", "new"])
})

test("m2: a non-UTF-8 todos.json with no bak is refused (corrupt_no_backup) and left untouched", async () => {
  const home = join(tmp(), "ttd")
  mkdirSync(home, { recursive: true })
  const bad = invalidUtf8Doc()
  writeFileSync(join(home, "todos.json"), bad)
  const r = await createStore(io, home).apply({ op: "add", id: "x", title: "new" }, { now: NOW })
  expect(r.ok === false && r.error).toBe("corrupt_no_backup")
  expect(readFileSync(join(home, "todos.json")).equals(bad)).toBe(true)
  expect(readdirSync(home)).toEqual(["todos.json"])
})
