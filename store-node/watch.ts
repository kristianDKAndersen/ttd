// STORE.md section 7 change detection: poll stat(todos.json) every intervalMs, read when (mtimeMs, size)
// differs or at least every forceReadMs, publish when the normalised result differs from the last published one.
import { stat } from "node:fs/promises"
import { createStore, joinPath } from "../plugin/hooks/store/index.ts"
import type { IO, ReadResult } from "../plugin/hooks/store/index.ts"
import { createNodeIO } from "./node-io.ts"

export interface WatchEvent {
  at: number // epoch ms of the read that observed the change
  result: ReadResult
}

export interface WatchOptions {
  homeDir: string
  onEvent: (e: WatchEvent) => void
  io?: IO
  intervalMs?: number // default 400
  forceReadMs?: number // default 2000
  maxEvents?: number // resolve `done` after this many events
  timeoutMs?: number // resolve `done` after this long
  statFile?: (path: string) => Promise<{ mtimeMs: number; size: number } | null>
}

export interface WatchHandle {
  stop(): void
  done: Promise<void> // resolves after stop(), maxEvents or timeoutMs
}

async function nodeStat(p: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const s = await stat(p)
    return { mtimeMs: s.mtimeMs, size: s.size }
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return null
    throw e
  }
}

const signature = (r: ReadResult): string => (r.ok ? "ok:" + JSON.stringify(r.doc) : "err:" + r.error)

// The CLI line for an event: {"rev","at","count"}; non-ok reads carry {"error","at"} instead of rev/count.
export function eventLine(e: WatchEvent): string {
  if (e.result.ok) return JSON.stringify({ rev: e.result.doc.rev, at: e.at, count: e.result.doc.items.length })
  return JSON.stringify({ error: e.result.error, at: e.at })
}

export function watchStore(o: WatchOptions): WatchHandle {
  const io = o.io ?? createNodeIO()
  const store = createStore(io, o.homeDir)
  const file = joinPath(o.homeDir, "todos.json")
  const interval = o.intervalMs ?? 400
  const force = o.forceReadMs ?? 2000
  const statFile = o.statFile ?? nodeStat
  let stopped = false
  const startedAt = io.now()

  const done = (async () => {
    let lastKey: string | null = null
    let lastSig: string | null = null
    let lastReadAt = -Infinity
    let events = 0
    while (!stopped) {
      let key: string
      try {
        const s = await statFile(file)
        key = s === null ? "absent" : `${s.mtimeMs}:${s.size}`
      } catch {
        key = "stat-error"
      }
      const t = io.now()
      // stat is taken before the read, so a change landing in between shows up as a key change next tick
      if (lastKey === null || key !== lastKey || t - lastReadAt >= force) {
        const result = await store.read()
        lastReadAt = io.now()
        const sig = signature(result)
        if (sig !== lastSig) {
          lastSig = sig
          events++
          if (!stopped) o.onEvent({ at: lastReadAt, result })
          if (o.maxEvents !== undefined && events >= o.maxEvents) return
        }
      }
      lastKey = key
      let wait = interval
      if (o.timeoutMs !== undefined) {
        const left = startedAt + o.timeoutMs - io.now()
        if (left <= 0) return
        wait = Math.min(wait, left)
      }
      await io.sleep(wait)
      if (o.timeoutMs !== undefined && io.now() - startedAt >= o.timeoutMs) return
    }
  })()

  return { stop: () => { stopped = true }, done }
}
