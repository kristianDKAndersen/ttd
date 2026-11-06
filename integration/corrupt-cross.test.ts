// A half-written todos.json is never overwritten or silently dropped (STORE.md section 8; plan claim C07).
// With a valid .bak every implementation recovers; without one every implementation refuses until reset_corrupt.
//
// .bak is a byte-identical copy of the LATEST committed todos.json (STORE.md section 8), so restoring from it loses
// no acknowledged write at all: every round ends the clean history with a status flip, written by one implementation,
// destroys the file, recovers with another implementation, and then asserts the flip is still there.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readFileSync, truncateSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { apply, cleanupAll, debris, listDir, quarantined, rawDoc, readVia, say, titles, tmpHome } from "./support/index.ts"

setDefaultTimeout(900_000)
afterAll(cleanupAll)

const todos = (home: string) => join(home, "todos.json")
const bak = (home: string) => join(home, "todos.json.bak")

function truncateToHalf(home: string): string {
  const size = statSync(todos(home)).size
  truncateSync(todos(home), Math.floor(size / 2))
  return readFileSync(todos(home), "utf8")
}

const IMPLS = ["ts", "rs", "mod"] as const

test("truncated todos.json + valid .bak: each of TS, Rust and the mod restores, warns, quarantines the exact bytes and loses no acknowledged item", async () => {
  const home = tmpHome()
  const acked: string[] = []
  const truncations: string[] = []
  let rev = 0

  for (const a of ["one", "two", "three", "four"]) {
    const r = await apply("ts", home, { op: "add", id: `id-${a}`, title: `base-${a}` })
    expect(r.env?.ok, say(r)).toBe(true)
    acked.push(`base-${a}`)
    rev = r.env.rev
  }

  const flipped: string[] = []
  for (const [i, writer] of IMPLS.entries()) {
    const impl = IMPLS[(i + 1) % IMPLS.length]! // the implementation that recovers; the writer is a different one
    // a clean add and then a clean status flip: the flip is the LAST acknowledged write before the corruption
    const clean = await apply(writer, home, { op: "add", id: `clean-${writer}`, title: `clean-${writer}` })
    expect(clean.env?.ok, say(clean)).toBe(true)
    acked.push(`clean-${writer}`)
    const flip = await apply(writer, home, { op: "set_status", id: `clean-${writer}`, status: "in_progress" })
    expect(flip.env?.ok, say(flip)).toBe(true)
    expect(flip.env.changed).toBe(true)
    flipped.push(`clean-${writer}`)
    rev = flip.env.rev
    expect(rawDoc(home).rev).toBe(rev)
    const bakBefore = readFileSync(bak(home), "utf8")
    expect(bakBefore, `${writer}: bak is a byte-identical copy of the latest commit`).toBe(readFileSync(todos(home), "utf8"))
    expect(JSON.parse(bakBefore).rev).toBe(rev)

    const cut = truncateToHalf(home)
    truncations.push(cut)
    expect(() => JSON.parse(cut)).toThrow()
    const quarantineBefore = quarantined(home)

    const r = await apply(impl, home, { op: "add", title: `recovered-by-${impl}` })
    expect(r.env?.ok, say(r)).toBe(true)
    expect(r.code, say(r)).toBe(0)
    expect(r.env.changed).toBe(true)
    expect([...r.env.warnings].sort(), say(r)).toEqual(["corrupt_quarantined", "restored_from_bak"])
    expect(r.env.rev, "rev never repeats a value a live window may have shown: scraped rev + 1").toBe(rev + 1)
    rev = r.env.rev
    acked.push(`recovered-by-${impl}`)

    // the corrupt bytes were quarantined byte-identical, once; the .bak never held corrupt content and now equals the new commit
    const newQ = quarantined(home).filter((q) => !quarantineBefore.includes(q))
    expect(newQ.length, `${impl}: exactly one new quarantine file`).toBe(1)
    expect(readFileSync(join(home, newQ[0]!), "utf8")).toBe(cut)
    expect(readFileSync(bak(home), "utf8"), `${impl}: .bak equals the restored commit`).toBe(readFileSync(todos(home), "utf8"))

    const doc = rawDoc(home) // the file parses again
    expect(doc.rev).toBe(rev)
    // NO acknowledged write is lost: every status flip so far, including the one just before the corruption, survived
    for (const id of flipped) {
      expect(doc.items.find((it: any) => it.id === id)?.status, `${impl}: the acknowledged status flip of ${id} must survive`).toBe("in_progress")
    }
    for (const t of acked) expect(titles(doc).filter((x) => x === t).length, `${impl}: "${t}" must be present exactly once`).toBe(1)
    expect(doc.items.length, impl).toBe(acked.length)
    expect(doc.items.map((i: any) => i.order)).toEqual(Array.from({ length: doc.items.length }, (_, i) => i))
    expect(existsSync(join(home, "store.lock"))).toBe(false)
    expect(listDir(home).filter((n) => n.startsWith(".todos.json.tmp-"))).toEqual([])
    for (const reader of ["ts", "rs"] as const) {
      const rd = await readVia(reader, home)
      expect(rd.env.ok, `${impl} then ${reader} read`).toBe(true)
      expect(rd.env.doc).toEqual(doc)
    }
    console.log(`corrupt-cross ${writer} wrote, ${impl} restored: rev ${rev - 1} -> ${rev}, quarantined ${cut.length} bytes, ${doc.items.length} items intact`)
  }

  const q = quarantined(home)
  expect(q.length).toBe(IMPLS.length)
  expect(q.map((n) => readFileSync(join(home, n), "utf8")).sort()).toEqual([...truncations].sort())
})

