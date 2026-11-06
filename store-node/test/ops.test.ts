// Pure core: applyOp semantics, validation, trim/code-point rules, invariants under random op sequences.
import { expect, test } from "bun:test"
import {
  StoreError,
  applyOp,
  cpLen,
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
} from "../../plugin/hooks/store/index.ts"
import type { Doc, Item, Op } from "../../plugin/hooks/store/index.ts"

const T0 = "2026-01-01T09:00:00.000Z"
const T1 = "2026-01-01T10:00:00.000Z"
const mkItem = (id: string, order: number, extra: Partial<Item> = {}): Item => ({
  id, title: id.toUpperCase(), body: "", status: "todo", order, createdAt: T0, updatedAt: T0, ...extra,
})
const mkDoc = (ids: string[], rev = 3): Doc => ({ schemaVersion: 1, rev, items: ids.map((id, i) => mkItem(id, i)) })
let counter = 0
const gen = () => `g${++counter}`
const code = (fn: () => unknown): string => {
  try { fn() } catch (e) { return e instanceof StoreError ? e.code : `other:${String(e)}` }
  return "none"
}

test("trimTtd removes exactly the contract set, not the built-in trim set", () => {
  for (const c of ["\u0009", "\u000a", "\u000b", "\u000c", "\u000d", "\u0020", "\u00a0", "\u2028", "\u2029", "\ufeff"]) {
    expect(trimTtd(`${c}${c}x y${c}`)).toBe("x y")
  }
  // JS trim() strips these, the contract does not
  for (const c of ["\u1680", "\u2000", "\u2003", "\u200a", "\u202f", "\u205f", "\u3000", "\u0085", "\u200b"]) {
    expect(trimTtd(`${c}x${c}`)).toBe(`${c}x${c}`)
  }
  expect(trimTtd("   ")).toBe("")
  expect(trimTtd("")).toBe("")
})

test("cpLen counts code points, not UTF-16 units", () => {
  expect(cpLen("😀")).toBe(1)
  expect("😀".length).toBe(2)
  expect(cpLen("a😀b")).toBe(3)
  expect(cpLen("😀".repeat(200))).toBe(200)
})

test("id regex", () => {
  for (const ok of ["a", "A_b-9", "t_lq2x9a1b4k", "x".repeat(64)]) expect(isValidId(ok)).toBe(true)
  for (const bad of ["", "x".repeat(65), "bad id!", "a.b", "é", "a/b"]) expect(isValidId(bad)).toBe(false)
  expect(isValidId(5 as unknown as string)).toBe(false)
})

test("generated id format: t_ + base36 ms + 6 random base36", () => {
  const id = makeId(T0, () => 0.5)
  expect(id).toBe("t_" + Date.parse(T0).toString(36) + "iiiiii")
  expect(makeId(T0, () => 0)).toBe("t_" + Date.parse(T0).toString(36) + "000000")
  expect(makeId(T0, () => 0.999999999)).toMatch(/^t_[0-9a-z]+z{6}$/)
  expect(isValidId(makeId(T1, Math.random))).toBe(true)
})

test("title and body validation with code-point limits", () => {
  const d = mkDoc(["a"])
  expect(code(() => applyOp(d, { op: "add", title: "😀".repeat(200) }, T1, gen))).toBe("none")
  expect(code(() => applyOp(d, { op: "add", title: "😀".repeat(201) }, T1, gen))).toBe("too_long")
  expect(code(() => applyOp(d, { op: "add", title: "x", body: "😀".repeat(10000) }, T1, gen))).toBe("none")
  expect(code(() => applyOp(d, { op: "add", title: "x", body: "😀".repeat(10001) }, T1, gen))).toBe("too_long")
  expect(code(() => applyOp(d, { op: "add", title: "  \t " }, T1, gen))).toBe("invalid_title")
  expect(code(() => applyOp(d, { op: "add", title: "a\nb" }, T1, gen))).toBe("invalid_title")
  expect(code(() => applyOp(d, { op: "add", title: "a\u0000" }, T1, gen))).toBe("invalid_title")
  expect(code(() => applyOp(d, { op: "add", title: "a\u007fb" }, T1, gen))).toBe("none") // DEL is >= U+0020
  expect(code(() => applyOp(d, { op: "add", title: null } as unknown as Op, T1, gen))).toBe("invalid_op")
  expect(code(() => applyOp(d, { op: "add" } as unknown as Op, T1, gen))).toBe("invalid_op")
  expect(code(() => applyOp(d, { op: "add", title: 5 } as unknown as Op, T1, gen))).toBe("invalid_op")
  // title is trimmed before the length check; body is stored as given
  const r = applyOp(d, { op: "add", title: "  hi  ", body: "  b\n" }, T1, gen)
  expect((r.result as { item: Item }).item.title).toBe("hi")
  expect((r.result as { item: Item }).item.body).toBe("  b\n")
  expect(code(() => applyOp(d, { op: "add", title: " " + "x".repeat(200) + " " }, T1, gen))).toBe("none")
})

