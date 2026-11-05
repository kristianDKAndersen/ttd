// A half-written todos.json is never overwritten or silently dropped (STORE.md section 8; plan claim C07).
// With a valid .bak every implementation recovers; without one every implementation refuses until reset_corrupt.
//
// What "no acknowledged item is lost" can mean here: .bak is the file as it was just BEFORE the last commit, so the
// effect of that single last commit lives only in the destroyed bytes. Each round therefore ends the clean history
// with a set_status (it changes no item set), so any lost state is a status flip, never an acknowledged item.
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

  for (const impl of IMPLS) {
    // a clean add (acknowledged), then a clean status flip, so that .bak holds every item
    const clean = await apply("ts", home, { op: "add", id: `clean-${impl}`, title: `clean-${impl}` })
    expect(clean.env?.ok, say(clean)).toBe(true)
    acked.push(`clean-${impl}`)
    const flip = await apply("ts", home, { op: "set_status", id: `clean-${impl}`, status: "in_progress" })
    expect(flip.env?.ok, say(flip)).toBe(true)
    expect(flip.env.changed).toBe(true)
    rev = flip.env.rev
    expect(rawDoc(home).rev).toBe(rev)
    const bakBefore = readFileSync(bak(home), "utf8")
    expect(JSON.parse(bakBefore).rev, "bak is the state before the last commit").toBe(rev - 1)

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

    // the corrupt bytes were quarantined byte-identical, once; the .bak was left as found
    const newQ = quarantined(home).filter((q) => !quarantineBefore.includes(q))
    expect(newQ.length, `${impl}: exactly one new quarantine file`).toBe(1)
    expect(readFileSync(join(home, newQ[0]!), "utf8")).toBe(cut)
    expect(readFileSync(bak(home), "utf8"), `${impl}: .bak must not be overwritten with corrupt content`).toBe(bakBefore)

    const doc = rawDoc(home) // the file parses again
    expect(doc.rev).toBe(rev)
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
    console.log(`corrupt-cross restore by ${impl}: rev ${rev - 1} -> ${rev}, quarantined ${cut.length} bytes, ${doc.items.length} items intact`)
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
