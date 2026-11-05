// Store engine: lock, read, apply, CAS, atomic replace, recovery (docs/contract/STORE.md sections 4-8).
// All host access goes through the injected IO.
import {
  DEFAULT_LOCK_STALE_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  MAX_ATTEMPTS,
  MAX_FILE_BYTES,
  StoreError,
} from "./types.ts"
import type {
  ApplyCtx,
  ApplyResult,
  Doc,
  ErrorCode,
  Failure,
  IO,
  Op,
  OpResult,
  ReadResult,
  Store,
  StoreOptions,
  Warning,
} from "./types.ts"
import {
  applyOp,
  compactTimestamp,
  emptyDoc,
  joinPath,
  makeId,
  normalise,
  parseDoc,
  randomToken,
  scrapeRev,
  serialize,
  validateOp,
} from "./ops.ts"

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const READ_RETRIES = 3
const READ_RETRY_MS = 50

type State =
  | { kind: "absent"; raw: null }
  | { kind: "ok"; raw: string; doc: Doc }
  | { kind: "corrupt"; raw: string }
  | { kind: "unsupported"; raw: string }

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function failure(e: unknown): Failure {
  if (e instanceof StoreError) {
    return e.code === "io_error" || e.code === "invalid_op" ? { ok: false, error: e.code, message: e.message } : { ok: false, error: e.code }
  }
  return { ok: false, error: "io_error", message: msgOf(e) }
}

const fail = (error: ErrorCode, message?: string): Failure => (message === undefined ? { ok: false, error } : { ok: false, error, message })
const utf8Len = (s: string): number => new TextEncoder().encode(s).length