test("lone surrogates are rejected (serde_json cannot read the escaped form back)", () => {
  const d = mkDoc(["a"])
  expect(code(() => applyOp(d, { op: "add", title: "a\ud83d" }, T1, gen))).toBe("invalid_title")
  expect(code(() => applyOp(d, { op: "add", title: "x", body: "\ude00b" }, T1, gen))).toBe("invalid_op")
  expect(code(() => applyOp(d, { op: "update", id: "a", title: "\ud83dx" }, T1, gen))).toBe("invalid_title")
  expect(code(() => applyOp(d, { op: "add", title: "ok 😀" }, T1, gen))).toBe("none")
})

test("shape errors are invalid_op", () => {
  const d = mkDoc(["a", "b"])
  const bad: unknown[] = [
    null, 5, "add", [], {}, { op: 7 }, { op: "frobnicate" },
    { op: "add", title: "x", status: "blocked" },
    { op: "add", title: "x", id: "bad id!" },
    { op: "add", title: "x", id: 5 },
    { op: "add", title: "x", id: null },
    { op: "add", title: "x", body: null },
    { op: "add", title: "x", body: 1 },
    { op: "update", id: "a" },
    { op: "update", id: "a", body: 123 },
    { op: "update", id: "a", title: null },
    { op: "update", title: "x" },
    { op: "set_status", id: "a", status: "DONE" },
    { op: "set_status", id: "a" },
    { op: "move", id: "a" },
    { op: "move", id: "a", after: 5 },
    { op: "move", id: "a", after: "bad id!" },
    { op: "move", id: "a", after: "a" },
    { op: "delete" },
    { op: "delete", id: 5 },
  ]
  for (const op of bad) expect(code(() => applyOp(d, op as Op, T1, gen)), JSON.stringify(op)).toBe("invalid_op")
  for (const op of bad) expect(code(() => validateOp(op)), JSON.stringify(op)).toBe("invalid_op")
})

test("validation precedes lookup: bad title on a missing id is invalid_title, not not_found", () => {
  const d = mkDoc(["a"])
  expect(code(() => applyOp(d, { op: "update", id: "nope", title: " " }, T1, gen))).toBe("invalid_title")
  expect(code(() => applyOp(d, { op: "update", id: "nope", title: "ok" }, T1, gen))).toBe("not_found")
  expect(code(() => applyOp(d, { op: "set_status", id: "nope", status: "done" }, T1, gen))).toBe("not_found")
  // existing id with an invalid title is still an error (not the idempotent no-op)
  expect(code(() => applyOp(d, { op: "add", id: "a", title: "" }, T1, gen))).toBe("invalid_title")
})

test("add appends, uses status/id, is idempotent on an existing id", () => {
  const d = mkDoc(["a", "b"])
  const r = applyOp(d, { op: "add", id: "n", title: "New", status: "in_progress" }, T1, gen)
  expect(r.changed).toBe(true)
  expect(r.doc.items.map((i) => i.id)).toEqual(["a", "b", "n"])
  expect(r.result).toEqual({
    item: { id: "n", title: "New", body: "", status: "in_progress", order: 2, createdAt: T1, updatedAt: T1 },
  })
  const dup = applyOp(r.doc, { op: "add", id: "n", title: "Other" }, T1, gen)
  expect(dup.changed).toBe(false)
  expect((dup.result as { item: Item }).item.title).toBe("New")
  expect(dup.doc).toEqual(r.doc)
})

