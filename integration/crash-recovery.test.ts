// Dead lock holders and kill -9 (STORE.md sections 5 and 8; plan claim C06).
// "Acknowledged" means the add's envelope reached the test's stdout reader; such an add must survive any crash.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { type Ack, apply, cleanupAll, cliArgv, cliEnv, debris, lastJson, listDir, plantDeadLock, prng, rawDoc, readVia, say, sleep, titles, tmpHome } from "./support/index.ts"

setDefaultTimeout(900_000)
afterAll(cleanupAll)

const STALE = { TTD_LOCK_STALE_MS: "1500" }

test("a lock whose owner is dead is broken by TS, Rust and the mod: ok, stale_lock_broken, add present, lock gone", async () => {
  const home = tmpHome()
  let rev = 0
  for (const impl of ["ts", "rs", "mod"] as const) {
    const dead = plantDeadLock(home)
    const t0 = Date.now()
    const a = await apply(impl, home, { op: "add", title: `after-dead-lock-${impl}` }, STALE)
    expect(a.env?.ok, say(a)).toBe(true)
    expect(a.code, say(a)).toBe(0)
    expect(a.env.warnings, say(a)).toEqual(["stale_lock_broken"])
    expect(a.env.changed).toBe(true)
    expect(a.env.rev).toBe(++rev)
    expect(existsSync(join(home, "store.lock")), `${impl}: lock must be gone`).toBe(false)
    expect(existsSync(join(home, "store.lock.break")), `${impl}: break guard must be gone`).toBe(false)
    expect(debris(home), impl).toEqual([])
    console.log(`crash-recovery dead-lock (pid ${dead.pid}) broken by ${impl} in ${Date.now() - t0} ms`)
  }
  expect(titles(rawDoc(home))).toEqual(["after-dead-lock-ts", "after-dead-lock-rs", "after-dead-lock-mod"])
  expect(rawDoc(home).rev).toBe(3)
})

test("a dead lock with several concurrent writers: every add lands, rev == effective writes, the lock is broken exactly once", async () => {
  const home = tmpHome()
  plantDeadLock(home)
  const jobs: Promise<Ack>[] = []
  for (let i = 1; i <= 4; i++) jobs.push(apply("ts", home, { op: "add", title: `race-ts-${i}` }, STALE))
  for (let i = 1; i <= 4; i++) jobs.push(apply("rs", home, { op: "add", title: `race-rs-${i}` }, STALE))
  jobs.push(apply("mod", home, { op: "add", title: "race-mod-1" }, STALE))
  const acks = await Promise.all(jobs)
  for (const a of acks) {
    expect(a.env?.ok, say(a)).toBe(true)
    expect(a.code, say(a)).toBe(0)
  }
  const broke = acks.filter((a) => (a.env.warnings ?? []).includes("stale_lock_broken"))
  console.log(`crash-recovery dead-lock race: broken by ${broke.map((a) => a.impl).join(",")}`)
  expect(broke.length, "exactly one writer breaks a given stale lock").toBe(1)
  for (const a of acks) expect((a.env.warnings ?? []).filter((w: string) => w !== "stale_lock_broken")).toEqual([])
  const doc = rawDoc(home)
  expect(titles(doc).sort()).toEqual(acks.map((a) => a.op.title).sort())
  expect(doc.rev).toBe(acks.length)
  expect(debris(home)).toEqual([])
})

/** Reads complete lines from a child's stdout; an envelope counts as acknowledged only once its newline arrived. */
function collectLines(stream: ReadableStream<Uint8Array>, onLine: (l: string) => void): Promise<void> {
  return (async () => {
    const dec = new TextDecoder()
    let buf = ""
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true })
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
      }
    }
  })()
}

