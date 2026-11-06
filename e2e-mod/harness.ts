// Shared helpers for the real-process mod tests: every test spawns `claude -p --plugin-dir <plugin> "/ttd ..."`
// against a fresh temp TTD_HOME. The child must not see the parent Claude Code session (it would hang silently).
import { expect } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const REPO = join(import.meta.dir, "..")
export const PLUGIN_DIR = join(REPO, "plugin")
export const FIXTURE_DIR = join(REPO, "docs/contract/fixtures")
export const CLAUDE_TIMEOUT_MS = 90_000

// Names that tie a child to the session that spawned it. Auth variables (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_*) are kept.
const SCRUB = [
  /^(CLAUDE_CODE_)?SESSION_ID$/,
  /^(CLAUDE_CODE_)?SSE_PORT$/,
  /^(CLAUDE_CODE_)?CHILD_SESSION$/,
  /^(CLAUDE_CODE_)?ENTRYPOINT$/,
  /^CLAUDECODE$/,
  /^CLAUDE_CODE_PLUGIN_DIRS?$/,
  /^CLAUDE_CODE_PLUGIN_DIR_WATCH$/,
  /^CLAUDE_CODE_SESSION_/,
  /^CLAUDE_CODE_MESSAGING_/,
  /^CLAUDE_PID$/,
  /^TTD_/, // a developer's own TTD_* settings must not leak into a test
]

export function scrubbedEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || SCRUB.some((re) => re.test(k))) continue
    env[k] = v
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  return env
}