test("add without id uses newId and regenerates on a collision (never eats the add)", () => {
  const d = mkDoc(["g1", "g2"])
  let n = 0
  const r = applyOp(d, { op: "add", title: "x" }, T1, () => `g${++n}`)
  expect(r.changed).toBe(true)
  expect((r.result as { item: Item }).item.id).toBe("g3")
  expect(r.doc.items.length).toBe(3)
})

test("update: provided fields only, changed only on difference, trimmed compare, updatedAt bump", () => {
  const d = mkDoc(["a"])
  const same = applyOp(d, { op: "update", id: "a", title: "  A  ", body: "" }, T1, gen)
  expect(same.changed).toBe(false)
  expect(same.doc.items[0].updatedAt).toBe(T0)
  const t = applyOp(d, { op: "update", id: "a", title: " New " }, T1, gen)
  expect(t.changed).toBe(true)
  expect(t.doc.items[0]).toMatchObject({ title: "New", body: "", updatedAt: T1, createdAt: T0 })
  const b = applyOp(d, { op: "update", id: "a", body: "text" }, T1, gen)
  expect(b.doc.items[0]).toMatchObject({ title: "A", body: "text", updatedAt: T1 })
})

test("set_status: same status is a no-op", () => {
  const d = mkDoc(["a"])
  expect(applyOp(d, { op: "set_status", id: "a", status: "todo" }, T1, gen).changed).toBe(false)
  const r = applyOp(d, { op: "set_status", id: "a", status: "done" }, T1, gen)
  expect(r.changed).toBe(true)
  expect(r.doc.items[0]).toMatchObject({ status: "done", updatedAt: T1 })
})

test("move: relative, renumbers, no updatedAt bump, no-op when position is unchanged", () => {
  const d = mkDoc(["a", "b", "c", "d"])
  const top = applyOp(d, { op: "move", id: "d", after: null }, T1, gen)
  expect(top.doc.items.map((i) => i.id)).toEqual(["d", "a", "b", "c"])
  expect(top.doc.items.map((i) => i.order)).toEqual([0, 1, 2, 3])
  expect(top.doc.items.every((i) => i.updatedAt === T0)).toBe(true)
  expect((top.result as { item: Item }).item.order).toBe(0)
  const mid = applyOp(d, { op: "move", id: "a", after: "c" }, T1, gen)
  expect(mid.doc.items.map((i) => i.id)).toEqual(["b", "c", "a", "d"])
  expect(applyOp(d, { op: "move", id: "b", after: "a" }, T1, gen).changed).toBe(false)
  expect(applyOp(d, { op: "move", id: "a", after: null }, T1, gen).changed).toBe(false)
  expect(code(() => applyOp(d, { op: "move", id: "a", after: "a" }, T1, gen))).toBe("invalid_op")
  expect(code(() => applyOp(d, { op: "move", id: "a", after: "zz" }, T1, gen))).toBe("not_found")
  expect(code(() => applyOp(d, { op: "move", id: "zz", after: null }, T1, gen))).toBe("not_found")
})

test("delete: removes and renumbers; missing id is an idempotent success", () => {
  const d = mkDoc(["a", "b", "c"])
  const r = applyOp(d, { op: "delete", id: "b" }, T1, gen)
  expect(r.changed).toBe(true)
  expect(r.result).toEqual({ id: "b" })
  expect(r.doc.items.map((i) => [i.id, i.order])).toEqual([["a", 0], ["c", 1]])
  const miss = applyOp(d, { op: "delete", id: "zz" }, T1, gen)
  expect(miss.changed).toBe(false)
  expect(miss.result).toEqual({ id: "zz" })
})

test("reset_corrupt is not an apply-level op on a parsed doc", () => {
  expect(code(() => applyOp(mkDoc(["a"]), { op: "reset_corrupt" }, T1, gen))).toBe("not_corrupt")
})

test("1000 item limit", () => {
  const ids = Array.from({ length: 999 }, (_, i) => `i${i}`)
  const d = mkDoc(ids)
  const r = applyOp(d, { op: "add", title: "last" }, T1, gen)
  expect(r.doc.items.length).toBe(1000)
  expect(code(() => applyOp(r.doc, { op: "add", title: "over" }, T1, gen))).toBe("limit_exceeded")
  // idempotent re-add at the limit is still fine
  expect(applyOp(r.doc, { op: "add", id: "i5", title: "dup" }, T1, gen).changed).toBe(false)
})

