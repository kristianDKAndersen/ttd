// Stale-lock break-vs-break race (STORE.md section 5, "Breaking a stale lock"): two waiters judge the same
// stale owner.json; the loser of the rename race must not rename the winner's FRESH lock away.
import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStore } from "../../plugin/hooks/store/index.ts"
import type { IO } from "../../plugin/hooks/store/index.ts"
import { createNodeIO } from "../node-io.ts"

const CLI = join(import.meta.dir, "../cli.ts")
const homes: string[] = []
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }) })
const tmpHome = (): string => {
  const h = mkdtempSync(join(tmpdir(), "ttd-race-"))
  homes.push(h)
  return h
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const NOW = "2026-01-01T09:00:00.000Z"
const add = (title: string) => ({ op: "add" as const, title })
const staleLock = (home: string, token = "dead") => {
  mkdirSync(join(home, "store.lock"), { recursive: true })
  writeFileSync(join(home, "store.lock", "owner.json"), JSON.stringify({ token, pid: 1, ts: Date.now() - 600000 }))
}
const readDoc = (home: string) => JSON.parse(readFileSync(join(home, "todos.json"), "utf8")) as { rev: number; items: { title: string }[] }
const leftovers = (home: string) => readdirSync(home).filter((f) => f !== "todos.json" && f !== "todos.json.bak")

test("deterministic: a breaker paused between its judgement and its rename never takes the fresh lock", async () => {
  const home = tmpHome()
  staleLock(home)
  const base = createNodeIO()
  let inside = 0
  let maxInside = 0
  const holdLock = async () => {
    inside++
    maxInside = Math.max(maxInside, inside)
    await sleep(80)
    inside--
  }
  let paused = false
  // B: pauses just before renaming store.lock away, until a fresh lock exists (or 400 ms pass).
  const ioB: IO = {
    ...base,
    async rename(from, to) {
      if (from.endsWith("store.lock") && !paused) {
        paused = true
        const t0 = Date.now()
        while (Date.now() - t0 < 400) {
          const raw = await base.readText(join(home, "store.lock", "owner.json")).catch(() => null)
          if (raw !== null && !raw.includes('"dead"')) break
          await sleep(5)
        }
      }
      return base.rename(from, to)
    },
  }
  const pB = createStore(ioB, home, { lockStaleMs: 1000 }).apply(add("b"), { now: NOW, beforeCommit: holdLock })
  while (!paused) await sleep(2)
  const pA = createStore(base, home, { lockStaleMs: 1000 }).apply(add("a"), { now: NOW, beforeCommit: holdLock })
  const [rA, rB] = await Promise.all([pA, pB])
  expect(rA.ok && rB.ok).toBe(true)
  expect(maxInside).toBe(1)
  expect(readDoc(home).rev).toBe(2)
  expect(leftovers(home)).toEqual([])
}, 20000)

test("in-process: 8 concurrent writers over a stale lock, 40 rounds, never two holders", async () => {
  const io = createNodeIO()
  for (let round = 0; round < 40; round++) {
    const home = tmpHome()
    staleLock(home)
    let inside = 0
    let maxInside = 0
    const hold = async () => {
      inside++
      maxInside = Math.max(maxInside, inside)
      await sleep(2)
      inside--
    }
    const store = createStore(io, home, { lockStaleMs: 300, lockTimeoutMs: 20000 })
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => store.apply(add(`t${i}`), { now: NOW, beforeCommit: hold })))
    for (const r of rs) expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(maxInside, `round ${round}`).toBe(1)
    const d = readDoc(home)
    expect(d.rev, `round ${round}`).toBe(8)
    expect(d.items.map((i) => i.title).sort()).toEqual(Array.from({ length: 8 }, (_, i) => `t${i}`))
    expect(leftovers(home)).toEqual([])
  }
}, 120000)

test("real processes: 6 CLI adds race over one stale lock, 30 rounds, every add present and rev == count", async () => {
  const N = 6
  for (let round = 0; round < 30; round++) {
    const home = tmpHome()
    staleLock(home)
    const procs = Array.from({ length: N }, (_, i) =>
      Bun.spawn([process.execPath, CLI, "apply", JSON.stringify(add(`p${i}`))], {
        env: { ...process.env, TTD_HOME: home, TTD_LOCK_STALE_MS: "300", TTD_LOCK_TIMEOUT_MS: "20000" },
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    const codes = await Promise.all(procs.map((p) => p.exited))
    const outs = await Promise.all(procs.map((p) => new Response(p.stdout).text()))
    const errs = await Promise.all(procs.map((p) => new Response(p.stderr).text()))
    expect(codes, `round ${round}: ${outs.join("")} ${errs.join("")}`).toEqual(Array(N).fill(0))
    const d = readDoc(home)
    expect(d.items.map((i) => i.title).sort(), `round ${round}`).toEqual(Array.from({ length: N }, (_, i) => `p${i}`))
    expect(d.rev, `round ${round}`).toBe(N)
    expect(existsSync(join(home, "store.lock")), `round ${round}`).toBe(false)
    expect(existsSync(join(home, "store.lock.break")), `round ${round}`).toBe(false)
  }
}, 240000)

test("a fresh store.lock.break is respected (breaker waits), a stale one left by a crashed breaker is cleared", async () => {
  const home = tmpHome()
  staleLock(home)
  mkdirSync(join(home, "store.lock.break"))
  // fresh guard: nobody may break, the stale lock stays, the writer times out
  let r = await createStore(createNodeIO(), home, { lockStaleMs: 400, lockTimeoutMs: 250 }).apply(add("a"), { now: NOW })
  expect(r).toEqual({ ok: false, error: "lock_timeout" })
  expect(existsSync(join(home, "store.lock", "owner.json"))).toBe(true)
  // old guard (crashed breaker): cleared, then the break proceeds
  utimesSync(join(home, "store.lock.break"), 1, 1)
  r = await createStore(createNodeIO(), home, { lockStaleMs: 400, lockTimeoutMs: 5000 }).apply(add("a"), { now: NOW })
  expect(r.ok && r.warnings).toEqual(["stale_lock_broken"])
  expect(leftovers(home)).toEqual([])
})

test("breaker verifies what it renamed: a live lock swapped in after the judgement is put back, not claimed", async () => {
  const home = tmpHome()
  staleLock(home)
  const base = createNodeIO()
  const live = JSON.stringify({ token: "livelivelive", pid: 2, ts: Date.now() })
  let swapped = false
  const io: IO = {
    ...base,
    async rename(from, to) {
      if (from.endsWith("store.lock") && !swapped) {
        swapped = true
        rmSync(join(home, "store.lock"), { recursive: true }) // the stale owner released late ...
        mkdirSync(join(home, "store.lock"))
        writeFileSync(join(home, "store.lock", "owner.json"), live) // ... and a fresh writer took the lock
      }
      return base.rename(from, to)
    },
  }
  const r = await createStore(io, home, { lockStaleMs: 1000, lockTimeoutMs: 300 }).apply(add("a"), { now: NOW })
  expect(r).toEqual({ ok: false, error: "lock_timeout" })
  expect(readFileSync(join(home, "store.lock", "owner.json"), "utf8")).toBe(live)
  expect(readdirSync(home).filter((f) => f.startsWith("store.lock.stale-"))).toEqual([])
  expect(existsSync(join(home, "store.lock.break"))).toBe(false)
})
