// The core's strict UTF-8 decoder (pure, ECMAScript only): the mod and the node IO both read todos.json through it.
import { expect, test } from "bun:test"
import { INVALID_UTF8_MARK, decodeUtf8 } from "../../plugin/hooks/store/utf8.ts"

const bytes = (...b: number[]) => Uint8Array.from(b)
const invalid = (b: Uint8Array) => decodeUtf8(b).startsWith(INVALID_UTF8_MARK)

test("valid UTF-8 round-trips exactly, including 2/3/4-byte characters, the BOM and NUL", () => {
  for (const s of ["", "plain", "Åäö", "日本語", "😀 \u{10FFFF}", "﻿{}", "a\u0000b", "x".repeat(70000) + "é"]) {
    expect(decodeUtf8(Buffer.from(s, "utf8"))).toBe(s)
  }
})

test("every malformed form is flagged: lone continuation, truncation, overlong, surrogate, out of range, bad lead", () => {
  const bad: number[][] = [
    [0x80], [0xbf], [0xff], [0xfe], [0xc0, 0x80], [0xc1, 0xbf], [0xe0, 0x80, 0x80], [0xe0, 0x9f, 0xbf],
    [0xed, 0xa0, 0x80], [0xed, 0xbf, 0xbf], [0xf0, 0x80, 0x80, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80, 0x80, 0x80],
    [0xe2, 0x82], [0xe2], [0xf0, 0x9f, 0x98], [0xc3], [0xe2, 0x28, 0xa1], [0x41, 0xe2, 0x82, 0x42],
  ]
  for (const b of bad) expect(invalid(bytes(...b)), b.map((x) => x.toString(16)).join(" ")).toBe(true)
})

test("the flagged value is never parseable JSON and keeps the lossy text after the mark (so a rev can still be scraped)", () => {
  const raw = decodeUtf8(Buffer.concat([Buffer.from('{"rev": 7, "items": [{"title": "A'), Buffer.from([0xe2, 0x82]), Buffer.from('"}]}')]))
  expect(raw.startsWith(INVALID_UTF8_MARK)).toBe(true)
  expect(() => JSON.parse(raw)).toThrow()
  expect(raw).toContain('"rev": 7')
  expect(raw).toContain("�")
  expect(decodeUtf8(bytes(0xe2, 0x82))).toBe(decodeUtf8(bytes(0xe2, 0x82))) // deterministic
})