test("normalise sorts by (order, createdAt, id) with plain string compare and renumbers", () => {
  const doc: Doc = {
    schemaVersion: 1, rev: 9,
    items: [
      mkItem("c", 5, { createdAt: "2026-01-01T08:02:00.000Z" }),
      mkItem("B", 1, { createdAt: "2026-01-01T08:01:00.000Z" }),
      mkItem("b", 1, { createdAt: "2026-01-01T08:01:00.000Z" }),
      mkItem("a", 1, { createdAt: "2026-01-01T08:00:00.000Z" }),
    ],
  }
  const n = normalise(doc)
  expect(n.items.map((i) => [i.id, i.order])).toEqual([["a", 0], ["B", 1], ["b", 2], ["c", 3]])
  expect(doc.items[0].order).toBe(5) // input untouched
})

test("parseDoc: valid, absent-equivalent, unknown fields kept", () => {
  const d = { schemaVersion: 1, rev: 2, items: [{ ...mkItem("a", 0), color: "red" }], meta: { n: 1 } }
  const p = parseDoc(JSON.stringify(d))
  expect(p.kind).toBe("ok")
  if (p.kind === "ok") expect(p.doc).toEqual(d)
  expect(emptyDoc()).toEqual({ schemaVersion: 1, rev: 0, items: [] })
})

test("parseDoc: corrupt list from STORE.md section 8, and nothing stricter", () => {
  const ok = { schemaVersion: 1, rev: 1, items: [mkItem("a", 0)] }
  const corrupt: unknown[] = [
    "{not json", "", "[]", "null", "5", '"s"',
    { ...ok, schemaVersion: "1" }, { ...ok, schemaVersion: 1.5 }, { ...ok, schemaVersion: 0 },
    { ...ok, rev: "1" }, { ...ok, rev: 1.5 }, { schemaVersion: 1, items: [] },
    { ...ok, items: {} }, { ...ok, items: null },
    { ...ok, items: [null] }, { ...ok, items: [[]] },
    { ...ok, items: [{ ...mkItem("a", 0), status: "blocked" }] },
    { ...ok, items: [{ ...mkItem("a", 0), id: "bad id!" }] },
    { ...ok, items: [{ ...mkItem("a", 0), id: 5 }] },
    { ...ok, items: [{ ...mkItem("a", 0), order: 0.5 }] },
    { ...ok, items: [{ ...mkItem("a", 0), order: "0" }] },
    { ...ok, items: [{ ...mkItem("a", 0), title: 5 }] },
    { ...ok, items: [{ ...mkItem("a", 0), body: null }] },
    { ...ok, items: [{ ...mkItem("a", 0), createdAt: 5 }] },
    { ...ok, items: [{ ...mkItem("a", 0), updatedAt: undefined }] },
    { ...ok, items: [mkItem("a", 0), mkItem("a", 1)] },
  ]
  for (const c of corrupt) {
    const text = typeof c === "string" ? c : JSON.stringify(c)
    expect(parseDoc(text).kind, text.slice(0, 80)).toBe("corrupt")
  }
  const lenient: Item[] = [
    mkItem("a", 0, { title: "" }),
    mkItem("b", 1, { title: "x".repeat(500), body: "y".repeat(20000) }),
    mkItem("c", 2, { title: "a\nb", createdAt: "yesterday" }),
  ]
  expect(parseDoc(JSON.stringify({ ...ok, items: lenient })).kind).toBe("ok")
})

test("parseDoc: higher schemaVersion is unsupported_version before any structural check", () => {
  expect(parseDoc(JSON.stringify({ schemaVersion: 2, rev: 4, items: [], newField: true })).kind).toBe("unsupported_version")
  expect(parseDoc(JSON.stringify({ schemaVersion: 2, items: "weird" })).kind).toBe("unsupported_version")
  expect(parseDoc(JSON.stringify({ schemaVersion: 99 })).kind).toBe("unsupported_version")
})

