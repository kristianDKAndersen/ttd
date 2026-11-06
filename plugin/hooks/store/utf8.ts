// Strict UTF-8 decoding for the file readers (pure: ECMAScript built-ins only, see STORE.md section 10).
// todos.json that is not valid UTF-8 is CORRUPT: Rust refuses it, and a lossy decode would otherwise let damaged text
// that still parses be rewritten with U+FFFD in place of the lost bytes (and the good .bak replaced by that).

/** Prefix of the value `decodeUtf8` returns for invalid input. A NUL is not JSON whitespace, so the value never parses. */
export const INVALID_UTF8_MARK = "\u0000ttd:invalid-utf8\n"

const CHUNK = 8192

/** The text of `bytes` when it is valid UTF-8 (a BOM stays U+FEFF); else INVALID_UTF8_MARK + the lossy text (U+FFFD per bad byte). */
export function decodeUtf8(bytes: Uint8Array): string {
  const units: number[] = []
  const parts: string[] = []
  let valid = true
  const push = (u: number): void => {
    units.push(u)
    if (units.length >= CHUNK) {
      parts.push(String.fromCharCode(...units))
      units.length = 0
    }
  }
  const cont = (i: number, lo = 0x80, hi = 0xbf): boolean => i < bytes.length && bytes[i]! >= lo && bytes[i]! <= hi
  const n = bytes.length
  let i = 0
  while (i < n) {
    const b = bytes[i]!
    let cp = -1
    let len = 0
    if (b < 0x80) {
      cp = b
      len = 1
    } else if (b >= 0xc2 && b <= 0xdf && cont(i + 1)) {
      cp = ((b & 0x1f) << 6) | (bytes[i + 1]! & 0x3f)
      len = 2
    } else if (b >= 0xe0 && b <= 0xef) {
      const lo = b === 0xe0 ? 0xa0 : 0x80
      const hi = b === 0xed ? 0x9f : 0xbf
      if (cont(i + 1, lo, hi) && cont(i + 2)) {
        cp = ((b & 0x0f) << 12) | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f)
        len = 3
      }
    } else if (b >= 0xf0 && b <= 0xf4) {
      const lo = b === 0xf0 ? 0x90 : 0x80
      const hi = b === 0xf4 ? 0x8f : 0xbf
      if (cont(i + 1, lo, hi) && cont(i + 2) && cont(i + 3)) {
        cp = ((b & 0x07) << 18) | ((bytes[i + 1]! & 0x3f) << 12) | ((bytes[i + 2]! & 0x3f) << 6) | (bytes[i + 3]! & 0x3f)
        len = 4
      }
    }
    if (cp < 0) {
      valid = false
      push(0xfffd)
      i += 1
      continue
    }
    if (cp >= 0x10000) {
      const c = cp - 0x10000
      push(0xd800 + (c >> 10))
      push(0xdc00 + (c & 0x3ff))
    } else push(cp)
    i += len
  }
  if (units.length > 0) parts.push(String.fromCharCode(...units))
  const text = parts.join("")
  return valid ? text : INVALID_UTF8_MARK + text
}
