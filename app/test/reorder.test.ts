import { describe, expect, test } from 'bun:test'
import { dropSlot, exceedsThreshold, planMove } from '../src/reorder.ts'

const rects = [0, 40, 80, 120].map((top) => ({ top, height: 36 })) // mids 18, 58, 98, 138

describe('dropSlot', () => {
  test('empty list is slot 0', () => expect(dropSlot([], 50)).toBe(0))
  test('above everything is slot 0', () => expect(dropSlot(rects, -20)).toBe(0))
  test('above the first midpoint is slot 0', () => expect(dropSlot(rects, 10)).toBe(0))
  test('between rows picks the gap', () => {
    expect(dropSlot(rects, 40)).toBe(1)
    expect(dropSlot(rects, 80)).toBe(2)
    expect(dropSlot(rects, 118)).toBe(3)
  })
  test('below everything is the last slot', () => expect(dropSlot(rects, 900)).toBe(4))
  test('exactly on a midpoint goes before that row', () => expect(dropSlot(rects, 58)).toBe(1))
})

describe('planMove', () => {
  const ids = ['a', 'b', 'c', 'd', 'e']
  test('to the top', () => expect(planMove(ids, 'c', 0)).toEqual({ after: null }))
  test('to the top when already first is a no-op', () => expect(planMove(ids, 'a', 0)).toBeNull())
  test('down: slot counts the dragged row, so it is adjusted', () => expect(planMove(ids, 'a', 3)).toEqual({ after: 'c' }))
  test('up', () => expect(planMove(ids, 'e', 2)).toEqual({ after: 'b' }))
  test('to the very end', () => expect(planMove(ids, 'a', 5)).toEqual({ after: 'e' }))
  test('own slot and the slot right after it are no-ops', () => {
    expect(planMove(ids, 'c', 2)).toBeNull()
    expect(planMove(ids, 'c', 3)).toBeNull()
  })
  test('last item dropped at the end is a no-op', () => expect(planMove(ids, 'e', 5)).toBeNull())
  test('unknown id is a no-op', () => expect(planMove(ids, 'zz', 1)).toBeNull())
  test('single item', () => expect(planMove(['a'], 'a', 0)).toBeNull())
})

describe('exceedsThreshold', () => {
  test('4 px is the line (distance, not per axis)', () => {
    expect(exceedsThreshold(0, 0)).toBe(false)
    expect(exceedsThreshold(3, 0)).toBe(false)
    expect(exceedsThreshold(2, 2)).toBe(false)
    expect(exceedsThreshold(4, 0)).toBe(true)
    expect(exceedsThreshold(0, -4)).toBe(true)
    expect(exceedsThreshold(3, 3)).toBe(true)
  })
})