test("serialize: 2-space JSON with trailing newline", () => {
  const d = mkDoc(["a"])
  expect(serialize(d)).toBe(JSON.stringify(d, null, 2) + "\n")
})

test("scrapeRev", () => {
  expect(scrapeRev('{"schemaVersion":1,"rev":7,"items":[{"id":"t1","title":"half writ')).toBe(7)
  expect(scrapeRev('{ "rev" :  12 , ')).toBe(12)
  expect(scrapeRev("{not json")).toBe(0)
  expect(scrapeRev("")).toBe(0)
})

test("resolveHomeDir and joinPath", () => {
  expect(resolveHomeDir({ TTD_HOME: "/x/y", USERPROFILE: "C:\\u", HOME: "/h" })).toBe("/x/y")
  expect(resolveHomeDir({ TTD_HOME: "", USERPROFILE: "", HOME: "/h" })).toBe("/h/.ttd")
  expect(resolveHomeDir({ USERPROFILE: "C:\\Users\\k", HOME: "/h" })).toBe("C:\\Users\\k\\.ttd")
  expect(resolveHomeDir({ HOME: "/home/k" })).toBe("/home/k/.ttd")
  expect(resolveHomeDir({})).toBe("")
  expect(joinPath("/a/b", "todos.json")).toBe("/a/b/todos.json")
  expect(joinPath("/a/b/", "todos.json")).toBe("/a/b/todos.json")
  expect(joinPath("C:\\a\\b", "todos.json")).toBe("C:\\a\\b\\todos.json")
  expect(joinPath("C:/a", "x")).toBe("C:\\a\\x")
})

// ---- seeded random op sequences -------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test("random op sequences keep invariants and match a reference model", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rnd = mulberry32(seed)
    const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]
    let doc: Doc = { schemaVersion: 1, rev: 0, items: [] }
    const model: string[] = []
    let next = 0
    for (let step = 0; step < 60; step++) {
      const before = JSON.stringify(doc)
      const ids = model.length ? model : ["ghost"]
      const kind = pick(["add", "add", "add", "update", "set_status", "move", "move", "delete", "delete-missing", "dup-add"])
      let op: Op
      const now = `2026-01-01T09:${String(step % 60).padStart(2, "0")}:00.000Z`
      switch (kind) {
        case "add": op = { op: "add", id: `i${next++}`, title: `t${rnd()}` }; break
        case "dup-add": op = { op: "add", id: pick(ids), title: "dup" }; break
        case "update": op = { op: "update", id: pick(ids), title: `u${Math.floor(rnd() * 3)}` }; break
        case "set_status": op = { op: "set_status", id: pick(ids), status: pick(["todo", "in_progress", "done"] as const) }; break
        case "move": {
          const id = pick(ids)
          const after = rnd() < 0.25 ? null : pick(ids)
          op = { op: "move", id, after }
          break
        }
        case "delete": op = { op: "delete", id: pick(ids) }; break
        default: op = { op: "delete", id: "missing" + step }
      }
      let r
      try {
        r = applyOp(doc, op, now, gen)
      } catch (e) {
        expect(e instanceof StoreError).toBe(true)
        expect(JSON.stringify(doc)).toBe(before)
        continue
      }
      expect(JSON.stringify(doc), "input mutated").toBe(before)
      expect(r.doc.rev, "rev touched by apply").toBe(doc.rev)
      // reference model
      if (op.op === "add" && !model.includes(op.id!)) model.push(op.id!)
      if (op.op === "delete") { const i = model.indexOf(op.id); if (i >= 0) model.splice(i, 1) }
      if (op.op === "move" && model.includes(op.id)) {
        const m = model.filter((x) => x !== op.id)
        m.splice(op.after === null ? 0 : m.indexOf(op.after) + 1, 0, op.id)
        model.splice(0, model.length, ...m)
      }
      expect(r.doc.items.map((i) => i.id)).toEqual(model)
      expect(r.doc.items.map((i) => i.order)).toEqual(model.map((_, i) => i))
      expect(new Set(r.doc.items.map((i) => i.id)).size).toBe(r.doc.items.length)
      if (!r.changed) expect(r.doc).toEqual(normalise(doc))
      doc = { ...r.doc, rev: doc.rev + (r.changed ? 1 : 0) }
    }
  }
})
