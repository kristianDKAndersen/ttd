// CLI per STORE.md section 9: `read`, `apply '<op json>' [--now <iso>]`, `watch [...]`. One JSON document per line.
import { createStore, resolveHomeDir } from "../plugin/hooks/store/index.ts"
import type { Op, StoreOptions } from "../plugin/hooks/store/index.ts"
import { createNodeIO } from "./node-io.ts"
import { eventLine, watchStore } from "./watch.ts"

type Env = Record<string, string | undefined>

const USAGE = `usage: cli.ts read
       cli.ts apply '<op json>' [--now <iso>]
       cli.ts watch [--interval-ms 400] [--max-events N] [--timeout-ms T]
env: TTD_HOME, TTD_LOCK_TIMEOUT_MS, TTD_LOCK_STALE_MS`

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function posInt(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} needs a non-negative integer`)
  return n
}

export async function main(argv: string[], env: Env, out: (line: string) => void, err: (line: string) => void): Promise<number> {
  const [cmd, ...rest] = argv
  const home = resolveHomeDir({ TTD_HOME: env.TTD_HOME, USERPROFILE: env.USERPROFILE, HOME: env.HOME })
  if (!cmd || !["read", "apply", "watch"].includes(cmd)) {
    err(USAGE)
    return 2
  }
  if (!home) {
    err("cannot resolve the TTD home directory (set TTD_HOME)")
    return 2
  }
  let opts: StoreOptions
  try {
    opts = { lockTimeoutMs: posInt(env.TTD_LOCK_TIMEOUT_MS, "TTD_LOCK_TIMEOUT_MS"), lockStaleMs: posInt(env.TTD_LOCK_STALE_MS, "TTD_LOCK_STALE_MS") }
    for (const k of Object.keys(opts) as (keyof StoreOptions)[]) if (opts[k] === undefined) delete opts[k]
  } catch (e) {
    err((e as Error).message)
    return 2
  }
  const io = createNodeIO()
  const store = createStore(io, home, opts)

  if (cmd === "read") {
    const r = await store.read()
    out(JSON.stringify(r))
    return r.ok ? 0 : 1
  }

  if (cmd === "apply") {
    const raw = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--now")
    if (raw === undefined) {
      err(USAGE)
      return 2
    }
    let op: unknown
    try {
      op = JSON.parse(raw)
    } catch (e) {
      out(JSON.stringify({ ok: false, error: "invalid_op", message: `op is not valid JSON: ${(e as Error).message}` }))
      return 1
    }
    const r = await store.apply(op as Op, { now: flag(rest, "--now") })
    out(JSON.stringify(r))
    return r.ok ? 0 : 1
  }

  // watch
  let interval: number | undefined
  let maxEvents: number | undefined
  let timeoutMs: number | undefined
  try {
    interval = posInt(flag(rest, "--interval-ms"), "--interval-ms")
    maxEvents = posInt(flag(rest, "--max-events"), "--max-events")
    timeoutMs = posInt(flag(rest, "--timeout-ms"), "--timeout-ms")
  } catch (e) {
    err((e as Error).message)
    return 2
  }
  const h = watchStore({ homeDir: home, io, intervalMs: interval, maxEvents, timeoutMs, onEvent: (e) => out(eventLine(e)) })
  await h.done
  return 0
}

if (import.meta.main) {
  const code = await main(
    process.argv.slice(2),
    process.env,
    (l) => process.stdout.write(l + "\n"),
    (l) => process.stderr.write(l + "\n"),
  )
  process.exitCode = code
}
