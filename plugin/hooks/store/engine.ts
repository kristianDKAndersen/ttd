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
  const breakDir = joinPath(homeDir, "store.lock.break")

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

  // The owner of a lock directory, or null when owner.json is missing, unreadable or not {token: string, ts: integer >= 0}
  // (the same rule as the Rust engine, so the two judge one lock alike).
  async function readOwner(dir: string): Promise<{ token: string; ts: number } | null> {
    try {
      const raw = await io.readText(joinPath(dir, "owner.json"))
      if (raw === null) return null
      const o = JSON.parse(raw) as { token?: unknown; ts?: unknown } | null
      if (o === null || typeof o.token !== "string" || typeof o.ts !== "number" || !Number.isInteger(o.ts) || o.ts < 0) return null
      return { token: o.token, ts: o.ts }
    } catch {
      return null
    }
  }

  type Judgement = { kind: "fresh" } | { kind: "gone" } | { kind: "stale"; token: string | null }

  async function judge(): Promise<Judgement> {
    const owner = await readOwner(lockDir)
    if (owner !== null) return io.now() - owner.ts > lockStaleMs ? { kind: "stale", token: owner.token } : { kind: "fresh" }
    let m: number | null
    try {
      m = await io.mtimeMs(lockDir)
    } catch {
      return { kind: "fresh" }
    }
    if (m === null) return { kind: "gone" }
    return io.now() - m > lockStaleMs ? { kind: "stale", token: null } : { kind: "fresh" }
  }

  // Section 5, "Breaking a stale lock". Breakers are serialised through the exclusive directory store.lock.break and
  // re-judge under it; without that, a second breaker holding the same stale judgement renames away the FRESH lock the
  // first breaker's successor just created. True only when a stale lock was really removed (retry mkdir at once).
  async function breakIfStale(warnings: Warning[]): Promise<boolean> {
    const first = await judge()
    if (first.kind !== "stale") return false
    if (!(await io.mkdirExclusive(breakDir))) {
      // A crashed breaker's guard must not wedge the store: one older than lockStaleMs is removed (we still back off once).
      try {
        const m = await io.mtimeMs(breakDir)
        if (m !== null && io.now() - m > lockStaleMs) await io.removeTree(breakDir)
      } catch {
        // best effort
      }
      return false
    }
    try {
      const j = await judge()
      if (j.kind !== "stale" || !(await breakStale(j.token))) return false
    } finally {
      try {
        await io.removeTree(breakDir)
      } catch {
        // an old guard is cleared by the next breaker
      }
    }
    if (!warnings.includes("stale_lock_broken")) warnings.push("stale_lock_broken")
    return true
  }

  // Rename the stale lock away (atomic), then verify that what we renamed is the lock we judged. If a live lock was
  // swapped in between the judgement and the rename, put it back and do not claim the break.
  async function breakStale(judged: string | null): Promise<boolean> {
    const moved = lockDir + ".stale-" + randomToken(io.random)
    try {
      await io.rename(lockDir, moved)
    } catch {
      return false // the owner released, or the rename is not permitted
    }
    let same = false
    try {
      const o = await readOwner(moved)
      if (judged !== null) same = o !== null && o.token === judged
      else if (o === null) {
        const m = await io.mtimeMs(moved)
        same = m !== null && io.now() - m > lockStaleMs
      }
    } catch {
      same = false
    }
    if (!same) {
      try {
        await io.rename(moved, lockDir)
        return false
      } catch {
        // could not restore (the directory name is taken again): fall through and drop the copy, as the Rust engine does
      }
    }
    try {
      await io.removeTree(moved)
    } catch {
      // leftover renamed directory is harmless
    }
    return same
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
      const o = await readOwner(lockDir)
      if (o !== null && o.token !== token) return // someone else's lock now: leave it
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
      const bakTmp = joinPath(homeDir, ".todos.json.tmp-" + randomToken(io.random))
      const quarantinePath = joinPath(homeDir, "todos.corrupt-" + compactTimestamp(now) + "-" + token + ".json")
      let committed = false
      let bakInPlace = false
      try {
        // Both files are complete before anything visible changes, so a write failure aborts the op uncommitted.
        await io.writeText(tmp, text)
        await io.writeText(bakTmp, text)
        if (ctx.beforeCommit) await ctx.beforeCommit()
        // CAS: the file must be byte-for-byte what this attempt read (covers absent, corrupt and present alike).
        const cur = await io.readText(file)
        if (cur !== st.raw) continue // finally removes the temp files; re-read and re-apply the same op
        // Section 8: the corrupt file is copied byte-identical to its quarantine name; todos.json itself is only ever
        // replaced by the rename below, so it is never absent.
        if (quarantine) await io.copyFile(file, quarantinePath)
        try {
          await io.rename(tmp, file)
        } catch (e) {
          if (quarantine) {
            try {
              await io.removeTree(quarantinePath) // the corrupt file is still todos.json: drop the now-pointless copy
            } catch {
              // a duplicate quarantine copy is harmless
            }
          }
          throw e
        }
        committed = true
        // Section 4: .bak = the commit just made, swapped in atomically. Failing here (or a crash) leaves the previous
        // .bak, one version behind; the commit is already durable and acknowledged.
        try {
          await io.rename(bakTmp, bakFile)
          bakInPlace = true
        } catch {
          // best effort, see above
        }
        return { ok: true, changed: true, rev: next.rev, result, warnings, attempts: attempt, doc: next }
      } finally {
        for (const [path, gone] of [[tmp, committed], [bakTmp, bakInPlace]] as const) {
          if (gone) continue
          try {
            await io.removeTree(path)
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
