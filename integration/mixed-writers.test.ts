// The core promise: TS, Rust and the Claude Code mod writing one TTD_HOME at the same time lose nothing,
// and `rev` counts exactly the effective writes (STORE.md sections 3 and 5; plan claim C05).
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { join } from "node:path"
import { type Ack, apply, cleanupAll, debris, latencyReport, listDir, prng, rawDoc, readVia, say, titles, tmpHome, writerLoop } from "./support/index.ts"

setDefaultTimeout(600_000)
afterAll(cleanupAll)

const TS_PROCS = 3
const RS_PROCS = 3
const ADDS = 20
const MOD_PROCS = 2
const MOD_ADDS = 3
const MOVER_OPS = 30
const SEEDED = 8

test("3 TS x 20 + 3 Rust x 20 + 2 mod x 3 adds + filler writers + a move/set_status process: nothing lost, rev == initial + effective writes", async () => {
  const home = tmpHome()
  const rng = prng()
  console.log(`mixed-writers seed=${rng.seed} (replay with INTEGRATION_SEED=${rng.seed}) home=${home}`)

  const seedIds = Array.from({ length: SEEDED }, (_, i) => `seed${i + 1}`)
  for (const id of seedIds) {
    const a = await apply("ts", home, { op: "add", id, title: `seed-${id}` })
    expect(a.env?.ok, say(a)).toBe(true)
  }
  const initialRev = (await readVia("ts", home)).env.doc.rev
  expect(initialRev).toBe(SEEDED)

  const acks: Ack[] = []
  const statuses = ["in_progress", "done", "todo"]
  const mover = async () => {
    for (let i = 1; i <= MOVER_OPS; i++) {
      const impl = i % 4 < 2 ? "ts" : "rs"
      const id = rng.pick(seedIds)
      if (i % 2 === 1) acks.push(await apply(impl, home, { op: "set_status", id, status: statuses[(i >> 1) % 3] }))
      else {
        const others = [null, ...seedIds.filter((s) => s !== id)]
        acks.push(await apply(impl, home, { op: "move", id, after: rng.pick(others) }))
      }
    }
  }

  // Filler writers keep both CLIs hammering the lock for as long as the (slow, ~4 s per call) mod writers run,
  // so the mod's lock/commit windows really overlap TS and Rust writes instead of trailing them.
  let modsRunning = true
  const filler = async (impl: "ts" | "rs") => {
    for (let k = 1; modsRunning; k++) acks.push(await apply(impl, home, { op: "add", title: `fill-${impl}-${k}` }))
  }

  const t0 = Date.now()
  const mods = Promise.all(Array.from({ length: MOD_PROCS }, (_, p) => writerLoop("mod", home, MOD_ADDS, (n) => ({ op: "add", title: `mod-${p + 1}-${n}` }), acks))).finally(() => (modsRunning = false))
  await Promise.all([
    mods,
    filler("ts"),
    filler("rs"),
    ...Array.from({ length: TS_PROCS }, (_, p) => writerLoop("ts", home, ADDS, (n) => ({ op: "add", title: `ts-${p + 1}-${n}` }), acks)),
    ...Array.from({ length: RS_PROCS }, (_, p) => writerLoop("rs", home, ADDS, (n) => ({ op: "add", title: `rs-${p + 1}-${n}` }), acks)),
    mover(),
  ])
  console.log(`mixed-writers wall=${Date.now() - t0}ms ops=${acks.length}`)
  const modAcks = acks.filter((a) => a.impl === "mod")
  const overlapping = acks.filter((a) => a.impl !== "mod" && a.ackedAt > Math.min(...modAcks.map((m) => m.ackedAt - m.ms)) && a.ackedAt < Math.max(...modAcks.map((m) => m.ackedAt))).length
  console.log(`mixed-writers non-mod writes acked while a mod call was in flight: ${overlapping}`)
  expect(overlapping, "the mod must have overlapped other writers").toBeGreaterThan(50)
  console.log(`mixed-writers latency (per process, incl. startup): ${latencyReport(acks)}`)

  // every envelope: parsable, ok, exit 0, no warnings (a warning here would mean a recovery path fired unexpectedly)
  for (const a of acks) {
    expect(a.env, say(a)).toBeDefined()
    expect(a.env.ok, say(a)).toBe(true)
    expect(a.code, say(a)).toBe(0)
    expect(a.env.warnings ?? [], say(a)).toEqual([])
  }
  const attemptsSeen = acks.reduce<Record<number, number>>((m, a) => ((m[a.env.attempts] = (m[a.env.attempts] ?? 0) + 1), m), {})
  console.log(`mixed-writers attempts histogram: ${JSON.stringify(attemptsSeen)}`)

  const doc = rawDoc(home)
  const all = titles(doc)

  // every add present exactly once
  const expected: string[] = []
  for (let p = 1; p <= TS_PROCS; p++) for (let n = 1; n <= ADDS; n++) expected.push(`ts-${p}-${n}`)
  for (let p = 1; p <= RS_PROCS; p++) for (let n = 1; n <= ADDS; n++) expected.push(`rs-${p}-${n}`)
  for (let p = 1; p <= MOD_PROCS; p++) for (let n = 1; n <= MOD_ADDS; n++) expected.push(`mod-${p}-${n}`)
  for (const id of seedIds) expected.push(`seed-${id}`)
  for (const a of acks) if (a.op.op === "add" && a.op.title.startsWith("fill-")) expected.push(a.op.title)
  for (const t of expected) expect(all.filter((x) => x === t).length, `title ${t} must appear exactly once`).toBe(1)
  expect(all.length).toBe(expected.length)
  expect(new Set(doc.items.map((i: any) => i.id)).size).toBe(doc.items.length)

  // an acknowledged add returned the item that is on disk
  for (const a of acks.filter((x) => x.op.op === "add")) {
    const item = doc.items.find((i: any) => i.title === a.op.title)
    expect(a.env.result.item.id, say(a)).toBe(item.id)
  }

  // rev counts exactly the effective writes, each effective write got a distinct rev, and they are contiguous
  const changed = acks.filter((a) => a.env.changed === true)
  const sigma = changed.length
  const unchanged = acks.length - sigma
  console.log(`mixed-writers envelopes=${acks.length} changed:true=${sigma} changed:false=${unchanged} initial.rev=${initialRev} final.rev=${doc.rev}`)
  expect(doc.rev).toBe(initialRev + sigma)
  const revs = changed.map((a) => a.env.rev).sort((x, y) => x - y)
  expect(revs).toEqual(Array.from({ length: sigma }, (_, i) => initialRev + 1 + i))
  expect(changed.length).toBeGreaterThanOrEqual(TS_PROCS * ADDS + RS_PROCS * ADDS + MOD_PROCS * MOD_ADDS)

  // orders 0..n-1, file already normalised
  expect(doc.schemaVersion).toBe(1)
  expect(doc.items.map((i: any) => i.order)).toEqual(Array.from({ length: doc.items.length }, (_, i) => i))

  // valid and identical under both readers
  const [tsRead, rsRead] = [await readVia("ts", home), await readVia("rs", home)]
  expect(tsRead.code).toBe(0)
  expect(rsRead.code).toBe(0)
  expect(tsRead.env.ok).toBe(true)
  expect(rsRead.env.ok).toBe(true)
  expect(tsRead.env.doc).toEqual(doc)
  expect(rsRead.env.doc).toEqual(doc)

  // no lock, tmp or quarantine debris; only todos.json and its .bak remain
  expect(debris(home)).toEqual([])
  expect(listDir(home)).toEqual(["todos.json", "todos.json.bak"])
  expect(join(home, "todos.json")).toBeTruthy()
})
