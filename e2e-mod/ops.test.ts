// Real-file tests of the mod's write path: /ttd op through `claude -p`, TTD_HOME = a temp dir.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ID_RE, cleanup, files, op, readTodos, replayFixture, runClaude, say, tmpDir } from "./harness.ts"

setDefaultTimeout(180_000)
afterAll(cleanup)

test("a) add -> todos.json is valid, rev 1, exit 0, no leftovers", async () => {
  const home = join(tmpDir(), "ttd") // the directory does not exist yet: the mod creates it
  const r = await op(home, { op: "add", title: "  First todo  ", body: "with a body" })
  expect(r.code, say(r)).toBe(0)
  expect(r.env.ok).toBe(true)
  expect(r.env.changed).toBe(true)
  expect(r.env.rev).toBe(1)
  const doc = readTodos(home)
  expect(doc.schemaVersion).toBe(1)
  expect(doc.rev).toBe(1)
  expect(doc.items.length).toBe(1)
  const it = doc.items[0]
  expect(it.id).toMatch(ID_RE) // generated in the mod: Math.random/Date are available there
  expect(it.title).toBe("First todo")
  expect(it.body).toBe("with a body")
  expect(it.status).toBe("todo")
  expect(it.order).toBe(0)
  expect(it.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  expect(r.env.doc.rev).toBe(1)
  const names = files(home)
  expect(names).toContain("todos.json")
  expect(names).not.toContain("store.lock")
  expect(names.filter((n) => n.startsWith(".todos.json.tmp-"))).toEqual([])
  expect(readFileSync(join(home, "todos.json.bak"), "utf8")).toBe(readFileSync(join(home, "todos.json"), "utf8")) // bak = the latest commit

  const again = await op(home, { op: "add", title: "Second" })
  expect(again.env.rev).toBe(2)
  expect(readTodos(home).items.map((i: any) => i.order)).toEqual([0, 1])
  expect(JSON.parse(readFileSync(join(home, "todos.json.bak"), "utf8")).rev).toBe(2) // the latest commit, not the previous one
  expect(readFileSync(join(home, "todos.json.bak"), "utf8")).toBe(readFileSync(join(home, "todos.json"), "utf8"))
})

test("b) fixtures 01 and 02 replayed through the mod give the contract results", async () => {
  await Promise.all([replayFixture("01-add-status-update-delete.json"), replayFixture("02-move-relative.json", { exactTimes: true })])
})

test("c) not_found: exit 1 and the envelope on stdout; the file is untouched", async () => {
  const home = join(tmpDir(), "ttd")
  await op(home, { op: "add", id: "t1", title: "One" })
  const before = readFileSync(join(home, "todos.json"), "utf8")
  const r = await op(home, { op: "set_status", id: "t_nope", status: "done" })
  expect(r.code, say(r)).toBe(1)
  expect(r.env).toEqual({ ok: false, error: "not_found" })
  expect(readFileSync(join(home, "todos.json"), "utf8")).toBe(before)
  expect(readdirSync(home).filter((n) => n.startsWith(".todos.json.tmp-") || n === "store.lock")).toEqual([])

  const bad = await runClaude("/ttd op 'definitely not json'", { home })
  expect(bad.code, say(bad)).toBe(1)
  expect(JSON.parse(bad.out).error).toBe("invalid_op")
})

test("human subcommands write through the same core", async () => {
  const home = join(tmpDir(), "ttd")
  const added = await runClaude("/ttd add 'Buy milk'", { home })
  expect(added.code, say(added)).toBe(0)
  const id = readTodos(home).items[0].id
  expect(id).toMatch(ID_RE)
  expect((await runClaude(`/ttd start ${id}`, { home })).code).toBe(0)
  expect(readTodos(home).items[0].status).toBe("in_progress")
  const list = await runClaude("/ttd list", { home })
  expect(list.code, say(list)).toBe(0)
  expect(list.out).toContain(`[in_progress] ${id} Buy milk`)
  const path = await runClaude("/ttd path", { home })
  expect(path.out).toContain(join(home, "todos.json"))
  expect((await runClaude(`/ttd rm ${id}`, { home })).code).toBe(0)
  expect(readTodos(home).items).toEqual([])
})