test("kill -9 of TS and Rust writers mid-run, then more writes from every implementation: valid file, no acknowledged add lost", async () => {
  const home = tmpHome()
  const rng = prng()
  console.log(`crash-recovery seed=${rng.seed} (replay with INTEGRATION_SEED=${rng.seed}) home=${home}`)
  const ROUNDS = 8
  const acked = new Set<string>() // titles whose envelope reached stdout, ok:true
  const ackedRevs: number[] = []
  const attempted = new Set<string>()
  let killedMidLock = 0
  let staleBreaks = 0
  const note = (title: string, line: string) => {
    const env = lastJson(line)
    if (env?.ok === true && env.changed === true) {
      acked.add(title)
      ackedRevs.push(env.rev)
    }
  }
  const noteFollow = (a: Ack) => {
    attempted.add(a.op.title)
    expect(a.env?.ok, say(a)).toBe(true) // a follow-up write after a crash must succeed (stale lock broken within the 5 s timeout)
    acked.add(a.op.title)
    ackedRevs.push(a.env.rev)
    if ((a.env.warnings ?? []).includes("stale_lock_broken")) staleBreaks++
  }

  for (let round = 1; round <= ROUNDS; round++) {
    if (round % 2 === 1) {
      // TS: one process looping adds, killed after a random number of acknowledgements plus a random extra delay
      const prefix = `tsk-${round}`
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "support/ts-loop.ts"), prefix, "100000"], { env: cliEnv(home, STALE), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      let n = 0
      const reader = collectLines(proc.stdout, (l) => note(`${prefix}-${++n}`, l))
      const target = 2 + Math.floor(rng.next() * 40)
      while (n < target && proc.exitCode === null) await sleep(1)
      await sleep(Math.floor(rng.next() * 12))
      proc.kill("SIGKILL")
      await proc.exited
      await reader
      for (let i = 1; i <= n + 1; i++) attempted.add(`${prefix}-${i}`) // the in-flight add may or may not have committed
    } else {
      // Rust: sequential one-shot processes, the k-th is killed a few ms after it started
      const prefix = `rsk-${round}`
      const k = 1 + Math.floor(rng.next() * 4)
      for (let i = 1; i <= k; i++) {
        const title = `${prefix}-${i}`
        attempted.add(title)
        const proc = Bun.spawn(cliArgv("rs", "apply", JSON.stringify({ op: "add", title })), { env: cliEnv(home, STALE), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
        let line = ""
        const reader = collectLines(proc.stdout, (l) => (line = l))
        if (i === k) {
          await sleep(1 + Math.floor(rng.next() * 18))
          proc.kill("SIGKILL")
        }
        await proc.exited
        await reader
        if (line) note(title, line)
      }
    }
    if (existsSync(join(home, "store.lock"))) killedMidLock++
    // more writes right after the crash, rotating the implementation; the first one has to deal with whatever was left
    const impl = (["rs", "ts", "mod"] as const)[round % 3]!
    noteFollow(await apply(impl, home, { op: "add", title: `follow-${round}-${impl}` }, STALE))
  }

  // a last write from each implementation
  for (const impl of ["ts", "rs", "mod"] as const) noteFollow(await apply(impl, home, { op: "add", title: `final-${impl}` }, STALE))

  console.log(`crash-recovery rounds=${ROUNDS} acked=${acked.size} attempted=${attempted.size} lockLeftBehindByKill=${killedMidLock} staleLockBreaksSeen=${staleBreaks}`)
  console.log(`crash-recovery leftover tmp files (a killed writer may leave one; not swept by contract): ${listDir(home).filter((n) => n.startsWith(".todos.json.tmp-")).length}`)

  const doc = rawDoc(home)
  const have = titles(doc)
  expect(new Set(have).size, "no item twice").toBe(have.length)
  const missing = [...acked].filter((t) => !have.includes(t))
  expect(missing, "acknowledged adds that are missing").toEqual([])
  // anything present that was never acknowledged must at least be an add we attempted (committed, killed before the line left)
  const unknown = have.filter((t) => !acked.has(t) && !attempted.has(t))
  expect(unknown, "items nobody tried to add").toEqual([])
  // every write that landed is an add: rev == item count
  expect(doc.rev).toBe(doc.items.length)
  expect(new Set(ackedRevs).size, "an acknowledged rev was handed out twice").toBe(ackedRevs.length)
  expect(doc.items.map((i: any) => i.order)).toEqual(Array.from({ length: doc.items.length }, (_, i) => i))
  expect(listDir(home).filter((n) => n.startsWith("todos.corrupt-")), "an atomic writer killed mid-run must never corrupt the file").toEqual([])
  expect(existsSync(join(home, "store.lock"))).toBe(false)
  expect(existsSync(join(home, "store.lock.break"))).toBe(false)
  for (const impl of ["ts", "rs"] as const) {
    const r = await readVia(impl, home)
    expect(r.env.ok).toBe(true)
    expect(r.env.doc).toEqual(doc)
  }
})
