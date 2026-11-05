// Shared helpers for the cross-process tests: real CLIs (TS and Rust) and the real mod, one fresh TTD_HOME per test.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanup as cleanupMod, op as modOp, scrubbedEnv } from "../../e2e-mod/harness.ts"

export { scrubbedEnv }

export const REPO = join(import.meta.dir, "../..")
export const TS_CLI = join(REPO, "store-node/cli.ts")
export const RS_CLI = join(REPO, "target/debug/ttd-store")
export const PLUGIN_DIR = join(REPO, "plugin")

export type Impl = "ts" | "rs" | "mod"

export interface Ack {
  impl: Impl
  op: any
  code: number
  /** parsed apply envelope; undefined when stdout carried no parsable JSON line */
  env: any
  stdout: string
  stderr: string
  ms: number
  /** epoch ms when the envelope reached the test (the acknowledgement) */
  ackedAt: number
}

const dirs: string[] = []
export function tmpHome(): string {
  const root = mkdtempSync(join(tmpdir(), "ttd-int-"))
  dirs.push(root)
  return join(root, "ttd") // TTD_HOME does not exist yet: the first writer must create it
}
export function cleanupAll(): void {
  cleanupMod()
  if (process.env.INTEGRATION_KEEP) return console.log("kept:", dirs.join(" "))
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
}

export function lastJson(text: string): any {
  const lines = text.split("\n").filter((l) => l.trim() !== "")
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]!)
    } catch {}
  }
  return undefined
}

export function cliEnv(home: string, extra: Record<string, string | undefined> = {}): Record<string, string> {
  return scrubbedEnv({ TTD_HOME: home, ...extra })
}

export function cliArgv(impl: "ts" | "rs", ...args: string[]): string[] {
  return impl === "ts" ? [process.execPath, TS_CLI, ...args] : [RS_CLI, ...args]
}

/** One write through the chosen implementation, as its own process. */
export async function apply(impl: Impl, home: string, op: unknown, extra: Record<string, string | undefined> = {}): Promise<Ack> {
  const t0 = Date.now()
  if (impl === "mod") {
    const r = await modOp(home, op, extra)
    return { impl, op, code: r.code, env: r.env, stdout: r.raw, stderr: r.stderr, ms: r.ms, ackedAt: Date.now() }
  }
  const proc = Bun.spawn(cliArgv(impl, "apply", JSON.stringify(op)), { env: cliEnv(home, extra), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { impl, op, code, env: lastJson(stdout), stdout, stderr, ms: Date.now() - t0, ackedAt: Date.now() }
}

export async function readVia(impl: "ts" | "rs", home: string): Promise<any> {
  const proc = Bun.spawn(cliArgv(impl, "read"), { env: cliEnv(home), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return { code, env: lastJson(stdout) }
}

export const rawDoc = (home: string): any => JSON.parse(readFileSync(join(home, "todos.json"), "utf8"))
export const listDir = (home: string): string[] => (existsSync(home) ? readdirSync(home).sort() : [])
export const titles = (doc: any): string[] => doc.items.map((i: any) => i.title)

/** Debris that must never be left by a clean run (a killed writer may leave tmp files, see crash-recovery). */
export function debris(home: string): string[] {
  return listDir(home).filter((n) => n === "store.lock" || n.startsWith("store.lock.") || n.startsWith(".todos.json.tmp-") || n.startsWith("todos.corrupt-"))
}

export const quarantined = (home: string): string[] => listDir(home).filter((n) => /^todos\.corrupt-.*\.json$/.test(n))

export function say(a: Ack): string {
  return `${a.impl} ${JSON.stringify(a.op)} -> exit=${a.code} ms=${a.ms}\nstdout: ${a.stdout.slice(0, 1500)}\nstderr: ${a.stderr.slice(0, 1500)}`
}

/** Sequential writes from one "process slot": each call is its own process, so N slots are N concurrent writers. */
export async function writerLoop(impl: Impl, home: string, n: number, mk: (i: number) => unknown, sink: Ack[], extra: Record<string, string | undefined> = {}): Promise<void> {
  for (let i = 1; i <= n; i++) sink.push(await apply(impl, home, mk(i), extra))
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!
}

export function latencyReport(acks: Ack[]): string {
  const out: string[] = []
  for (const impl of ["ts", "rs", "mod"] as Impl[]) {
    const ms = acks.filter((a) => a.impl === impl).map((a) => a.ms)
    if (ms.length) out.push(`${impl}: n=${ms.length} p50=${percentile(ms, 50)}ms p95=${percentile(ms, 95)}ms max=${Math.max(...ms)}ms`)
  }
  return out.join(" | ")
}

/** mulberry32; the seed is printed so a failing run can be replayed with INTEGRATION_SEED. */
export function prng(): { seed: number; next: () => number; pick: <T>(xs: T[]) => T } {
  const seed = process.env.INTEGRATION_SEED ? Number(process.env.INTEGRATION_SEED) : (Date.now() ^ (process.pid << 8)) >>> 0
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return { seed, next, pick: (xs) => xs[Math.floor(next() * xs.length)]! }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** A lock whose owner is dead: owner.json carries a pid that has exited and an old `ts`. */
export function plantDeadLock(home: string, ageMs = 60_000): { pid: number; token: string } {
  const dead = Bun.spawnSync(["true"])
  mkdirSync(home, { recursive: true })
  mkdirSync(join(home, "store.lock"))
  const token = "deadowner" + Math.random().toString(36).slice(2, 5)
  writeFileSync(join(home, "store.lock", "owner.json"), JSON.stringify({ token, pid: dead.pid, ts: Date.now() - ageMs }))
  return { pid: dead.pid, token }
}

export const mtimeMs = (p: string): number => statSync(p).mtimeMs