test("truncated todos.json without .bak: TS, Rust and the mod all refuse with corrupt_no_backup, change nothing; reset_corrupt then recovers", async () => {
  const home = tmpHome()
  let revBefore = 0
  for (const a of ["a", "b", "c"]) {
    const r = await apply("rs", home, { op: "add", title: `pre-${a}` })
    expect(r.env?.ok, say(r)).toBe(true)
    revBefore = r.env.rev
  }

  let resets = 0
  for (const resetter of IMPLS) {
    const cut = truncateToHalf(home)
    rmSync(bak(home), { force: true })
    const listing = listDir(home)

    for (const impl of IMPLS) {
      const r = await apply(impl, home, { op: "add", title: `refused-${impl}` })
      expect(r.env, say(r)).toEqual({ ok: false, error: "corrupt_no_backup" })
      expect(r.code, say(r)).toBe(1)
      expect(readFileSync(todos(home), "utf8"), `${impl}: todos.json must stay exactly as found`).toBe(cut)
      expect(listDir(home), `${impl}: nothing written, moved or left behind`).toEqual(listing)
    }
    // reads report corrupt and never touch anything
    for (const reader of ["ts", "rs"] as const) {
      const rd = await readVia(reader, home)
      expect(rd.code).toBe(1)
      expect(rd.env).toMatchObject({ ok: false, error: "corrupt" })
    }
    expect(listDir(home)).toEqual(listing)

    // an explicit reset quarantines the bytes and starts a fresh empty doc above the scraped rev
    const scraped = Number(/"rev"\s*:\s*(\d+)/.exec(cut)![1])
    const r = await apply(resetter, home, { op: "reset_corrupt" })
    expect(r.env?.ok, say(r)).toBe(true)
    expect(r.code, say(r)).toBe(0)
    expect(r.env.warnings ?? [], say(r)).toEqual(["corrupt_quarantined"])
    expect(r.env.rev).toBe(scraped + 1)
    const doc = rawDoc(home)
    expect(doc).toMatchObject({ schemaVersion: 1, rev: scraped + 1, items: [] })
    expect(quarantined(home).length).toBe(++resets)
    expect(quarantined(home).map((n) => readFileSync(join(home, n), "utf8"))).toContain(cut)
    expect(existsSync(join(home, "store.lock"))).toBe(false)

    // and the store works again for everybody
    for (const impl of IMPLS) {
      const w = await apply(impl, home, { op: "add", title: `after-reset-${resetter}-${impl}` })
      expect(w.env?.ok, say(w)).toBe(true)
      expect(w.env.warnings ?? []).toEqual([])
    }
    expect(titles(rawDoc(home))).toEqual(IMPLS.map((i) => `after-reset-${resetter}-${i}`))
    for (const reader of ["ts", "rs"] as const) expect((await readVia(reader, home)).env.ok).toBe(true)
    console.log(`corrupt-cross no-bak: ${IMPLS.join("+")} refused, reset_corrupt by ${resetter} -> rev ${scraped + 1}`)
    revBefore = rawDoc(home).rev
  }
  expect(debris(home).filter((n) => !n.startsWith("todos.corrupt-"))).toEqual([])
  expect(revBefore).toBeGreaterThan(3)
})
