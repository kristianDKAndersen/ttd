import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8')

/** Returns the text inside the first `{ ... }` that follows `header` (balanced braces). */
function block(src: string, header: RegExp): string {
  const m = header.exec(src)
  if (!m) throw new Error(`no block for ${header}`)
  let i = src.indexOf('{', m.index)
  const start = i + 1
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i)
  }
  throw new Error('unbalanced css')
}
const token = (b: string, name: string): string | undefined => new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(b)?.[1]?.trim()

describe('status color tokens', () => {
  const light = block(css, /:root\s*\{/)
  const dark = block(css, /@media\s*\(prefers-color-scheme:\s*dark\)/)
  for (const t of ['--status-todo', '--status-in-progress', '--status-done']) {
    test(`${t} is defined in light and overridden in dark with a different value`, () => {
      const l = token(light, t)
      expect(l).toBeTruthy()
      const d = token(dark, t)
      expect(d).toBeTruthy()
      expect(d).not.toBe(l)
    })
  }
  test('rows take their background from the tokens by data-status', () => {
    expect(css).toMatch(/\[data-status="todo"\][^{]*\{[^}]*var\(--status-todo\)/)
    expect(css).toMatch(/\[data-status="in_progress"\][^{]*\{[^}]*var\(--status-in-progress\)/)
    expect(css).toMatch(/\[data-status="done"\][^{]*\{[^}]*var\(--status-done\)/)
  })
  test('the dark block overrides on :root', () => {
    expect(dark).toContain(':root')
  })
})