export function createStore(io: IO, homeDir: string, opts: StoreOptions = {}): Store {
  const lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  const lockStaleMs = opts.lockStaleMs ?? DEFAULT_LOCK_STALE_MS
  const file = joinPath(homeDir, "todos.json")
  const bakFile = joinPath(homeDir, "todos.json.bak")
  const lockDir = joinPath(homeDir, "store.lock")
  const ownerFile = joinPath(lockDir, "owner.json")

  // Reads and classifies todos.json. A parse failure is retried (a foreign writer may be mid-write).
  async function readState(): Promise<State> {
    for (let i = 0; ; i++) {
      const raw = await io.readText(file)
      if (raw === null) return { kind: "absent", raw: null }
      const p = parseDoc(raw)
      if (p.kind === "ok") return { kind: "ok", raw, doc: p.doc }
      if (p.kind === "unsupported_version") return { kind: "unsupported", raw }
      if (i >= READ_RETRIES) return { kind: "corrupt", raw }
      await io.sleep(READ_RETRY_MS)
    }
  }

  async function read(): Promise<ReadResult> {
    try {
      const st = await readState()
      if (st.kind === "absent") return { ok: true, doc: emptyDoc(), warnings: [] }
      if (st.kind === "ok") return { ok: true, doc: normalise(st.doc), warnings: [] }
      return { ok: false, error: st.kind === "corrupt" ? "corrupt" : "unsupported_version" }
    } catch (e) {
      return { ok: false, error: "io_error", message: msgOf(e) }
    }
  }

  async function readOwner(): Promise<{ token: string | null; ts: number | null }> {
    let raw: string | null = null
    try {
      raw = await io.readText(ownerFile)
    } catch {
      return { token: null, ts: null }
    }
    if (raw === null) return { token: null, ts: null }
    try {
      const v: unknown = JSON.parse(raw)
      const o = v as { token?: unknown; ts?: unknown }
      return {
        token: typeof o.token === "string" ? o.token : null,
        ts: typeof o.ts === "number" && Number.isFinite(o.ts) ? o.ts : null,
      }
    } catch {
      return { token: null, ts: null }
    }
  }

  // True only when a stale lock was actually renamed away (the caller retries mkdir at once).
  async function breakIfStale(warnings: Warning[]): Promise<boolean> {
    const owner = await readOwner()
    let ts = owner.ts
    if (ts === null) {
      const m = await io.mtimeMs(lockDir)
      if (m === null) return false // released while we looked
      ts = m
    }
    if (io.now() - ts <= lockStaleMs) return false
    // Narrow the break-vs-break race: only proceed if the owner is still the one we judged stale.
    const again = await readOwner()
    if (again.token !== owner.token) return false
    const gone = lockDir + ".stale-" + randomToken(io.random)
    try {
      await io.rename(lockDir, gone)
    } catch {
      return false // another breaker won, the owner released, or the rename is not permitted
    }
    try {
      await io.removeTree(gone)
    } catch {
      // leftover renamed directory is harmless
    }
    if (!warnings.includes("stale_lock_broken")) warnings.push("stale_lock_broken")
    return true
  }

  async function tryCreateLock(token: string): Promise<boolean> {
    if (!(await io.mkdirExclusive(lockDir))) return false
    try {
      await io.writeText(ownerFile, JSON.stringify({ token, pid: io.pid(), ts: io.now() }))
    } catch (e) {
      try {
        await io.removeTree(lockDir)
      } catch {
        // best effort
      }
      throw e
    }
    return true
  }

  async function acquire(token: string, warnings: Warning[]): Promise<Failure | null> {
    const start = io.now()
    for (;;) {
      if (await tryCreateLock(token)) return null
      if (await breakIfStale(warnings)) continue
      if (io.now() - start >= lockTimeoutMs) {
        // No lock directory to wait for means mkdir fails for another reason (missing or unwritable HOME_DIR).
        if ((await io.mtimeMs(lockDir)) !== null) return fail("lock_timeout")
        if (await tryCreateLock(token)) return null
        if ((await io.mtimeMs(lockDir)) !== null) return fail("lock_timeout")
        return fail("io_error", "cannot create the lock directory in HOME_DIR")
      }
      await io.sleep(10 + Math.floor(io.random() * 31))
    }
  }

  async function release(token: string): Promise<void> {
    try {
      const raw = await io.readText(ownerFile)
      if (raw !== null) {
        const o = await readOwner()
        if (o.token !== null && o.token !== token) return // someone else's lock now: leave it
      }
      await io.removeTree(lockDir)
    } catch {
      // nothing more can be done; a stale lock expires
    }
  }

  async function readBak(): Promise<Doc | null> {
    const raw = await io.readText(bakFile)
    if (raw === null) return null
    const p = parseDoc(raw)
    return p.kind === "ok" ? p.doc : null
  }

  async function commitLoop(op: Op, now: string, token: string, newId: () => string, resetIds: () => void, lockWarnings: Warning[], ctx: ApplyCtx): Promise<ApplyResult> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      resetIds()
      const st = await readState()
      if (st.kind === "unsupported") return fail("unsupported_version")

      const warnings: Warning[] = [...lockWarnings]
      let base: Doc
      let next: Doc
      let result: OpResult
      let quarantine = false

      if (st.kind === "corrupt") {
        // Section 8. Nothing is moved before the op succeeded and the new file is ready.
        const bak = await readBak()
        const rawRev = scrapeRev(st.raw)
        if (bak === null && op.op !== "reset_corrupt") return fail("corrupt_no_backup")
        if (bak !== null) {
          base = { ...bak, rev: Math.max(bak.rev, rawRev) }
          if (op.op === "reset_corrupt") {
            next = normalise(base)
            result = {}
          } else {
            const r = applyOp(base, op, now, newId)
            next = r.doc
            result = r.result
          }
          warnings.push("corrupt_quarantined", "restored_from_bak")
        } else {
          base = { ...emptyDoc(), rev: rawRev }
          next = base
          result = {}
          warnings.push("corrupt_quarantined")
        }
        quarantine = true
      } else {
        if (op.op === "reset_corrupt") return fail("not_corrupt")
        base = st.kind === "ok" ? st.doc : emptyDoc()
        const r = applyOp(base, op, now, newId)
        if (!r.changed) return { ok: true, changed: false, rev: base.rev, result: r.result, warnings, attempts: attempt, doc: r.doc }
        next = r.doc
        result = r.result
      }

      next = { ...next, rev: base.rev + 1 }
      const text = serialize(next)
      const size = utf8Len(text)
      if (size > MAX_FILE_BYTES && size > (st.raw === null ? 0 : utf8Len(st.raw))) return fail("limit_exceeded")

      const tmp = joinPath(homeDir, ".todos.json.tmp-" + token)
      const quarantinePath = joinPath(homeDir, "todos.corrupt-" + compactTimestamp(now) + "-" + token + ".json")
      let committed = false
      try {
        await io.writeText(tmp, text)
        if (ctx.beforeCommit) await ctx.beforeCommit()
        // CAS: the file must be byte-for-byte what this attempt read (covers absent, corrupt and present alike).
        const cur = await io.readText(file)
        if (cur !== st.raw) continue // finally removes the temp file; re-read and re-apply the same op
        if (st.kind === "ok") await io.writeText(bakFile, st.raw)
        let quarantined = false
        if (quarantine) {
          await io.rename(file, quarantinePath)
          quarantined = true
        }
        try {
          await io.rename(tmp, file)
        } catch (e) {
          if (quarantined) {
            try {
              await io.rename(quarantinePath, file) // put the unreadable file back rather than leave none
            } catch {
              // the quarantined copy is still on disk
            }
          }
          throw e
        }
        committed = true
        return { ok: true, changed: true, rev: next.rev, result, warnings, attempts: attempt, doc: next }
      } finally {
        if (!committed) {
          try {
            await io.removeTree(tmp)
          } catch {
            // best effort
          }
        }
      }
    }
    return fail("conflict_exhausted")
  }

  async function apply(op: Op, ctx: ApplyCtx = {}): Promise<ApplyResult> {
    const now = ctx.now ?? new Date(io.now()).toISOString()
    if (!ISO_RE.test(now) || Number.isNaN(Date.parse(now))) {
      return fail("invalid_op", "now must be an ISO-8601 UTC timestamp with milliseconds and Z")
    }
    try {
      validateOp(op)
    } catch (e) {
      return failure(e)
    }
    const token = randomToken(io.random)
    // The generated id is fixed per invocation: a retry re-applies exactly the same op.
    const ids: string[] = []
    let k = 0
    const newId = (): string => {
      const i = k++
      if (ids[i] === undefined) ids[i] = makeId(now, io.random)
      return ids[i]
    }
    const lockWarnings: Warning[] = []
    try {
      await io.ensureDir(homeDir)
    } catch {
      // surfaces as io_error below if the directory really is missing
    }
    let locked = false
    try {
      const lf = await acquire(token, lockWarnings)
      if (lf !== null) return lf
      locked = true
      return await commitLoop(op, now, token, newId, () => { k = 0 }, lockWarnings, ctx)
    } catch (e) {
      return failure(e)
    } finally {
      if (locked) await release(token)
    }
  }

  return { read, apply }
}
