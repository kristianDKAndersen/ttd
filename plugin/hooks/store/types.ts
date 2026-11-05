// Shared types for the TTD store core. ECMAScript built-ins only (see docs/contract/STORE.md section 10).

export const SCHEMA_VERSION = 1
export const MAX_ITEMS = 1000
export const MAX_FILE_BYTES = 1048576
export const MAX_TITLE = 200
export const MAX_BODY = 10000
export const MAX_ATTEMPTS = 5
export const DEFAULT_LOCK_TIMEOUT_MS = 5000
export const DEFAULT_LOCK_STALE_MS = 15000

export type Status = "todo" | "in_progress" | "done"
export const STATUSES: readonly Status[] = ["todo", "in_progress", "done"]

export interface Item {
  id: string
  title: string
  body: string
  status: Status
  order: number
  createdAt: string
  updatedAt: string
  [unknown: string]: unknown // unknown per-item fields are preserved on read-modify-write
}

export interface Doc {
  schemaVersion: number
  rev: number
  items: Item[]
  [unknown: string]: unknown // unknown top-level fields are preserved
}

export type Op =
  | { op: "add"; title: string; body?: string; status?: Status; id?: string }
  | { op: "update"; id: string; title?: string; body?: string }
  | { op: "set_status"; id: string; status: Status }
  | { op: "move"; id: string; after: string | null }
  | { op: "delete"; id: string }
  | { op: "reset_corrupt" }

export type ErrorCode =
  | "invalid_op"
  | "invalid_title"
  | "too_long"
  | "limit_exceeded"
  | "not_found"
  | "not_corrupt"
  | "corrupt"
  | "corrupt_no_backup"
  | "unsupported_version"
  | "lock_timeout"
  | "conflict_exhausted"
  | "io_error"

export type Warning = "corrupt_quarantined" | "restored_from_bak" | "stale_lock_broken"

export class StoreError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message?: string) {
    super(message ?? code)
    this.name = "StoreError"
    this.code = code
  }
}

export type OpResult = { item: Item } | { id: string } | Record<string, never>

export interface ApplyOk {
  ok: true
  changed: boolean
  rev: number
  result: OpResult
  warnings: Warning[]
  attempts: number
  doc: Doc
}
export interface Failure<E extends ErrorCode = ErrorCode> {
  ok: false
  error: E
  message?: string
}
export type ApplyResult = ApplyOk | Failure

export interface ReadOk {
  ok: true
  doc: Doc
  warnings: Warning[]
}
export type ReadResult = ReadOk | Failure<"corrupt" | "unsupported_version" | "io_error">

// Injected host IO. node-io.ts implements it for bun/node, the mod supplies its own.
export interface IO {
  now(): number // epoch ms: lock staleness and owner.json ts (NOT the item timestamps, those come from ctx.now)
  sleep(ms: number): Promise<void>
  random(): number // [0, 1)
  pid(): number
  readText(p: string): Promise<string | null> // null = ENOENT
  writeText(p: string, t: string): Promise<void> // creates parent dirs
  rename(from: string, to: string): Promise<void> // atomic replace, retries per section 4
  mkdirExclusive(p: string): Promise<boolean> // true created, false already exists; anything else throws
  removeTree(p: string): Promise<void> // missing is fine
  mtimeMs(p: string): Promise<number | null>
  ensureDir(p: string): Promise<void> // mkdir -p (HOME_DIR must exist before the lock mkdir)
}

export interface StoreOptions {
  lockTimeoutMs?: number
  lockStaleMs?: number
}

export interface ApplyCtx {
  now?: string // ISO-8601 UTC with milliseconds and Z; default = io.now()
  beforeCommit?: () => Promise<void> // test seam only (section 6)
}

export interface Store {
  read(): Promise<ReadResult>
  apply(op: Op, ctx?: ApplyCtx): Promise<ApplyResult>
}
