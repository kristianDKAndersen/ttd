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
  edit: ['M12 20h9', 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z'],
  cancel: ['M6 6l12 12', 'M18 6L6 18'],
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
  head: HTMLElement
  toggle: HTMLElement
  title: HTMLElement
  body: HTMLElement
  actions: HTMLElement
  edit: HTMLButtonElement
  trash: HTMLButtonElement
  play: HTMLButtonElement
  check: HTMLButtonElement
}

function actionButton(kind: 'edit' | 'trash' | 'play' | 'check', label: string): HTMLButtonElement {
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
  const edit = actionButton('edit', 'Edit')
  const trash = actionButton('trash', 'Delete')
  const play = actionButton('play', 'In progress')
  const check = actionButton('check', 'Done')
  actions.append(edit, trash, play, check)
  head.append(toggle, actions)
  const body = el('div', 'row-body')
  li.append(head, body)
  return { el: li, head, toggle, title, body, actions, edit, trash, play, check }
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

/** The one open form: adding (id null) or editing an item. `base*` is the item as it was when the editor opened. */
interface Editor {
  id: string | null
  baseTitle: string
  baseBody: string
  form: HTMLFormElement
  title: HTMLInputElement
  body: HTMLTextAreaElement
  hint: HTMLElement
}

type CommitHow = 'explicit' | 'outside'

function formButton(kind: 'save' | 'cancel', label: string): HTMLButtonElement {
  const b = el('button', `form-btn ${kind}`)
  b.type = 'button'
  b.setAttribute('aria-label', label)
  b.title = label
  b.appendChild(icon([...ICONS[kind === 'save' ? 'check' : 'cancel']]))
  return b
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
  let editor: Editor | null = null
  let inflight: Promise<boolean> | null = null
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
    if (ro && editor) closeEditor(false)
    addBtn.disabled = ro
    renderBanner()
    const items = doc ? sortItems(doc.items) : []
    if (expandedId && !items.some((i) => i.id === expandedId)) expandedId = null
    if (editor && editor.id !== null && !items.some((i) => i.id === editor!.id)) {
      closeEditor(false)
      toast('This todo was deleted elsewhere, so the edit was closed.')
    }
    // Re-inserting a row that holds the focused field makes a real browser blur it; put the focus and caret back.
    const active = document.activeElement
    const sel = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? ([active.selectionStart, active.selectionEnd, active.selectionDirection] as const) : null
    reconcile(items, ro)
    renderEditor()
    if (editor && active instanceof HTMLElement && editor.form.contains(active) && document.activeElement !== active) {
      active.focus()
      if (sel && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && sel[0] !== null && sel[1] !== null) active.setSelectionRange(sel[0], sel[1], sel[2] ?? undefined)
    }
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
    const editing = editor !== null && editor.id === it.id
    v.el.classList.toggle('expanded', open)
    v.el.classList.toggle('editing', editing)
    v.head.hidden = editing
    v.el.classList.toggle('dragging', drag?.id === it.id)
    if (v.title.textContent !== it.title) v.title.textContent = it.title
    if (v.body.textContent !== it.body) v.body.textContent = it.body
    v.body.hidden = editing || !open || it.body === ''
    v.actions.hidden = !open
    v.toggle.setAttribute('aria-expanded', String(open))
    v.play.setAttribute('aria-pressed', String(it.status === 'in_progress'))
    v.check.setAttribute('aria-pressed', String(it.status === 'done'))
    v.edit.disabled = v.trash.disabled = v.play.disabled = v.check.disabled = ro
  }

  // ---- editor: the add form and the inline edit form (the element and its text outlive every re-render)

  function buildEditor(id: string | null, baseTitle: string, baseBody: string): Editor {
    const f = el('form', 'new-form')
    f.noValidate = true
    const t = el('input', 'f-title')
    t.type = 'text'
    t.name = 'title'
    t.placeholder = 'Title'
    t.autocomplete = 'off'
    t.setAttribute('aria-label', 'Title')
    t.setAttribute('aria-describedby', 'f-title-hint')
    t.value = baseTitle
    const hint = el('span', 'f-hint', 'Title needed')
    hint.id = 'f-title-hint'
    hint.setAttribute('role', 'alert')
    hint.hidden = true
    const b = el('textarea', 'f-body')
    b.name = 'body'
    b.placeholder = 'Body'
    b.rows = 3
    b.setAttribute('aria-label', 'Body')
    b.value = baseBody
    const actions = el('div', 'form-actions')
    const save = formButton('save', 'Save')
    const cancel = formButton('cancel', 'Cancel')
    actions.append(save, cancel)
    f.append(t, hint, b, actions)
    const ed: Editor = { id, baseTitle, baseBody, form: f, title: t, body: b, hint }
    f.addEventListener('submit', (e) => e.preventDefault())
    t.addEventListener('input', () => {
      t.removeAttribute('aria-invalid')
      hint.hidden = true
    })
    // keyCode 229 is how WebKit reports the Enter that confirms an IME composition, with isComposing already false.
    t.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault()
        void commit('explicit')
      }
    })
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault()
        void commit('explicit')
      }
    })
    save.addEventListener('click', () => void commit('explicit'))
    cancel.addEventListener('click', () => cancelEditor())
    return ed
  }

  function renderEditor(): void {
    if (!editor) return
    const host = editor.id === null ? formHost : views.get(editor.id)?.el
    if (host && editor.form.parentNode !== host) host.appendChild(editor.form)
  }

  function onEditorKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || e.defaultPrevented || cand || drag) return
    e.preventDefault()
    cancelEditor()
  }

  /** Any primary press outside the form saves it (rules in commit). The openers (+, pencil, window x) decide in their click handler instead: a press-time save would move the layout under the click. */
  function onEditorPointerDown(e: PointerEvent): void {
    if (!editor || e.button !== 0) return
    const node = e.target as Node | null
    if (node && editor.form.contains(node)) return
    if (node instanceof Element && node.closest('.add, .close, .act.edit')) return
    void commit('outside')
  }

  function closeEditor(redraw: boolean, focusRow = false): void {
    if (!editor) return
    const ed = editor
    editor = null
    document.removeEventListener('pointerdown', onEditorPointerDown, true)
    document.removeEventListener('keydown', onEditorKeydown)
    ed.form.remove()
    if (redraw) render()
    if (focusRow && ed.id !== null) views.get(ed.id)?.toggle.focus()
  }

  function cancelEditor(): void {
    closeEditor(true, true)
  }

  function flagTitle(ed: Editor): void {
    ed.title.setAttribute('aria-invalid', 'true')
    ed.hint.hidden = false
    ed.title.focus()
  }

  /**
   * Save the open form. Resolves true when the form is closed afterwards, false when it stays open.
   * 'explicit' (Enter, Ctrl/Cmd+Enter, the check button) flags an empty title; 'outside' (a press elsewhere, opening another
   * form, the window x) closes silently when title and body are both empty and flags only when a body would be lost.
   */
  function commit(how: CommitHow): Promise<boolean> {
    if (!editor) return Promise.resolve(true)
    if (inflight) return inflight
    const p: Promise<boolean> = runCommit(editor, how).finally(() => {
      if (inflight === p) inflight = null
    })
    inflight = p
    return p
  }

  async function runCommit(ed: Editor, how: CommitHow): Promise<boolean> {
    const t = ed.title.value.trim()
    const b = ed.body.value.trim()
    if (!t) {
      if (how === 'outside' && !b) {
        closeEditor(true)
        return true
      }
      flagTitle(ed)
      return false
    }
    let op: Op | null
    if (ed.id === null) op = { op: 'add', title: t, body: b }
    else {
      // Only fields the user changed since the editor opened: an untouched field must not overwrite an agent's concurrent edit.
      const patch: { title?: string; body?: string } = {}
      if (t !== ed.baseTitle.trim()) patch.title = t
      if (b !== ed.baseBody.trim()) patch.body = b
      op = patch.title === undefined && patch.body === undefined ? null : { op: 'update', id: ed.id, ...patch }
    }
    if (op && !(await send(op))) return false
    if (destroyed || editor !== ed) return true
    closeEditor(true, how === 'explicit')
    return true
  }

  async function openEditor(id: string | null): Promise<void> {
    if (readOnly()) return
    if (inflight) await inflight
    if (editor && !(await commit('outside'))) return
    if (readOnly() || editor || destroyed) return
    let baseTitle = ''
    let baseBody = ''
    if (id !== null) {
      const it = doc?.items.find((i) => i.id === id)
      if (!it) return
      baseTitle = it.title
      baseBody = it.body
      expandedId = id
    }
    editor = buildEditor(id, baseTitle, baseBody)
    document.addEventListener('pointerdown', onEditorPointerDown, true)
    document.addEventListener('keydown', onEditorKeydown)
    render()
    editor.title.focus()
    editor.title.setSelectionRange(baseTitle.length, baseTitle.length)
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
    if (t.closest('.act, .new-form')) return
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
    if (t.closest('.new-form')) return
    const rowEl = t.closest('li.row') as HTMLElement | null
    const id = rowEl?.dataset.id
    if (!rowEl || !id) return
    const btn = t.closest('button.act') as HTMLButtonElement | null
    if (btn) {
      const it = doc?.items.find((i) => i.id === id)
      if (!it || btn.disabled || readOnly()) return
      if (btn.classList.contains('edit')) void openEditor(id)
      else if (btn.classList.contains('trash')) void send({ op: 'delete', id })
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
    if (editor && editor.id === null) editor.title.focus()
    else void openEditor(null)
  })
  closeBtn?.addEventListener('click', () => {
    if (!editor && !inflight) return backend.close?.()
    void commit('outside').then((closed) => {
      if (closed) backend.close?.()
    })
  })
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
      editor = null
      document.removeEventListener('pointerdown', onEditorPointerDown, true)
      document.removeEventListener('keydown', onEditorKeydown)
      drag?.ghost.remove()
      endDrag()
      root.replaceChildren()
    },
  }
}
