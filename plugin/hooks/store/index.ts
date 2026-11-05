// Public surface of the TTD store core (pure: no host API). Consumers: the Claude Code mod, the dev shim, the CLI.
export { createStore } from "./engine.ts"
export {
  applyOp,
  cpLen,
  compactTimestamp,
  emptyDoc,
  isValidId,
  joinPath,
  makeId,
  normalise,
  parseDoc,
  resolveHomeDir,
  scrapeRev,
  serialize,
  trimTtd,
  validateOp,
} from "./ops.ts"
export type { ParsedDoc } from "./ops.ts"
export {
  DEFAULT_LOCK_STALE_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  MAX_ATTEMPTS,
  MAX_BODY,
  MAX_FILE_BYTES,
  MAX_ITEMS,
  MAX_TITLE,
  SCHEMA_VERSION,
  STATUSES,
  StoreError,
} from "./types.ts"
export type {
  ApplyCtx,
  ApplyOk,
  ApplyResult,
  Doc,
  ErrorCode,
  Failure,
  IO,
  Item,
  Op,
  OpResult,
  ReadOk,
  ReadResult,
  Status,
  Store,
  StoreOptions,
  Warning,
} from "./types.ts"