const dirs: string[] = []
export function tmpDir(prefix = "ttd-mod-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
export function cleanup(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
}

export interface Ran {
  code: number
  /** stdout with the host's "ttd: " attribution prefix removed and the trailing newline trimmed */
  out: string
  raw: string
  stderr: string
  ms: number
}

export async function runClaude(prompt: string, opts: { home: string; env?: Record<string, string | undefined>; pluginDir?: string; cwd?: string }): Promise<Ran> {
  const t0 = Date.now()
  const proc = Bun.spawn(["claude", "-p", "--no-session-persistence", "--plugin-dir", opts.pluginDir ?? PLUGIN_DIR, prompt], {
    cwd: opts.cwd ?? tmpDir("ttd-cwd-"), // a neutral cwd: no project hooks or CLAUDE.md of this repo or the advisor load
    env: scrubbedEnv({ TTD_HOME: opts.home, TTD_NO_LAUNCH: "1", ...(opts.env ?? {}) }),
    stdin: "ignore", // `< /dev/null`: -p otherwise waits for stdin
    stdout: "pipe",
    stderr: "pipe",
  })
  const [raw, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  const out = raw.replace(/^ttd: /, "").replace(/\n$/, "")
  return { code, out, raw, stderr, ms: Date.now() - t0 }
}

/** Machine path: `/ttd op '<json>'`, stdout is the apply envelope. */
export async function op(home: string, o: unknown, env?: Record<string, string | undefined>): Promise<Ran & { env: any }> {
  const r = await runClaude(`/ttd op '${JSON.stringify(o).replaceAll("'", "'\\''")}'`, { home, env })
  let parsed: unknown
  try {
    parsed = JSON.parse(r.out)
  } catch {
    parsed = undefined
  }
  return Object.assign(r, { env: parsed })
}

export function say(r: Ran): string {
  return `exit=${r.code} ms=${r.ms}\nstdout: ${r.raw}\nstderr: ${r.stderr.slice(0, 2000)}`
}

export const readTodos = (home: string): any => JSON.parse(readFileSync(join(home, "todos.json"), "utf8"))
export const strip = (v: any): any => JSON.parse(JSON.stringify(v, (k, x) => (k === "createdAt" || k === "updatedAt" ? undefined : x)))
export const files = (home: string): string[] => (existsSync(home) ? readdirSync(home) : [])

type Raw = { raw: string }
const isRaw = (v: unknown): v is Raw => typeof v === "object" && v !== null && "raw" in v
const asText = (v: unknown): string => (isRaw(v) ? v.raw : JSON.stringify(v, null, 2) + "\n")

/** Materialise a fixture's `setup` (STORE.md section 11) in a fresh TTD_HOME. */
export function seed(home: string, setup: any): void {
  mkdirSync(home, { recursive: true })
  if (setup.file !== null) writeFileSync(join(home, "todos.json"), asText(setup.file))
  if (setup.bak !== null) writeFileSync(join(home, "todos.json.bak"), asText(setup.bak))
  if (setup.lock !== null) {
    mkdirSync(join(home, "store.lock"))
    writeFileSync(join(home, "store.lock", "owner.json"), JSON.stringify({ token: "foreignlock1", pid: 1, ts: Date.now() - setup.lock.ownerAgeMs }))
  }
}

export interface ReplayOpts {
  /** createdAt/updatedAt come from the wall clock (the mod has no --now); compare without them unless the fixture never creates or bumps */
  exactTimes?: boolean
}

/** Replays a contract fixture through the real mod (one `claude -p` per step) and checks every step and the final state. */
export async function replayFixture(file: string, o: ReplayOpts = {}): Promise<void> {
  const fx = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8"))
  const home = join(tmpDir(), "ttd")
  seed(home, fx.setup)
  const env: Record<string, string> = {}
  if (fx.options?.lockTimeoutMs !== undefined) env.TTD_LOCK_TIMEOUT_MS = String(fx.options.lockTimeoutMs)
  if (fx.options?.lockStaleMs !== undefined) env.TTD_LOCK_STALE_MS = String(fx.options.lockStaleMs)
  const norm = (v: any) => (o.exactTimes ? v : strip(v))

  for (const [i, step] of fx.steps.entries()) {
    const where = `${file} step ${i}`
    const exp = step.expect
    if (step.read) {
      const r = await runClaude("/ttd list", { home, env })
      expect(r.code === 0, `${where}\n${say(r)}`).toBe(exp.ok)
      if (!exp.ok) expect(r.out, where).toContain(exp.error)
      continue
    }
    const r = await op(home, step.op, env)
    const got = r.env
    expect(got, `${where}: no envelope\n${say(r)}`).toBeDefined()
    expect(got.ok, `${where}\n${say(r)}`).toBe(exp.ok)
    expect(r.code, `${where} exit code\n${say(r)}`).toBe(exp.ok ? 0 : 1)
    if (!exp.ok) {
      expect(got.error, where).toBe(exp.error)
      continue
    }
    if (exp.changed !== undefined) expect(got.changed, where).toBe(exp.changed)
    if (exp.rev !== undefined) expect(got.rev, where).toBe(exp.rev)
    if (exp.result !== undefined) expect(norm(got.result), where).toEqual(norm(exp.result))
    expect(got.warnings ?? [], where).toEqual(exp.warnings ?? [])
  }

  const fin = fx.final
  const names = files(home)
  if (fin.file === "absent") expect(names).not.toContain("todos.json")
  else if (isRaw(fin.file)) expect(readFileSync(join(home, "todos.json"), "utf8")).toBe(fin.file.raw)
  else expect(norm(readTodos(home))).toEqual(norm(fin.file))
  const quarantined = names.filter((n) => /^todos\.corrupt-.*\.json$/.test(n))
  expect(quarantined.length, `${file} quarantined`).toBe(fin.quarantined)
  for (const raw of fin.quarantinedRaw ?? []) expect(quarantined.map((q) => readFileSync(join(home, q), "utf8"))).toContain(raw)
  expect(existsSync(join(home, "store.lock")), `${file} lockDir`).toBe(fin.lockDir)
  expect(names.filter((n) => n.startsWith(".todos.json.tmp-")).length, `${file} tmpFiles`).toBe(fin.tmpFiles)
  if (fin.bakExists !== undefined) expect(existsSync(join(home, "todos.json.bak")), `${file} bakExists`).toBe(fin.bakExists)
  if (fin.bakEqualsFile) expect(readFileSync(join(home, "todos.json.bak"), "utf8"), `${file} bakEqualsFile`).toBe(readFileSync(join(home, "todos.json"), "utf8"))
}

export const ID_RE = /^t_[a-z0-9]+$/

/** A copy of the plugin in a tree with no `target/` beside it, so the dev-checkout fallback cannot find a built window. */
export function isolatedPlugin(): string {
  const root = tmpDir("ttd-iso-")
  cpSync(PLUGIN_DIR, join(root, "plugin"), { recursive: true, filter: (src) => !src.includes(`${join("plugin", ".claude-plugin", "types")}`) })
  return join(root, "plugin")
}
