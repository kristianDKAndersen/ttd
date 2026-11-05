// The mod's IO adapter for the store core (docs/contract/STORE.md section 12): files through $.fs, and the three
// things $.fs cannot do (exclusive create, atomic replace, recursive remove) through $.process.run.
import { createStore, joinPath, resolveHomeDir } from './store/index.ts'
import type { IO, Store, StoreOptions } from './store/index.ts'

/** The slice of the engine's `$` the adapter uses. */
export type ModHost = {
  fs: {
    read(path: string): Promise<string | { base64: string }>
    write(path: string, text: string): Promise<void>
    exists(path: string): Promise<boolean>
    stat(path: string): Promise<{ mtimeMs: number }>
  }
  process: { run(argv: readonly string[], init?: { timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }> }
  clock: { sleep(ms: number): Promise<void> }
}

export const RENAME_RETRIES = 5
export const RENAME_RETRY_MS = 20
const PROCESS_TIMEOUT_MS = 10_000

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** There is no platform API in the mod environment: Windows is told from the home path. */
export const looksWindows = (p: string): boolean => /^[A-Za-z]:/.test(p) || p.includes('\\')

export function createModIO($: ModHost, opts: { windows: boolean }): IO {
  const win = opts.windows
  const pid = 1 + Math.floor(Math.random() * 1_000_000_000)

  async function sh(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    try {
      return await $.process.run(argv, { timeoutMs: PROCESS_TIMEOUT_MS })
    } catch (e) {
      // `$.process` is "CLI only": the desktop app and SDK sessions have none, and then TTD must not write at all.
      throw new Error(`cannot write safely here: $.process.run is not available or failed (${msgOf(e)}); TTD is read-only in the Claude desktop app and SDK sessions`)
    }
  }
  const fail = (what: string, r: { exitCode: number; stderr: string }): Error => new Error(`${what} failed (exit ${r.exitCode}): ${r.stderr.trim() || 'no output'}`)

  async function missing(p: string): Promise<boolean> {
    try {
      return !(await $.fs.exists(p))
    } catch {
      return false
    }
  }

  return {
    now: () => Date.now(),
    sleep: (ms) => $.clock.sleep(ms),
    random: () => Math.random(),
    pid: () => pid,

    async readText(p) {
      try {
        const r = await $.fs.read(p)
        return typeof r === 'string' ? r : null
      } catch (e) {
        if (await missing(p)) return null
        throw e
      }
    },
    async writeText(p, t) {
      await $.fs.write(p, t)
    },
    async rename(from, to) {
      const argv = win ? ['cmd', '/c', 'move', '/Y', from, to] : ['mv', '-f', from, to]
      // POSIX rename does not fail transiently; Windows can have the target open in another process (section 4).
      const tries = win ? RENAME_RETRIES + 1 : 1
      let last = new Error('rename failed')
      for (let i = 0; i < tries; i++) {
        const r = await sh(argv)
        if (r.exitCode === 0) return
        last = fail('rename', r)
        if (i + 1 < tries) await $.clock.sleep(RENAME_RETRY_MS)
      }
      throw last
    },
    async mkdirExclusive(p) {
      const r = await sh(win ? ['cmd', '/c', 'mkdir', p] : ['mkdir', p])
      if (r.exitCode === 0) return true
      // false means "already exists" and nothing else (a missing parent or a permission error must surface as io_error).
      if (/exist/i.test(r.stderr + r.stdout) || (await $.fs.exists(p).catch(() => false))) return false
      throw fail('mkdir', r)
    },
    async removeTree(p) {
      const r = await sh(win ? ['cmd', '/c', 'rmdir', '/s', '/q', p] : ['rm', '-rf', p])
      if (r.exitCode !== 0 && !(await missing(p))) throw fail('remove', r)
    },
    async mtimeMs(p) {
      try {
        return (await $.fs.stat(p)).mtimeMs
      } catch (e) {
        if (await missing(p)) return null
        throw e
      }
    },
    async ensureDir(p) {
      const r = await sh(win ? ['cmd', '/c', 'mkdir', p] : ['mkdir', '-p', p])
      if (r.exitCode !== 0 && (await missing(p))) throw fail('mkdir -p', r)
    },
  }
}

/** The ways opening the store can fail before the core is involved. */
export type OpenFailure = { ok: false; error: 'io_error'; message: string }
export type Opened = { ok: true; store: Store; home: string; file: string } | OpenFailure

const posInt = (v: string | undefined): number | undefined => {
  if (v === undefined || v.trim() === '') return undefined
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

/** Resolves HOME_DIR and the lock options from the environment (literal names only) and builds the store. */
export async function openStore($: ModHost & { env: { get(name: string): Promise<string | undefined> } }): Promise<Opened> {
  const TTD_HOME = await $.env.get('TTD_HOME')
  const USERPROFILE = await $.env.get('USERPROFILE')
  const HOME = await $.env.get('HOME')
  const home = resolveHomeDir({ TTD_HOME, USERPROFILE, HOME })
  if (!home) return { ok: false, error: 'io_error', message: 'cannot resolve the TTD home directory (set TTD_HOME)' }
  const lockTimeoutMs = posInt(await $.env.get('TTD_LOCK_TIMEOUT_MS'))
  const lockStaleMs = posInt(await $.env.get('TTD_LOCK_STALE_MS'))
  const o: StoreOptions = {}
  if (lockTimeoutMs !== undefined) o.lockTimeoutMs = lockTimeoutMs
  if (lockStaleMs !== undefined) o.lockStaleMs = lockStaleMs
  const store = createStore(createModIO($, { windows: looksWindows(home) }), home, o)
  return { ok: true, store, home, file: joinPath(home, 'todos.json') }
}

export { msgOf }
