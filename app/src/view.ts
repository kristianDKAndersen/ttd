// The whole UI. Vanilla DOM, no import-time side effects (main.ts boots it). All user/agent text is
// assigned through textContent; icons are built with createElementNS. Nothing here parses HTML.
import type { Backend } from './backend.ts'
import { dropSlot, exceedsThreshold, planMove } from './reorder.ts'
import type { ApplyResult, Doc, Item, Op, ReadResult, Status } from './types.ts'

export interface App {
  destroy(): void
}

export interface MountOptions {
  /** How long an error toast stays (ms). */
  toastMs?: number
  /** Called after every render with the number of rows (used by the Tauri smoke test). */
  onRender?: (itemCount: number) => void
}

// ---------------------------------------------------------------- icons

const SVG_NS = 'http://www.w3.org/2000/svg'

function icon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path')
    p.setAttribute('d', d)
    p.setAttribute('stroke-width', '2')
    p.setAttribute('stroke-linecap', 'round')
    p.setAttribute('stroke-linejoin', 'round')
    p.setAttribute('stroke', 'currentColor')
    svg.appendChild(p)
  }
  return svg
}

// The play path is the exact one from docs/DECISIONS.md item 5.
const ICONS = {
  trash: ['M3 6h18', 'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2', 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6', 'M10 11v6', 'M14 11v6'],
  play: ['M6 3L20 12L6 21V3Z'],
  check: ['M4 12.5l5 5L20 6'],
} as const

// ---------------------------------------------------------------- small helpers

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

function sortItems(items: readonly Item[]): Item[] {
  return [...items].sort((a, b) => a.order - b.order || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

interface RowView {
  el: HTMLLIElement
  toggle: HTMLElement
  title: HTMLElement
  body: HTMLElement
  actions: HTMLElement
  trash: HTMLButtonElement
  play: HTMLButtonElement
  check: HTMLButtonElement
}

function actionButton(kind: 'trash' | 'play' | 'check', label: string): HTMLButtonElement {
  const b = el('button', `act ${kind}`)
  b.type = 'button'
  b.setAttribute('aria-label', label)
  b.title = label
  b.appendChild(icon([...ICONS[kind]]))
  return b
}

function createRow(id: string): RowView {
  const li = el('li', 'row')
  li.dataset.id = id
  const head = el('div', 'row-head')
  const toggle = el('div', 'row-toggle')
  toggle.setAttribute('role', 'button')
  toggle.tabIndex = 0
  const title = el('span', 'row-title')
  toggle.appendChild(title)
  const actions = el('div', 'row-actions')
  const trash = actionButton('trash', 'Delete')
  const play = actionButton('play', 'In progress')
  const check = actionButton('check', 'Done')
  actions.append(trash, play, check)
  head.append(toggle, actions)
  const body = el('div', 'row-body')
  li.append(head, body)
  return { el: li, toggle, title, body, actions, trash, play, check }
}

interface Banner {
  kind: string
  message?: string
}

/** What a recovery (or a backup that fell behind) did, from the store's warnings; undefined when there is nothing to say. */
function recoveryNotice(warnings: readonly string[] | undefined): string | undefined {
  const stale = warnings?.includes('backup_stale') === true
  if (!warnings?.includes('corrupt_quarantined') && !warnings?.includes('restored_from_bak')) {
    return stale ? 'The backup copy (todos.json.bak) could not be refreshed and is one change behind your list. If todos.json were damaged now, the latest change would only be in the damaged file.' : undefined
  }
  const what = warnings.includes('restored_from_bak') ? 'restored from backup' : 'started an empty list'
  const kept = 'The damaged copy is kept next to it as todos.corrupt-*.json.'
  if (!stale) return `todos.json was damaged; ${what}. ${kept}`
  return `todos.json was damaged; ${what}, but the backup was older than the damaged file, so your latest changes may be missing from the list. They are still in the damaged copy, kept next to it as todos.corrupt-*.json.`
}

interface DragCandidate {
  id: string
  pointerId: number
  startX: number
  startY: number
}

interface Drag {
  id: string
  grabY: number
  ghost: HTMLElement
  indicator: HTMLElement
  plan: { after: string | null } | null
}

// ---------------------------------------------------------------- mount

export function mount(root: HTMLElement, backend: Backend, opts: MountOptions = {}): App {
  const toastMs = opts.toastMs ?? 4000

  let doc: Doc | null = null
  let banner: Banner | null = null
  let expandedId: string | null = null
  let formOpen = false
  let submitting = false
  let cand: DragCandidate | null = null
  let drag: Drag | null = null
  let pending: ReadResult | null = null
  let suppressClick = false
  let toastEl: HTMLElement | null = null
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  let destroyed = false
  const views = new Map<string, RowView>()

  // ---- static skeleton
  const panel = el('div', 'panel')
  const head = el('header', 'head')
  head.setAttribute('data-tauri-drag-region', '')
  const title = el('span', 'title', 'TTD')
  title.setAttribute('data-tauri-drag-region', '')
  const addBtn = el('button', 'add', '+')
  addBtn.type = 'button'
  addBtn.setAttribute('aria-label', 'Add todo')
  head.append(title, addBtn)
  let closeBtn: HTMLButtonElement | null = null
  if (backend.close) {
    closeBtn = el('button', 'close', '×')
    closeBtn.type = 'button'
    closeBtn.setAttribute('aria-label', 'Close')
    head.appendChild(closeBtn)
  }
  const bannerHost = el('div', 'banner-host')
  const noticeHost = el('div', 'notice-host')
  const formHost = el('div', 'form-host')
  const list = el('ul', 'list')
  const emptyEl = el('li', 'empty', 'Nothing here yet. Press + to add a todo.')
  panel.append(head, bannerHost, noticeHost, formHost, list)
  root.appendChild(panel)

  const readOnly = () => banner?.kind === 'unsupported_version'

  // ---- toast

  function toast(text: string): void {
    clearTimeout(toastTimer)
    toastEl?.remove()
    toastEl = el('div', 'toast', text)
    toastEl.setAttribute('role', 'status')
    panel.appendChild(toastEl)
    toastTimer = setTimeout(() => {
      toastEl?.remove()
      toastEl = null
    }, toastMs)
  }

  // ---- recovery notice (stays until dismissed; independent of banner and render)

  function showNotice(text: string): void {
    const n = el('div', 'notice')
    n.setAttribute('role', 'status')
    const t = el('span', 'notice-text', text)
    const dismiss = el('button', 'dismiss', 'Dismiss')
    dismiss.type = 'button'
    n.append(t, dismiss)
    noticeHost.replaceChildren(n)
  }

  noticeHost.addEventListener('click', (e) => {
    if ((e.target as Element).closest('.dismiss')) noticeHost.replaceChildren()
  })

  // ---- data flow

  function ingest(r: ReadResult, dropIfStale = false): void {
    if (destroyed) return
    const notice = r.ok ? recoveryNotice(r.warnings) : undefined
    if (notice) showNotice(notice)
    if (drag) {
      pending = r
      return
    }
    if (r.ok) {
      if (dropIfStale && doc && r.doc.rev < doc.rev) return
      doc = r.doc
      banner = null
    } else {
      banner = { kind: r.error, message: r.message }
    }
    render()
  }

  async function reread(): Promise<void> {
    try {
      ingest(await backend.read())
    } catch (e) {
      ingest({ ok: false, error: 'io_error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  function flushPending(): void {
    const p = pending
    pending = null
    if (p) ingest(p, true)
  }

  async function send(op: Op): Promise<boolean> {
    let res: ApplyResult
    try {
      res = await backend.apply(op)
    } catch (e) {
      res = { ok: false, error: 'io_error', message: e instanceof Error ? e.message : String(e) }
    }
    if (destroyed) return res.ok
    if (res.ok) {
      ingest({ ok: true, doc: res.doc, warnings: res.warnings }, true)
      return true
    }
    toast(`${op.op} failed (${res.error})${res.message ? `: ${res.message}` : ''}`)
    pending = null
    await reread()
    return false
  }

  // ---- rendering

  function render(): void {
    if (destroyed) return
    const ro = readOnly()
    if (ro && formOpen) closeForm(false)
    addBtn.disabled = ro
    renderBanner()
    renderForm()
    const items = doc ? sortItems(doc.items) : []
    if (expandedId && !items.some((i) => i.id === expandedId)) expandedId = null
    reconcile(items, ro)
    opts.onRender?.(items.length)
  }

  function renderBanner(): void {
    bannerHost.replaceChildren()
    if (!banner) return
    const b = el('div', 'banner')
    b.dataset.kind = banner.kind
    b.setAttribute('role', 'alert')
    const text = el('span', 'banner-text')
    if (banner.kind === 'corrupt') {
      text.textContent = 'todos.json is damaged. Recover restores the backup, or starts an empty list if there is no valid one; the damaged file is kept.'
      b.appendChild(text)
      const reset = el('button', 'reset', 'Recover')
      reset.type = 'button'
      reset.title = 'Restore the last backup if it is valid, otherwise start an empty list. The damaged file is kept as todos.corrupt-*.json.'
      b.appendChild(reset)
    } else if (banner.kind === 'unsupported_version') {
      text.textContent = 'This todo file comes from a newer TTD. Editing is disabled; please update the app.'
      b.appendChild(text)
    } else {
      text.textContent = `Cannot read the todo file${banner.message ? `: ${banner.message}` : '.'}`
      b.appendChild(text)
      const retry = el('button', 'retry', 'Retry')
      retry.type = 'button'
      b.appendChild(retry)
    }
    bannerHost.appendChild(b)
  }

  function reconcile(items: Item[], ro: boolean): void {
    const keep = new Set<string>()
    for (const it of items) keep.add(it.id)
    for (const [id, v] of views) {
      if (!keep.has(id)) {
        v.el.remove()
        views.delete(id)
      }
    }
    if (items.length === 0) {
      if (!emptyEl.parentNode) list.appendChild(emptyEl)
    } else {
      emptyEl.remove()
    }
    let ref: Element | null = list.firstElementChild
    for (const it of items) {
      let v = views.get(it.id)
      if (!v) {
        v = createRow(it.id)
        views.set(it.id, v)
      }
      patchRow(v, it, ro)
      if (v.el === ref) ref = ref.nextElementSibling
      else list.insertBefore(v.el, ref)
    }
  }

  function patchRow(v: RowView, it: Item, ro: boolean): void {
    const open = it.id === expandedId
    v.el.dataset.status = it.status
    v.el.classList.toggle('expanded', open)
    v.el.classList.toggle('dragging', drag?.id === it.id)
    if (v.title.textContent !== it.title) v.title.textContent = it.title
    if (v.body.textContent !== it.body) v.body.textContent = it.body
    v.body.hidden = !open || it.body === ''
    v.actions.hidden = !open
    v.toggle.setAttribute('aria-expanded', String(open))
    v.play.setAttribute('aria-pressed', String(it.status === 'in_progress'))
    v.check.setAttribute('aria-pressed', String(it.status === 'done'))
    v.trash.disabled = v.play.disabled = v.check.disabled = ro
  }

  // ---- add form (the element and its text outlive every re-render)

  let formEl: HTMLFormElement | null = null
  let fTitle: HTMLInputElement
  let fBody: HTMLTextAreaElement

  function buildForm(): HTMLFormElement {
    const f = el('form', 'new-form')
    f.noValidate = true
    fTitle = el('input', 'f-title')
    fTitle.type = 'text'
    fTitle.name = 'title'
    fTitle.placeholder = 'Title'
    fTitle.autocomplete = 'off'
    fTitle.setAttribute('aria-label', 'Title')
    fBody = el('textarea', 'f-body')
    fBody.name = 'body'
    fBody.placeholder = 'Body'
    fBody.rows = 3
    fBody.setAttribute('aria-label', 'Body')
    f.append(fTitle, fBody)
    f.addEventListener('submit', (e) => e.preventDefault())
    fTitle.addEventListener('input', () => fTitle.removeAttribute('aria-invalid'))
    fTitle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault()
        void submitForm()
      }
    })
    fBody.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
        e.preventDefault()
        void submitForm()
      }
    })
    f.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeForm(true)
      }
    })
    return f
  }

  function renderForm(): void {
    if (formOpen) {
      if (!formEl) {
        formEl = buildForm()
        formHost.appendChild(formEl)
        fTitle.focus()
      }
    } else if (formEl) {
      formEl.remove()
      formEl = null
    }
  }

  function closeForm(redraw: boolean): void {
    formOpen = false
    if (redraw) render()
    else renderForm()
  }

  async function submitForm(): Promise<void> {
    if (submitting || readOnly() || !formEl) return
    const t = fTitle.value.trim()
    if (!t) {
      fTitle.setAttribute('aria-invalid', 'true')
      fTitle.focus()
      return
    }
    submitting = true
    const ok = await send({ op: 'add', title: t, body: fBody.value.trim() })
    submitting = false
    if (ok && !destroyed) closeForm(true)
  }

  // ---- reorder

  function endDrag(): void {
    cand = null
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerup', onPointerUp)
    document.removeEventListener('pointercancel', onPointerCancel)
    document.removeEventListener('keydown', onDocKeydown)
    if (!drag) return
    const d = drag
    drag = null
    d.ghost.remove()
    d.indicator.remove()
    views.get(d.id)?.el.classList.remove('dragging')
    suppressClick = true
    setTimeout(() => (suppressClick = false), 0)
  }

  function rowRects(ids: string[]): Array<{ top: number; height: number; bottom: number }> {
    return ids.map((id) => {
      const r = views.get(id)!.el.getBoundingClientRect()
      return { top: r.top, height: r.height, bottom: r.bottom }
    })
  }

  function startDrag(c: DragCandidate): void {
    const v = views.get(c.id)
    if (!v || !doc) return
    const r = v.el.getBoundingClientRect()
    const ghost = el('div', 'ghost')
    ghost.textContent = v.title.textContent ?? ''
    ghost.dataset.status = v.el.dataset.status ?? 'todo'
    ghost.style.width = `${r.width}px`
    ghost.style.left = `${r.left}px`
    const indicator = el('li', 'drop-slot')
    indicator.setAttribute('aria-hidden', 'true')
    indicator.hidden = true
    list.appendChild(indicator)
    root.appendChild(ghost)
    drag = { id: c.id, grabY: c.startY - r.top, ghost, indicator, plan: null }
    v.el.classList.add('dragging')
    try {
      v.el.setPointerCapture?.(c.pointerId)
    } catch {
      /* capture is a nicety (events past the window edge); document listeners already work */
    }
  }

  function updateDrag(e: PointerEvent): void {
    if (!drag || !doc) return
    const ids = sortItems(doc.items).map((i) => i.id)
    const rects = rowRects(ids)
    drag.ghost.style.top = `${e.clientY - drag.grabY}px`
    const lr = list.getBoundingClientRect()
    if (e.clientY < lr.top + 24) list.scrollTop -= 10
    else if (e.clientY > lr.bottom - 24) list.scrollTop += 10
    const slot = dropSlot(rects, e.clientY)
    drag.plan = planMove(ids, drag.id, slot)
    drag.indicator.hidden = drag.plan === null
    if (drag.plan && rects.length) {
      const y = slot < rects.length ? rects[slot]!.top - 2 : rects[rects.length - 1]!.bottom + 2
      drag.indicator.style.top = `${y - lr.top + list.scrollTop}px`
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (!cand) return
    if (!drag) {
      if (!exceedsThreshold(e.clientX - cand.startX, e.clientY - cand.startY)) return
      startDrag(cand)
      if (!drag) return endDrag()
    }
    updateDrag(e)
  }

  function onPointerUp(e: PointerEvent): void {
    if (!cand) return
    if (!drag) return endDrag()
    updateDrag(e)
    const { id, plan } = drag
    endDrag()
    const gone = pending?.ok && !pending.doc.items.some((i) => i.id === id)
    if (!plan || gone || !doc) return flushPending()
    // Optimistic: show the new order now; the real doc replaces it when apply returns.
    const ids = sortItems(doc.items).map((i) => i.id)
    const rest = ids.filter((x) => x !== id)
    const at = plan.after === null ? 0 : rest.indexOf(plan.after) + 1
    rest.splice(at, 0, id)
    const byId = new Map(doc.items.map((i) => [i.id, i]))
    doc = { ...doc, items: rest.map((x, i) => ({ ...byId.get(x)!, order: i })) }
    render()
    void send({ op: 'move', id, after: plan.after }).then(flushPending)
  }

  function onPointerCancel(): void {
    const had = drag !== null
    endDrag()
    if (had) flushPending()
  }

  function onDocKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !cand) return
    onPointerCancel()
  }

  function onPointerDown(e: PointerEvent): void {
    if (readOnly() || cand || e.button !== 0 || e.isPrimary === false) return
    const t = e.target as Element
    if (t.closest('.act')) return
    const rowEl = t.closest('li.row') as HTMLElement | null
    if (!rowEl || !t.closest('.row-head') || !rowEl.dataset.id) return
    cand = { id: rowEl.dataset.id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY }
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('pointercancel', onPointerCancel)
    document.addEventListener('keydown', onDocKeydown)
  }

  // ---- interaction

  function toggleExpanded(id: string): void {
    expandedId = expandedId === id ? null : id
    render()
  }

  function setStatus(it: Item, target: Status): void {
    void send({ op: 'set_status', id: it.id, status: it.status === target ? 'todo' : target })
  }

  list.addEventListener('pointerdown', onPointerDown)
  list.addEventListener('click', (e) => {
    const t = e.target as Element
    const rowEl = t.closest('li.row') as HTMLElement | null
    const id = rowEl?.dataset.id
    if (!rowEl || !id) return
    const btn = t.closest('button.act') as HTMLButtonElement | null
    if (btn) {
      const it = doc?.items.find((i) => i.id === id)
      if (!it || btn.disabled || readOnly()) return
      if (btn.classList.contains('trash')) void send({ op: 'delete', id })
      else if (btn.classList.contains('play')) setStatus(it, 'in_progress')
      else if (btn.classList.contains('check')) setStatus(it, 'done')
      return
    }
    if (!t.closest('.row-toggle') || suppressClick) return
    toggleExpanded(id)
  })
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const t = e.target as Element
    if (!t.classList.contains('row-toggle')) return
    const id = (t.closest('li.row') as HTMLElement | null)?.dataset.id
    if (!id) return
    e.preventDefault()
    toggleExpanded(id)
  })

  addBtn.addEventListener('click', () => {
    if (readOnly()) return
    if (formOpen) closeForm(true)
    else {
      formOpen = true
      render()
      fTitle.focus()
    }
  })
  closeBtn?.addEventListener('click', () => backend.close?.())
  bannerHost.addEventListener('click', (e) => {
    const t = e.target as Element
    if (t.closest('.reset')) void send({ op: 'reset_corrupt' })
    else if (t.closest('.retry')) void reread()
  })

  // ---- boot

  const unsubscribe = backend.subscribe((r) => ingest(r))
  void backend
    .read()
    .then((r) => ingest(r, true))
    .catch((e: unknown) => ingest({ ok: false, error: 'io_error', message: e instanceof Error ? e.message : String(e) }))
  render()

  return {
    destroy(): void {
      destroyed = true
      unsubscribe()
      clearTimeout(toastTimer)
      cand = null
      drag?.ghost.remove()
      endDrag()
      root.replaceChildren()
    },
  }
}
