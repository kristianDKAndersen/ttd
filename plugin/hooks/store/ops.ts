// Pure store semantics: validation, normalisation and the six ops (docs/contract/STORE.md sections 2, 3, 8).
import { MAX_BODY, MAX_ITEMS, MAX_TITLE, SCHEMA_VERSION, STATUSES, StoreError } from "./types.ts"
import type { Doc, Item, Op, OpResult, Status } from "./types.ts"

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const B36 = "0123456789abcdefghijklmnopqrstuvwxyz"

export type ParsedDoc = { kind: "ok"; doc: Doc } | { kind: "corrupt" } | { kind: "unsupported_version" }

type Rec = Record<string, unknown>
const isObj = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v)
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v)
const isStr = (v: unknown): v is string => typeof v === "string"
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0) // never localeCompare: Rust compares bytes

export function isValidId(v: unknown): v is string {
  return isStr(v) && ID_RE.test(v)
}

// Only these code points are trimmed (JS trim and Rust trim each strip a different, larger set).
function isTrimChar(c: number): boolean {
  return (c >= 0x09 && c <= 0x0d) || c === 0x20 || c === 0xa0 || c === 0x2028 || c === 0x2029 || c === 0xfeff
}

export function trimTtd(s: string): string {
  let a = 0
  let b = s.length
  while (a < b && isTrimChar(s.charCodeAt(a))) a++
  while (b > a && isTrimChar(s.charCodeAt(b - 1))) b--
  return s.slice(a, b)
}

export function cpLen(s: string): number {
  let n = 0
  for (const _ of s) n++
  return n
}

// serde_json rejects the escaped form of an unpaired surrogate, so a TS write containing one would read as
// corrupt in the Rust window. Such text is refused up front.
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) i++
      else return true
    } else if (c >= 0xdc00 && c <= 0xdfff) return true
  }
  return false
}

function randomChars(random: () => number, n: number): string {
  let s = ""
  for (let i = 0; i < n; i++) s += B36[Math.min(35, Math.floor(random() * 36))]
  return s
}

export const randomToken = (random: () => number): string => randomChars(random, 12)

export function makeId(nowIso: string, random: () => number): string {
  return "t_" + Date.parse(nowIso).toString(36) + randomChars(random, 6)
}

export function compactTimestamp(iso: string): string {
  return iso.slice(0, 19).replace(/[-:]/g, "") + "Z"
}

export function emptyDoc(): Doc {
  return { schemaVersion: SCHEMA_VERSION, rev: 0, items: [] }
}

export function serialize(doc: Doc): string {
  return JSON.stringify(doc, null, 2) + "\n"
}

export function scrapeRev(text: string): number {
  const m = /"rev"\s*:\s*(\d+)/.exec(text)
  if (!m) return 0
  const n = Number(m[1])
  return Number.isSafeInteger(n) ? n : 0
}

// ---- paths ----------------------------------------------------------------------------------

export function joinPath(dir: string, name: string): string {
  const win = /^[A-Za-z]:/.test(dir) || dir.indexOf("\\") >= 0
  if (win) return dir.replace(/\//g, "\\").replace(/\\+$/, "") + "\\" + name
  return dir.replace(/\/+$/, "") + "/" + name
}

export function resolveHomeDir(env: { TTD_HOME?: string; USERPROFILE?: string; HOME?: string }): string {
  if (env.TTD_HOME) return env.TTD_HOME
  if (env.USERPROFILE) return joinPath(env.USERPROFILE, ".ttd")
  if (env.HOME) return joinPath(env.HOME, ".ttd")
  return ""
}

// ---- document validation (section 8: exactly the corrupt list, nothing stricter) -------------

export function parseDoc(text: string): ParsedDoc {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return { kind: "corrupt" }
  }
  if (!isObj(v)) return { kind: "corrupt" }
  if (isInt(v.schemaVersion) && v.schemaVersion > SCHEMA_VERSION) return { kind: "unsupported_version" }
  if (v.schemaVersion !== SCHEMA_VERSION) return { kind: "corrupt" }
  if (!isInt(v.rev) || v.rev < 0) return { kind: "corrupt" }
  if (!Array.isArray(v.items)) return { kind: "corrupt" }
  const seen = new Set<string>()
  for (const it of v.items as unknown[]) {
    if (!isObj(it)) return { kind: "corrupt" }
    if (!isValidId(it.id) || seen.has(it.id)) return { kind: "corrupt" }
    seen.add(it.id)
    if (!isStr(it.title) || !isStr(it.body) || !isStr(it.createdAt) || !isStr(it.updatedAt)) return { kind: "corrupt" }
    if (!STATUSES.includes(it.status as Status)) return { kind: "corrupt" }
    if (!isInt(it.order)) return { kind: "corrupt" }
  }
  return { kind: "ok", doc: v as Doc }
}

// Presentation order (order, createdAt, id), order renumbered 0..n-1. Pure: never mutates the input.
export function normalise(doc: Doc): Doc {
  const sorted = doc.items.slice().sort((a, b) => a.order - b.order || cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id))
  return { ...doc, items: sorted.map((it, i) => ({ ...it, order: i })) }
}

// ---- op validation ----------------------------------------------------------------------------

const bad = (msg: string): never => {
  throw new StoreError("invalid_op", msg)
}

function checkId(v: unknown, what: string): void {
  if (!isValidId(v)) bad(`${what} must be a string matching [A-Za-z0-9_-]{1,64}`)
}

