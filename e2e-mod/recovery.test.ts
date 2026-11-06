// Corruption and locking through the mod's own IO (mkdir / mv / rm via $.process, files via $.fs).
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanup, files, op, readTodos, replayFixture, runClaude, say, tmpDir } from "./harness.ts"

setDefaultTimeout(180_000)
afterAll(cleanup)

test("d) corrupt file with a .bak: fixtures 06, 07, 14 and 15 paths through the mod (quarantine, restore, refuse, reset)", async () => {
  await Promise.all([
    replayFixture("06-corrupt-restore-from-bak.json"),
    replayFixture("07-corrupt-no-backup-refuse-then-reset.json"),
    replayFixture("14-corrupt-restore-keeps-last-status-flip.json"),
    replayFixture("15-corrupt-restore-from-stale-bak-warns.json"),
  ])
})

test("d2) /ttd recover resets a corrupt file that has no .bak; the bytes are quarantined", async () => {
  const home = join(tmpDir(), "ttd")
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, "todos.json"), "{not json")
  const list = await runClaude("/ttd list", { home })
  expect(list.code, say(list)).toBe(1)
  expect(list.out).toContain("corrupt")
  const rec = await runClaude("/ttd recover", { home })
  expect(rec.code, say(rec)).toBe(0)
  expect(readTodos(home)).toMatchObject({ schemaVersion: 1, rev: 1, items: [] })
  const q = files(home).filter((n) => n.startsWith("todos.corrupt-"))
  expect(q.length).toBe(1)
  expect(readFileSync(join(home, q[0]!), "utf8")).toBe("{not json")
})

test("d3) a todos.json that is not valid UTF-8 (but would parse after a lossy decode) is quarantined byte-exact, never overwritten", async () => {
  const home = join(tmpDir(), "ttd")
  mkdirSync(home, { recursive: true })
  const mk = (title: string) =>
    JSON.stringify({ schemaVersion: 1, rev: 3, items: [{ id: "t1", title, body: "", status: "todo", order: 0, createdAt: "2026-01-01T08:00:00.000Z", updatedAt: "2026-01-01T08:00:00.000Z" }] }, null, 2) + "\n"
  writeFileSync(join(home, "todos.json.bak"), mk("Good"))
  const t = Buffer.from(mk("AXB"))
  const i = t.indexOf("X")
  const bad = Buffer.concat([t.subarray(0, i), Buffer.from([0xe2, 0x82]), t.subarray(i + 1)]) // a torn 3-byte character inside a title
  writeFileSync(join(home, "todos.json"), bad)
  const r = await op(home, { op: "add", id: "x", title: "new" })
  expect(r.code, say(r)).toBe(0)
  expect(r.env.warnings, say(r)).toEqual(["corrupt_quarantined", "restored_from_bak"])
  const q = files(home).filter((n) => n.startsWith("todos.corrupt-"))
  expect(q.length).toBe(1)
  expect(readFileSync(join(home, q[0]!)).equals(bad)).toBe(true) // the damaged bytes survive untouched
  expect(readTodos(home).items.map((it: any) => it.title)).toEqual(["Good", "new"]) // no U+FFFD got baked into the list
  expect(readFileSync(join(home, "todos.json"), "utf8")).not.toContain("\ufffd")
})

test("e) a live lock held by someone else: lock_timeout, exit 1, file and foreign lock untouched", async () => {
  const home = join(tmpDir(), "ttd")
  const seeded = await op(home, { op: "add", id: "t1", title: "One" })
  expect(seeded.code, say(seeded)).toBe(0)
  const before = readFileSync(join(home, "todos.json"), "utf8")
  mkdirSync(join(home, "store.lock"))
  const owner = JSON.stringify({ token: "foreignlock1", pid: 1, ts: Date.now() })
  writeFileSync(join(home, "store.lock", "owner.json"), owner)

  const r = await op(home, { op: "add", title: "blocked" }, { TTD_LOCK_TIMEOUT_MS: "400", TTD_LOCK_STALE_MS: "600000" })
  expect(r.code, say(r)).toBe(1)
  expect(r.env).toEqual({ ok: false, error: "lock_timeout" })
  expect(readFileSync(join(home, "todos.json"), "utf8")).toBe(before)
  expect(existsSync(join(home, "store.lock"))).toBe(true)
  expect(readFileSync(join(home, "store.lock", "owner.json"), "utf8")).toBe(owner) // never removed
})

test("e2) fixtures 10 and 11 through the mod: a stale lock is broken, a fresh one times out", async () => {
  await Promise.all([replayFixture("10-stale-lock-broken.json"), replayFixture("11-fresh-lock-times-out.json")])
})
