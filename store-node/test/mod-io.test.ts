// The mod's IO adapter (plugin/hooks/mod-io.ts) against REAL files and directories: the host is a thin node
// wrapper over fs and child_process, so `mv`, `ln`, `mkdir` and `rm` really run (STORE.md section 12).
import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createModIO } from "../../plugin/hooks/mod-io.ts"
import type { ModHost } from "../../plugin/hooks/mod-io.ts"
import { createStore } from "../../plugin/hooks/store/index.ts"

const roots: string[] = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })
const tmp = (): string => {
  const r = mkdtempSync(join(tmpdir(), "ttd-modio-"))
  roots.push(r)
  return r
}

const realHost: ModHost = {
  fs: {
    async read(p) { return readFileSync(p, "utf8") },
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