function checkTitleValue(raw: string): string {
  const t = trimTtd(raw)
  if (t === "") throw new StoreError("invalid_title")
  for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) < 0x20) throw new StoreError("invalid_title")
  if (hasLoneSurrogate(t)) throw new StoreError("invalid_title")
  if (cpLen(t) > MAX_TITLE) throw new StoreError("too_long")
  return t
}

function checkBodyValue(b: string): void {
  if (cpLen(b) > MAX_BODY) throw new StoreError("too_long")
}

// Shape and field types (invalid_op) first, then field values (invalid_title, too_long). No lookups.
export function validateOp(op: unknown): void {
  if (!isObj(op) || !isStr(op.op)) return bad("op must be an object with a string 'op'")
  switch (op.op) {
    case "add": {
      if (!isStr(op.title)) bad("title must be a string")
      if (op.id !== undefined) checkId(op.id, "id")
      if (op.body !== undefined && (!isStr(op.body) || hasLoneSurrogate(op.body))) bad("body must be a well-formed string")
      if (op.status !== undefined && !STATUSES.includes(op.status as Status)) bad("status must be todo, in_progress or done")
      checkTitleValue(op.title as string)
      if (op.body !== undefined) checkBodyValue(op.body as string)
      return
    }
    case "update": {
      checkId(op.id, "id")
      if (op.title !== undefined && !isStr(op.title)) bad("title must be a string")
      if (op.body !== undefined && (!isStr(op.body) || hasLoneSurrogate(op.body))) bad("body must be a well-formed string")
      if (op.title === undefined && op.body === undefined) bad("update needs title or body")
      if (op.title !== undefined) checkTitleValue(op.title as string)
      if (op.body !== undefined) checkBodyValue(op.body as string)
      return
    }
    case "set_status":
      checkId(op.id, "id")
      if (!STATUSES.includes(op.status as Status)) bad("status must be todo, in_progress or done")
      return
    case "move":
      checkId(op.id, "id")
      if (op.after !== null) checkId(op.after, "after (an id or null)")
      if (op.after === op.id) bad("after must differ from id")
      return
    case "delete":
      checkId(op.id, "id")
      return
    case "reset_corrupt":
      return
    default:
      return bad(`unknown op ${JSON.stringify(op.op)}`)
  }
}

// ---- apply -------------------------------------------------------------------------------------

export interface Applied {
  doc: Doc
  changed: boolean
  result: OpResult
}

const copy = (it: Item): Item => ({ ...it })
const noChange = (doc: Doc, result: OpResult): Applied => ({ doc, changed: false, result })

function find(items: Item[], id: string): Item {
  for (const it of items) if (it.id === id) return it
  throw new StoreError("not_found")
}
const has = (items: Item[], id: string): boolean => items.some((it) => it.id === id)

// apply(doc, op, now, newId): pure, throws StoreError, never touches rev, never mutates doc.
export function applyOp(doc: Doc, op: Op, now: string, newId: () => string): Applied {
  validateOp(op)
  const base = normalise(doc)
  const items = base.items
  const withItems = (next: Item[]): Doc => ({ ...base, items: next.map((it, i) => (it.order === i ? it : { ...it, order: i })) })

  switch (op.op) {
    case "add": {
      let id = op.id
      if (id !== undefined) {
        if (has(items, id)) return noChange(base, { item: copy(find(items, id)) })
      } else {
        for (let tries = 0; tries < 8 && id === undefined; tries++) {
          const cand = newId()
          if (!has(items, cand)) id = cand
        }
        if (id === undefined) throw new StoreError("io_error", "could not generate a unique id")
      }
      if (items.length >= MAX_ITEMS) throw new StoreError("limit_exceeded")
      const item: Item = {
        id,
        title: trimTtd(op.title),
        body: op.body ?? "",
        status: op.status ?? "todo",
        order: items.length,
        createdAt: now,
        updatedAt: now,
      }
      return { doc: withItems([...items, item]), changed: true, result: { item: copy(item) } }
    }
    case "update": {
      const cur = find(items, op.id)
      const title = op.title === undefined ? cur.title : trimTtd(op.title)
      const body = op.body === undefined ? cur.body : op.body
      if (title === cur.title && body === cur.body) return noChange(base, { item: copy(cur) })
      const next: Item = { ...cur, title, body, updatedAt: now }
      return { doc: withItems(items.map((it) => (it === cur ? next : it))), changed: true, result: { item: copy(next) } }
    }
    case "set_status": {
      const cur = find(items, op.id)
      if (cur.status === op.status) return noChange(base, { item: copy(cur) })
      const next: Item = { ...cur, status: op.status, updatedAt: now }
      return { doc: withItems(items.map((it) => (it === cur ? next : it))), changed: true, result: { item: copy(next) } }
    }
    case "move": {
      const cur = find(items, op.id)
      if (op.after !== null) find(items, op.after)
      const rest = items.filter((it) => it !== cur)
      const at = op.after === null ? 0 : rest.findIndex((it) => it.id === op.after) + 1
      const moved = [...rest.slice(0, at), cur, ...rest.slice(at)]
      if (moved.every((it, i) => it === items[i])) return noChange(base, { item: copy(cur) })
      const out = withItems(moved)
      return { doc: out, changed: true, result: { item: copy(find(out.items, op.id)) } }
    }
    case "delete": {
      if (!has(items, op.id)) return noChange(base, { id: op.id })
      return { doc: withItems(items.filter((it) => it.id !== op.id)), changed: true, result: { id: op.id } }
    }
    case "reset_corrupt":
      throw new StoreError("not_corrupt")
  }
}
