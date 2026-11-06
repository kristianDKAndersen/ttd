// The only module that talks to the outside world. The UI never imports the store core.
import type { ApplyResult, ErrorEnvelope, Op, ReadResult } from './types.ts'

export interface Backend {
  read(): Promise<ReadResult>
  apply(op: Op): Promise<ApplyResult>
  /** Subscribe to external changes (every change, own writes included). Returns a sync unsubscribe. */
  subscribe(onChange: (r: ReadResult) => void): () => void
  /** Present only where the window can be closed (Tauri, undecorated window). */
  close?(): void
}

const ioError = (e: unknown): ErrorEnvelope => ({
  ok: false,
  error: 'io_error',
  message: e instanceof Error ? e.message : String(e),
})

const isEnvelope = (v: unknown): v is ErrorEnvelope =>
  typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false && typeof (v as { error?: unknown }).error === 'string'

// ---------------------------------------------------------------- HTTP (browser dev shim, plan D5)

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

export interface HttpOptions {
  fetch?: FetchFn
  EventSource?: typeof EventSource
  base?: string
}

export class HttpBackend implements Backend {
  private readonly fetchFn: FetchFn
  private readonly ES: typeof EventSource
  private readonly base: string

  constructor(opts: HttpOptions = {}) {
    this.fetchFn = opts.fetch ?? ((url, init) => globalThis.fetch(url, init))
    this.ES = opts.EventSource ?? globalThis.EventSource
    this.base = opts.base ?? ''
  }

  private async json<T extends ReadResult | ApplyResult>(url: string, init?: RequestInit): Promise<T | ErrorEnvelope> {
    try {
      const res = await this.fetchFn(this.base + url, init)
      return (await res.json()) as T
    } catch (e) {
      return ioError(e)
    }
  }

  read(): Promise<ReadResult> {
    return this.json<ReadResult>('/api/doc')
  }

  apply(op: Op): Promise<ApplyResult> {
    return this.json<ApplyResult>('/api/op', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(op),
    })
  }

  subscribe(onChange: (r: ReadResult) => void): () => void {
    const es = new this.ES(this.base + '/api/events')
    let dropped = false
    // The shim sends a NAMED event ("doc"); onmessage would never see it.
    es.addEventListener('doc', (e) => {
      try {
        onChange(JSON.parse((e as MessageEvent<string>).data) as ReadResult)
      } catch {
        /* ignore a malformed frame; the next change or reconnect re-syncs */
      }
    })
    es.addEventListener('error', () => {
      dropped = true
    })
    // EventSource reconnects by itself; changes made while it was down are only caught by a re-read.
    es.addEventListener('open', () => {
      if (!dropped) return
      dropped = false
      void this.read().then(onChange)
    })
    return () => es.close()
  }
}

// ---------------------------------------------------------------- Tauri (commands + events from the Rust shell)

export interface TauriApi {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>
  listen(event: string, cb: (e: { payload: unknown }) => void): Promise<() => void>
  closeWindow?(): void | Promise<void>
}

export class TauriBackend implements Backend {
  close?: () => void

  constructor(private readonly api: TauriApi) {
    const closeWindow = api.closeWindow
    if (closeWindow) this.close = () => void closeWindow.call(api)
  }

  private async call<T extends ReadResult | ApplyResult>(cmd: string, args?: Record<string, unknown>): Promise<T | ErrorEnvelope> {
    try {
      return (await this.api.invoke(cmd, args)) as T
    } catch (e) {
      return isEnvelope(e) ? e : ioError(e)
    }
  }

  read(): Promise<ReadResult> {
    return this.call<ReadResult>('store_read')
  }

  apply(op: Op): Promise<ApplyResult> {
    return this.call<ApplyResult>('store_apply', { op })
  }

  subscribe(onChange: (r: ReadResult) => void): () => void {
    const pending = this.api.listen('store-changed', (e) => onChange(e.payload as ReadResult))
    let off = false
    return () => {
      if (off) return
      off = true
      void pending.then((unlisten) => unlisten()).catch(() => {})
    }
  }
}

// ---------------------------------------------------------------- selection

/** Tauri when running inside the window (documented `isTauri()`), the HTTP shim otherwise. */
export async function createBackend(): Promise<Backend> {
  const core = await import('@tauri-apps/api/core')
  if (!core.isTauri()) return new HttpBackend()
  const [{ listen }, { getCurrentWindow }] = await Promise.all([import('@tauri-apps/api/event'), import('@tauri-apps/api/window')])
  return new TauriBackend({
    invoke: core.invoke,
    listen: (event, cb) => listen(event, cb),
    closeWindow: () => getCurrentWindow().close(),
  })
}
