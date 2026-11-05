// Real processes, real files: 4 shell loops x 25 `cli.ts apply` calls against one TTD_HOME.
import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const CLI = join(import.meta.dir, "../cli.ts")
const home = mkdtempSync(join(tmpdir(), "ttd-conc-"))
afterAll(() => rmSync(home, { recursive: true, force: true }))

test("4 processes x 25 adds lose nothing", async () => {
  const script =
    'for j in $(seq 1 25); do "$BUN" "$CLI" apply "{\\"op\\":\\"add\\",\\"title\\":\\"w$W-$j\\"}" > /dev/null || exit 1; done'
  const procs = [1, 2, 3, 4].map((w) =>
    Bun.spawn(["sh", "-c", script], {
      env: { ...process.env, TTD_HOME: home, BUN: process.execPath, CLI, W: String(w) },
      stdout: "pipe",
      stderr: "pipe",
    }),
  )
  const codes = await Promise.all(procs.map((p) => p.exited))
  const errs = await Promise.all(procs.map((p) => new Response(p.stderr).text()))
  expect(codes, errs.join("\n")).toEqual([0, 0, 0, 0])

  const doc = JSON.parse(readFileSync(join(home, "todos.json"), "utf8"))
  const titles = doc.items.map((i: { title: string }) => i.title)
  expect(titles.length).toBe(100)
  expect(new Set(titles).size).toBe(100)
  for (let w = 1; w <= 4; w++) for (let j = 1; j <= 25; j++) expect(titles).toContain(`w${w}-${j}`)
  expect(doc.rev).toBe(100)
  expect(doc.schemaVersion).toBe(1)
  expect(doc.items.map((i: { order: number }) => i.order)).toEqual(Array.from({ length: 100 }, (_, i) => i))
  const files = readdirSync(home)
  expect(existsSync(join(home, "store.lock"))).toBe(false)
  expect(files.filter((f) => f.startsWith(".todos.json.tmp-"))).toEqual([])
  expect(files.filter((f) => f.startsWith("todos.corrupt-"))).toEqual([])
}, 180000)
