// Node/bun implementation of the store IO (STORE.md section 10). The Claude Code mod has its own (mod-io.ts).
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { IO } from "../plugin/hooks/store/index.ts"

export interface NodeIOOptions {
  rawRename?: (from: string, to: string) => Promise<void> // injection point for fault tests
  renameRetryDelayMs?: number // section 4: 20
  renameRetries?: number // section 4: 5
}

const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"])
const codeOf = (e: unknown): string | undefined => (e as { code?: string } | null)?.code

export function createNodeIO(opts: NodeIOOptions = {}): IO {
  const rawRename = opts.rawRename ?? rename
  const delay = opts.renameRetryDelayMs ?? 20
  const retries = opts.renameRetries ?? 5
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  return {
    now: () => Date.now(),
    sleep,
    random: () => Math.random(),
    pid: () => process.pid,
    async readText(p) {
      try {
        return await readFile(p, "utf8")
      } catch (e) {
        if (codeOf(e) === "ENOENT") return null
        throw e
      }
    },
    async writeText(p, t) {
      try {
        await writeFile(p, t, "utf8")
      } catch (e) {
        if (codeOf(e) !== "ENOENT") throw e
        await mkdir(dirname(p), { recursive: true })
        await writeFile(p, t, "utf8")
      }
    },
    async rename(from, to) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await rawRename(from, to)
        } catch (e) {
          // Windows: another process may hold the destination open; retry only those codes.
          if (!RETRYABLE.has(codeOf(e) ?? "") || attempt >= retries) throw e
          await sleep(delay)
        }
      }
    },
    async mkdirExclusive(p) {
      try {
        await mkdir(p)
        return true
      } catch (e) {
        if (codeOf(e) === "EEXIST") return false
        throw e
      }
    },
    async removeTree(p) {
      await rm(p, { recursive: true, force: true })
    },
    async mtimeMs(p) {
      try {
        return (await stat(p)).mtimeMs
      } catch (e) {
        if (codeOf(e) === "ENOENT") return null
        throw e
      }
    },
    async ensureDir(p) {
      await mkdir(p, { recursive: true })
    },
  }
}

export const nodeIO: IO = createNodeIO()
