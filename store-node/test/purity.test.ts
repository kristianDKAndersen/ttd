// The core is shared with the Claude Code mod (no Node runtime): ECMAScript built-ins only.
import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const CORE_DIR = join(import.meta.dir, "../../plugin/hooks/store")

const FORBIDDEN: [string, RegExp][] = [
  ["dynamic import()", /\bimport\s*\(/],
  ["require", /\brequire\s*(\(|\.)/],
  ["process", /\bprocess\s*\./],
  ["globalThis.process", /\bglobalThis\s*\.\s*process\b/],
  ["Buffer", /\bBuffer\b/],
  ["node: specifier", /['"]node:/],
  ["bare fs/path/os/child_process import", /from\s+['"](fs|path|os|child_process|crypto|util|url|events|stream)(\/[^'"]*)?['"]/],
  ["Bun global", /\bBun\s*\./],
  ["Deno global", /\bDeno\s*\./],
  ["setTimeout/setInterval (not ECMAScript; sleep comes from IO)", /\bset(Timeout|Interval)\s*\(/],
  ["structuredClone", /\bstructuredClone\s*\(/],
  ["console", /\bconsole\s*\./],
  ["import.meta", /\bimport\.meta\b/],
]

export function scan(src: string): string[] {
  const hits: string[] = []
  for (const [label, re] of FORBIDDEN) if (re.test(src)) hits.push(label)
  // every static import/export-from must be a sibling module
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/g)) {
    if (!m[1].startsWith("./")) hits.push(`non-relative import ${m[1]}`)
  }
  return hits
}

test("scanner catches each forbidden construct (not vacuous)", () => {
  expect(scan("const m = await import('x')")).toContain("dynamic import()")
  expect(scan("const fs = require('fs')")).toContain("require")
  expect(scan("process.env.HOME")).toContain("process")
  expect(scan("Buffer.from('a')")).toContain("Buffer")
  expect(scan("import { a } from 'node:fs'")).toContain("node: specifier")
  expect(scan('import { a } from "fs"')).toContain("bare fs/path/os/child_process import")
  expect(scan("import { a } from 'lodash'")).toContain("non-relative import lodash")
  expect(scan("setTimeout(f, 1)")).toBeTruthy()
  expect(scan("// a required field, processed later\nconst x = 1")).toEqual([])
  expect(scan("import type { A } from './types.ts'\nexport { b } from './ops.ts'")).toEqual([])
})

const CORE_FILES = () => readdirSync(CORE_DIR).filter((f) => f.endsWith(".ts")).sort()

test("core directory contains the four contract modules", () => {
  for (const f of ["engine.ts", "index.ts", "ops.ts", "types.ts"]) expect(CORE_FILES()).toContain(f)
})

for (const f of ["engine.ts", "index.ts", "ops.ts", "types.ts"]) {
  test(`plugin/hooks/store/${f} is pure`, () => {
    const src = readFileSync(join(CORE_DIR, f), "utf8")
    expect(scan(src)).toEqual([])
  })
}
