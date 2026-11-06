// Contract fixture harness (STORE.md section 11): real files in a fresh temp TTD_HOME.
import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStore } from "../../plugin/hooks/store/index.ts"
import { createNodeIO } from "../node-io.ts"

const FIXTURE_DIR = join(import.meta.dir, "../../docs/contract/fixtures")
const homes: string[] = []
afterAll(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true })
})

type Raw = { raw: string }
const isRaw = (v: unknown): v is Raw => typeof v === "object" && v !== null && "raw" in v
const asText = (v: unknown): string => (isRaw(v) ? v.raw : JSON.stringify(v, null, 2) + "\n")

const names = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json")).sort()

test("all 14 fixtures are present", () => {
  expect(names.length).toBe(14)
})

for (const name of names) {
  test(`fixture ${name}`, async () => {
    const fx = JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"))
    const home = mkdtempSync(join(tmpdir(), "ttd-fx-"))
    homes.push(home)
    const todos = join(home, "todos.json")
    if (fx.setup.file !== null) writeFileSync(todos, asText(fx.setup.file))
    if (fx.setup.bak !== null) writeFileSync(todos + ".bak", asText(fx.setup.bak))
    if (fx.setup.lock !== null) {
      mkdirSync(join(home, "store.lock"))
      writeFileSync(
        join(home, "store.lock", "owner.json"),
        JSON.stringify({ token: "foreignlock1", pid: 1, ts: Date.now() - fx.setup.lock.ownerAgeMs }),
      )
    }
    const store = createStore(createNodeIO(), home, fx.options ?? {})

    for (const [i, step] of fx.steps.entries()) {
      const where = `${name} step ${i}`
      let env: any
      if (step.read) {
        env = await store.read()
      } else {
        let fired = false
        const ctx: any = { now: step.now }
        if (step.seam?.beforeCommit?.replaceFile) {
          ctx.beforeCommit = async () => {
            if (fired) return // the lock-violating writer acts once per step
            fired = true
            writeFileSync(todos, asText(step.seam.beforeCommit.replaceFile))
          }
        }
        env = await store.apply(step.op, ctx)
      }
      const exp = step.expect
      expect(env.ok, where).toBe(exp.ok)
      if (exp.ok === false) {
        expect(env.error, where).toBe(exp.error)
        continue
      }
      expect(env.warnings, `${where} warnings`).toEqual(exp.warnings ?? [])
      for (const k of ["changed", "rev", "result", "attempts", "doc"]) {
        if (k in exp) expect(env[k], `${where} ${k}`).toEqual(exp[k])
      }
    }

    const files = readdirSync(home)
    const fin = fx.final
    if (fin.file === "absent") expect(existsSync(todos)).toBe(false)
    else if (isRaw(fin.file)) expect(readFileSync(todos, "utf8")).toBe(fin.file.raw)
    else expect(JSON.parse(readFileSync(todos, "utf8"))).toEqual(fin.file)
    if ("bakExists" in fin) expect(existsSync(todos + ".bak"), "bakExists").toBe(fin.bakExists)
    if (fin.bakEqualsFile) expect(readFileSync(todos + ".bak", "utf8"), "bakEqualsFile").toBe(readFileSync(todos, "utf8"))
    const quarantined = files.filter((f) => /^todos\.corrupt-.*\.json$/.test(f))
    expect(quarantined.length, "quarantined").toBe(fin.quarantined)
    if (fin.quarantinedRaw) {
      const raws = quarantined.map((f) => readFileSync(join(home, f), "utf8")).sort()
      expect(raws).toEqual([...fin.quarantinedRaw].sort())
    }
    expect(existsSync(join(home, "store.lock")), "lockDir").toBe(fin.lockDir)
    expect(files.filter((f) => f.startsWith(".todos.json.tmp-")).length, "tmpFiles").toBe(fin.tmpFiles)
  }, 20000)
}
