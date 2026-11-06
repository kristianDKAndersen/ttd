import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register({ url: 'http://localhost/', width: 320, height: 480 })

import type { Backend } from '../src/backend.ts'
import { mount, type App } from '../src/view.ts'
import type { ApplyResult, Doc, ErrorCode, Item, Op, ReadResult, Status } from '../src/types.ts'

export function item(id: string, over: Partial<Item> = {}): Item {
  return {
    id,
    title: `task ${id}`,
    body: '',
    status: 'todo',
    order: 0,
    createdAt: '2026-01-01T09:00:00.000Z',
    updatedAt: '2026-01-01T09:00:00.000Z',
    ...over,
  }
}

export function makeDoc(items: Item[], rev = 1): Doc {
  return { schemaVersion: 1, rev, items: items.map((it, i) => ({ ...it, order: i })) }
}

/** In-memory Backend with simplified op semantics, an op log, and hooks to simulate races and failures. */
export class FakeBackend implements Backend {
  doc: Doc
  ops: Op[] = []
  reads = 0
  closed = 0
  /** When set, read() returns this instead of the doc (corrupt, unsupported_version...). */
  readError: { error: ErrorCode; message?: string } | null = null
  /** Next apply() resolves {ok:false,error}. */
  failNextApply: ErrorCode | null = null
  /** Next successful apply() carries these warnings (like a recovery from todos.json.bak). */
  nextWarnings: string[] | null = null
  /** Next apply() rejects (like a thrown invoke). */
  rejectNextApply: string | null = null
  /** When true apply() waits for release() before resolving. */
  hold = false
  private waiting: Array<() => void> = []
  private subs = new Set<(r: ReadResult) => void>()
  close?: () => void
  private n = 0

  constructor(items: Item[] = [], withClose = false) {
    this.doc = makeDoc(items)
    if (withClose) this.close = () => void this.closed++
  }

  async read(): Promise<ReadResult> {
    this.reads++
    if (this.readError) return { ok: false, ...this.readError }
    return { ok: true, doc: structuredClone(this.doc) }
  }

  subscribe(onChange: (r: ReadResult) => void): () => void {
    this.subs.add(onChange)
    return () => void this.subs.delete(onChange)
  }

  get subscribers(): number {
    return this.subs.size
  }

  /** Push an arbitrary read result as if another process changed the file. */
  emit(r: ReadResult): void {
    for (const s of [...this.subs]) s(r)
  }

  /** External writer: mutate the doc, bump rev, publish. */
  external(mutate: (items: Item[]) => Item[]): void {
    this.doc = makeDoc(mutate(this.doc.items), this.doc.rev + 1)
    this.emit({ ok: true, doc: structuredClone(this.doc) })
  }

  release(): void {
    const w = this.waiting
    this.waiting = []
    for (const f of w) f()
  }

  async apply(op: Op): Promise<ApplyResult> {
    this.ops.push(op)
    if (this.hold) await new Promise<void>((r) => this.waiting.push(r))
    if (this.rejectNextApply !== null) {
      const m = this.rejectNextApply
      this.rejectNextApply = null
      throw new Error(m)
    }
    if (this.failNextApply) {
      const error = this.failNextApply
      this.failNextApply = null
      return { ok: false, error, message: `fake ${error}` }
    }
    const items = this.doc.items.map((i) => ({ ...i }))
    let changed = true
    let result: unknown = {}
    switch (op.op) {
      case 'add': {
        const it = item(op.id ?? `n${++this.n}`, { title: op.title.trim(), body: op.body ?? '', status: (op.status ?? 'todo') as Status })
        items.push(it)
        result = { item: it }
        break
      }
      case 'update': {
        const it = items.find((i) => i.id === op.id)
        if (!it) return { ok: false, error: 'not_found' }
        if (op.title !== undefined) it.title = op.title
        if (op.body !== undefined) it.body = op.body
        break
      }
      case 'set_status': {
        const it = items.find((i) => i.id === op.id)
        if (!it) return { ok: false, error: 'not_found' }
        changed = it.status !== op.status
        it.status = op.status
        break
      }
      case 'move': {
        const from = items.findIndex((i) => i.id === op.id)
        if (from < 0) return { ok: false, error: 'not_found' }
        const [it] = items.splice(from, 1)
        const at = op.after === null ? 0 : items.findIndex((i) => i.id === op.after) + 1
        if (op.after !== null && at === 0) return { ok: false, error: 'not_found' }
        items.splice(at, 0, it!)
        break
      }
      case 'delete': {
        const at = items.findIndex((i) => i.id === op.id)
        changed = at >= 0
        if (at >= 0) items.splice(at, 1)
        break
      }
      case 'reset_corrupt': {
        if (!this.readError) return { ok: false, error: 'not_corrupt' }
        this.readError = null
        items.length = 0
        break
      }
    }
    this.doc = makeDoc(items, this.doc.rev + (changed ? 1 : 0))
    const doc = structuredClone(this.doc)
    queueMicrotask(() => this.emit({ ok: true, doc: structuredClone(doc) }))
    const warnings = this.nextWarnings
    this.nextWarnings = null
    return { ok: true, changed, rev: doc.rev, result, doc, ...(warnings ? { warnings } : {}) }
  }
}

// ---------------------------------------------------------------- DOM helpers

export const flush = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0))
}

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(sel)
  if (!el) throw new Error(`missing element: ${sel}`)
  return el
}
export const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] => [...root.querySelectorAll<T>(sel)]

export const click = (el: Element): void => void el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))

export function key(el: Element, k: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, shiftKey: !!mods.shift })
  el.dispatchEvent(ev)
  return ev
}

export function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

export function pointer(el: Element | Document, kind: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', x: number, y: number, button = 0): void {
  el.dispatchEvent(new PointerEvent(kind, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button, pointerType: 'mouse' }))
}

export const ROW_H = 36
export const ROW_STEP = 40

/** happy-dom has no layout: rows sit at i*40 with height 36 inside a list at top 0. */
export function stubLayout(): void {
  const rect = (top: number, height: number, width = 300) =>
    ({ x: 0, y: top, top, left: 0, width, height, right: width, bottom: top + height, toJSON() {} }) as DOMRect
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if (this.classList.contains('row') && this.parentElement) {
      const rows = [...this.parentElement.children].filter((c) => c.classList.contains('row'))
      return rect(rows.indexOf(this) * ROW_STEP, ROW_H)
    }
    if (this.classList.contains('list')) return rect(0, 400)
    return rect(0, 0, 0)
  }
}

export interface Harness {
  fake: FakeBackend
  app: App
  root: HTMLElement
  rows: () => HTMLElement[]
  titles: () => string[]
  row: (id: string) => HTMLElement
}

export async function mountApp(items: Item[] = [], opts: { withClose?: boolean; toastMs?: number; configure?: (f: FakeBackend) => void } = {}): Promise<Harness> {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild)
  stubLayout()
  const fake = new FakeBackend(items, opts.withClose)
  opts.configure?.(fake)
  const root = document.createElement('div')
  root.id = 'app'
  document.body.appendChild(root)
  const app = mount(root, fake, { toastMs: opts.toastMs })
  await flush()
  const rows = () => $$('li.row', root)
  return {
    fake,
    app,
    root,
    rows,
    titles: () => rows().map((r) => $('.row-title', r).textContent ?? ''),
    row: (id) => $(`li.row[data-id="${id}"]`, root),
  }
}

/** items a..e with titles "task a".. */
export const five = (): Item[] => ['a', 'b', 'c', 'd', 'e'].map((id) => item(id))
