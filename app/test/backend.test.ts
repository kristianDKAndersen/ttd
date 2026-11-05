import { describe, expect, test } from 'bun:test'
import { HttpBackend, TauriBackend, type TauriApi } from '../src/backend.ts'
import type { ReadResult } from '../src/types.ts'
import { flush, makeDoc, item } from './fake-backend.ts'

const doc = makeDoc([item('a')], 3)

class FakeES {
  static last: FakeES | null = null
  listeners = new Map<string, Array<(e: { data: string }) => void>>()
  closed = false
  url: string
  constructor(url: string) {
    this.url = url
    FakeES.last = this
  }
  addEventListener(name: string, fn: (e: { data: string }) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn])
  }
  close(): void {
    this.closed = true
  }
  fire(name: string, data = ''): void {
    for (const fn of this.listeners.get(name) ?? []) fn({ data })
  }
}

describe('HttpBackend', () => {
  test('read GETs /api/doc and returns the envelope', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const b = new HttpBackend({
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push([url, init])
        return new Response(JSON.stringify({ ok: true, doc }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    const r = await b.read()
    expect(calls[0]![0]).toBe('/api/doc')
    expect(r).toEqual({ ok: true, doc })
  })

  test('apply POSTs the op as JSON to /api/op', async () => {
    let seen: { url: string; init?: RequestInit } | null = null
    const b = new HttpBackend({
      fetch: (async (url: string, init?: RequestInit) => {
        seen = { url, init }
        return new Response(JSON.stringify({ ok: true, changed: true, rev: 4, result: {}, doc }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    const r = await b.apply({ op: 'delete', id: 'a' })
    expect(seen!.url).toBe('/api/op')
    expect(seen!.init?.method).toBe('POST')
    expect(new Headers(seen!.init?.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(String(seen!.init?.body))).toEqual({ op: 'delete', id: 'a' })
    expect(r.ok).toBe(true)
  })

  test('an error envelope with a 4xx status is passed through, not swallowed', async () => {
    const b = new HttpBackend({ fetch: (async () => new Response(JSON.stringify({ ok: false, error: 'not_found' }), { status: 404 })) as unknown as typeof fetch })
    expect(await b.apply({ op: 'delete', id: 'zz' })).toEqual({ ok: false, error: 'not_found' })
  })

  test('network failure and non-JSON bodies become io_error', async () => {
    const down = new HttpBackend({ fetch: (async () => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch })
    const r1 = await down.read()
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect([r1.error, r1.message]).toEqual(['io_error', 'offline'])
    const junk = new HttpBackend({ fetch: (async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch })
    const r2 = await junk.apply({ op: 'reset_corrupt' })
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error).toBe('io_error')
  })

  test('subscribe listens to the NAMED sse event "doc" and unsubscribe closes the stream', () => {
    const b = new HttpBackend({ EventSource: FakeES as unknown as typeof EventSource, fetch: (async () => new Response('{}')) as unknown as typeof fetch })
    const got: ReadResult[] = []
    const off = b.subscribe((r) => got.push(r))
    const es = FakeES.last!
    expect(es.url).toBe('/api/events')
    es.fire('message', JSON.stringify({ ok: true, doc: makeDoc([]) })) // unnamed events are not ours
    expect(got).toHaveLength(0)
    es.fire('doc', JSON.stringify({ ok: true, doc }))
    es.fire('doc', 'not json')
    expect(got).toEqual([{ ok: true, doc }])
    off()
    expect(es.closed).toBe(true)
  })

  test('after a dropped connection the next open triggers a re-read', async () => {
    let reads = 0
    const b = new HttpBackend({
      EventSource: FakeES as unknown as typeof EventSource,
      fetch: (async () => {
        reads++
        return new Response(JSON.stringify({ ok: true, doc }))
      }) as unknown as typeof fetch,
    })
    const got: ReadResult[] = []
    b.subscribe((r) => got.push(r))
    const es = FakeES.last!
    es.fire('open')
    await flush()
    expect(reads).toBe(0) // first open: the view already did the initial read
    es.fire('error')
    es.fire('open')
    await flush()
    expect(reads).toBe(1)
    expect(got).toEqual([{ ok: true, doc }])
  })
})

function tauriApi(over: Partial<TauriApi> = {}): TauriApi & { calls: Array<[string, unknown]>; handlers: Array<(e: { payload: unknown }) => void>; unlistened: number } {
  const calls: Array<[string, unknown]> = []
  const handlers: Array<(e: { payload: unknown }) => void> = []
  const api = {
    calls,
    handlers,
    unlistened: 0,
    async invoke(cmd: string, args?: unknown) {
      calls.push([cmd, args])
      return cmd === 'store_read' ? { ok: true, doc } : { ok: true, changed: true, rev: 4, result: {}, doc }
    },
    async listen(event: string, cb: (e: { payload: unknown }) => void) {
      calls.push(['listen', event])
      handlers.push(cb)
      await Promise.resolve()
      return () => void api.unlistened++
    },
    ...over,
  } as TauriApi & { calls: Array<[string, unknown]>; handlers: Array<(e: { payload: unknown }) => void>; unlistened: number }
  return api
}

describe('TauriBackend', () => {
  test('read invokes store_read; apply invokes store_apply with { op }', async () => {
    const api = tauriApi()
    const b = new TauriBackend(api)
    expect((await b.read()).ok).toBe(true)
    await b.apply({ op: 'move', id: 'a', after: null })
    expect(api.calls).toEqual([
      ['store_read', undefined],
      ['store_apply', { op: { op: 'move', id: 'a', after: null } }],
    ])
  })

  test('subscribe listens for store-changed and forwards the payload', async () => {
    const api = tauriApi()
    const b = new TauriBackend(api)
    const got: ReadResult[] = []
    b.subscribe((r) => got.push(r))
    await flush()
    expect(api.calls).toContainEqual(['listen', 'store-changed'])
    api.handlers[0]!({ payload: { ok: true, doc } })
    expect(got).toEqual([{ ok: true, doc }])
  })

  test('unsubscribe before listen() resolved still unlistens once it does', async () => {
    const api = tauriApi()
    const b = new TauriBackend(api)
    const off = b.subscribe(() => {})
    off()
    await flush()
    expect(api.unlistened).toBe(1)
  })

  test('a rejected invoke becomes io_error, unless it carries an error envelope', async () => {
    const b1 = new TauriBackend(tauriApi({ invoke: async () => Promise.reject('boom') }))
    const r1 = await b1.apply({ op: 'reset_corrupt' })
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect([r1.error, r1.message]).toEqual(['io_error', 'boom'])
    const b2 = new TauriBackend(tauriApi({ invoke: async () => Promise.reject({ ok: false, error: 'lock_timeout' }) }))
    expect(await b2.apply({ op: 'reset_corrupt' })).toEqual({ ok: false, error: 'lock_timeout' })
  })

  test('close exists only when the api can close the window', () => {
    expect(new TauriBackend(tauriApi()).close).toBeUndefined()
    let closed = 0
    const b = new TauriBackend(tauriApi({ closeWindow: () => void closed++ }))
    b.close!()
    expect(closed).toBe(1)
  })
})
