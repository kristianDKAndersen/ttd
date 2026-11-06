// Change detection across implementations (STORE.md section 7): a TS watcher and a Rust watcher, as separate
// processes, observe writes made by the other implementation and by the mod. Intermediate revs may coalesce;
// the final rev must be reported within 3 s of the last write.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { join } from "node:path"
import { apply, cleanupAll, cliArgv, cliEnv, mtimeMs, rawDoc, say, sleep, tmpHome, writerLoop, type Ack, type Impl } from "./support/index.ts"

setDefaultTimeout(600_000)
afterAll(cleanupAll)

const BOUND_MS = 3000

interface Seen {
  rev: number
  count: number
  at: number
  /** when the line reached the test */
  t: number
}

function startWatcher(kind: "ts" | "rs", home: string) {
  const proc = Bun.spawn(cliArgv(kind, "watch", "--timeout-ms", "300000"), { env: cliEnv(home), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const events: Seen[] = []
  const bad: string[] = []
  ;(async () => {
    const dec = new TextDecoder()
    let buf = ""
    for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true })
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        const t = Date.now()
        try {
          const j = JSON.parse(line)
          if (typeof j.rev === "number") events.push({ rev: j.rev, count: j.count, at: j.at, t })
          else bad.push(line)
        } catch {
          bad.push(line)
        }
      }
    }
  })()
  return {
    kind,
    events,
    bad,
    /** the first event reporting `rev`, or undefined after `waitMs` */
    async reported(rev: number, waitMs: number): Promise<Seen | undefined> {
      const end = Date.now() + waitMs
      for (;;) {
        const hit = events.find((e) => e.rev === rev)
        if (hit || Date.now() > end) return hit
        await sleep(20)
      }
    },
    stop() {
      proc.kill("SIGTERM")
    },
  }
}

test("TS and Rust watchers both report the final rev within 3 s of the last write, whoever wrote it", async () => {
  const home = tmpHome()
  const seed = await apply("ts", home, { op: "add", title: "seed" })
  expect(seed.env?.ok, say(seed)).toBe(true)

  const watchers = [startWatcher("ts", home), startWatcher("rs", home)]
  const lat: Record<string, number[]> = {}
  try {
    // each watcher publishes the initial state first
    for (const w of watchers) expect(await w.reported(1, 5000), `${w.kind} initial event`).toBeDefined()

    let expectedCount = 1
    const check = async (label: string, last: Ack[]) => {
      const doc = rawDoc(home)
      expect(doc.items.length, label).toBe(expectedCount)
      const lastWriteAt = mtimeMs(join(home, "todos.json")) // when the last rename landed, not when its process exited
      for (const w of watchers) {
        const hit = await w.reported(doc.rev, BOUND_MS + 1500)
        expect(hit, `${label}: ${w.kind} watcher never reported rev ${doc.rev}; saw ${w.events.map((e) => e.rev).join(",")}`).toBeDefined()
        const ms = hit!.t - lastWriteAt
        ;(lat[label] ??= []).push(ms)
        expect(ms, `${label}: ${w.kind} watcher reported rev ${doc.rev} ${ms} ms after the last write`).toBeLessThanOrEqual(BOUND_MS)
        expect(hit!.count, `${label}: ${w.kind} count`).toBe(doc.items.length)
      }
      for (const a of last) expect(a.env?.ok, say(a)).toBe(true)
    }

    // 1) a burst of concurrent TS and Rust writers (coalescing allowed)
    const burst: Ack[] = []
    await Promise.all([
      ...[1, 2, 3].map((p) => writerLoop("ts", home, 6, (n) => ({ op: "add", title: `burst-ts-${p}-${n}` }), burst)),
      ...[1, 2, 3].map((p) => writerLoop("rs", home, 6, (n) => ({ op: "add", title: `burst-rs-${p}-${n}` }), burst)),
    ])
    expectedCount += burst.length
    await check("burst ts+rs", burst)

    // 2) the mod writes (two calls, concurrent with a Rust writer), then each implementation writes last in turn
    const m: Ack[] = []
    await Promise.all([
      writerLoop("mod", home, 1, (n) => ({ op: "add", title: `watch-mod-a-${n}` }), m),
      writerLoop("mod", home, 1, (n) => ({ op: "add", title: `watch-mod-b-${n}` }), m),
      writerLoop("rs", home, 5, (n) => ({ op: "add", title: `watch-rs-bg-${n}` }), m),
    ])
    expectedCount += m.length
    await check("mod last-ish (+rs)", m)

    for (const impl of ["ts", "rs", "mod"] as Impl[]) {
      const one: Ack[] = []
      await writerLoop(impl, home, 1, (n) => ({ op: "add", title: `last-${impl}-${n}` }), one)
      expectedCount += 1
      await check(`last write by ${impl}`, one)
    }

    // events are strictly increasing in rev and the watchers agree on the end state
    for (const w of watchers) {
      expect(w.bad, `${w.kind} unparsable/error lines`).toEqual([])
      const revs = w.events.map((e) => e.rev)
      expect(revs, `${w.kind} revs`).toEqual([...revs].sort((a, b) => a - b))
      expect(new Set(revs).size).toBe(revs.length)
    }
    const finalRev = rawDoc(home).rev
    expect(watchers[0]!.events.at(-1)!.rev).toBe(finalRev)
    expect(watchers[1]!.events.at(-1)!.rev).toBe(finalRev)
    for (const [label, ms] of Object.entries(lat)) console.log(`watcher-observes ${label}: last-write -> event ms (ts,rs) = ${ms.join(", ")}`)
    console.log(`watcher-observes events seen: ts=${watchers[0]!.events.length} rs=${watchers[1]!.events.length} finalRev=${finalRev}`)
  } finally {
    for (const w of watchers) w.stop()
  }
})
