// Minimal mirror of docs/contract/STORE.md sections 2-3 and 7. The UI never imports the store core.

export type Status = 'todo' | 'in_progress' | 'done'

export interface Item {
  id: string
  title: string
  body: string
  status: Status
  order: number
  createdAt: string
  updatedAt: string
}

export interface Doc {
  schemaVersion: number
  rev: number
  items: Item[]
}

export type Op =
  | { op: 'add'; title: string; body?: string; status?: Status; id?: string }
  | { op: 'update'; id: string; title?: string; body?: string }
  | { op: 'set_status'; id: string; status: Status }
  | { op: 'move'; id: string; after: string | null }
  | { op: 'delete'; id: string }
  | { op: 'reset_corrupt' }

export type ErrorCode =
  | 'invalid_op'
  | 'invalid_title'
  | 'too_long'
  | 'limit_exceeded'
  | 'not_found'
  | 'not_corrupt'
  | 'corrupt'
  | 'corrupt_no_backup'
  | 'unsupported_version'
  | 'lock_timeout'
  | 'conflict_exhausted'
  | 'io_error'

export interface ErrorEnvelope {
  ok: false
  error: ErrorCode
  message?: string
}

export interface ReadOk {
  ok: true
  doc: Doc
  warnings?: string[]
}

export type ReadResult = ReadOk | ErrorEnvelope

export interface ApplyOk {
  ok: true
  changed: boolean
  rev: number
  result: unknown
  warnings?: string[]
  attempts?: number
  doc: Doc
}

export type ApplyResult = ApplyOk | ErrorEnvelope
