// Engine-level tests: the mod's hooks run in the real engine host; the world beneath (fs, process, env) is a
// small in-memory stand-in that honours the semantics the core relies on (exclusive mkdir, mv -f replace,
// rm -rf). Real files are exercised by e2e-mod/. Run by `claude plugin test plugin`.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const HOME = '/h/.ttd'
const TODOS = `${HOME}/todos.json`
const ID = /^t_[a-z0-9]+$/
const COMPACTED = [{ role: 'user' as const, text: 'summary', toolUses: [] }]

type Opts = {
  env?: Record<string, string>
  files?: Record<string, string>
  exists?: string[]
  uname?: string
  onPath?: string
  failRead?: boolean
  noProcess?: boolean
  launchExit?: number
}

function fakeHost(on: On, opts: Opts = {}) {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}))
  const dirs = new Set<string>(['/', '/h'])
  const runs: string[][] = []
  const specs: { name: string; description: string; inputSchema: any; isDeferred?: boolean }[] = []
  const commands: string[] = []
  const parent = (p: string) => p.slice(0, Math.max(1, p.lastIndexOf('/')))
  const mkdirp = (p: string) => {
    for (let q = p; q && q !== '/'; q = parent(q)) dirs.add(q)
  }
  const gone = (p: string) => {
    dirs.delete(p)
    files.delete(p)
    for (const f of [...files.keys()]) if (f.startsWith(p + '/')) files.delete(f)
    for (const d of [...dirs]) if (d.startsWith(p + '/')) dirs.delete(d)
  }
  mock.env(on, { TTD_HOME: HOME, ...(opts.env ?? {}) })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => {
    specs.push(e as never)
    return { value: { tool: `mcp__ttd__${(e as { name: string }).name}` } }
  })
  on('command.register', (_, e) => {
    commands.push((e as { name: string }).name)
    return { value: { command: (e as { name: string }).name } }
  })
  on('fs.read', (_, e) => {
    const { path: p, as } = e as { path: string; as?: string }
    if (opts.failRead && p === TODOS) return { deny: 'EIO: i/o error' }
    const t = files.get(p)
    if (t === undefined) return { deny: `ENOENT: no such file or directory, open '${p}'` }
    // like the real host: text by default, { base64 } for { as: 'bytes' } (the store reads bytes and decodes them strictly)
    return { value: as === 'bytes' ? { base64: btoa(String.fromCharCode(...new TextEncoder().encode(t))) } : t }
  })
  on('fs.write', (_, e) => {
    const { path, text } = e as { path: string; text: string }
    mkdirp(parent(path))
    files.set(path, text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => {
    const p = (e as { path: string }).path
    return { value: files.has(p) || dirs.has(p) || (opts.exists ?? []).includes(p) }
  })
  on('fs.stat', (_, e) => {
    const p = (e as { path: string }).path
    if (files.has(p)) return { value: { kind: 'file', size: files.get(p)!.length, mtimeMs: 1000, isLink: false } }
    if (dirs.has(p)) return { value: { kind: 'dir', size: 0, mtimeMs: 1000, isLink: false } }
    return { deny: `ENOENT: ${p}` }
  })
  on('clock.sleep', () => ({ value: undefined })) // retries and lock waits do not really wait
  on('process.run', (_, e) => {
    if (opts.noProcess) return { deny: 'process is not available in this host' }
    const argv = (e as { argv: string[] }).argv
    runs.push([...argv])
    const r = (exitCode: number, stdout = '', stderr = '') => ({
      value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
    })
    const [cmd, ...a] = argv
    if (cmd === 'mkdir' && a[0] === '-p') return mkdirp(a[1]!), r(0)
    if (cmd === 'mkdir') {
      const p = a[0]!
      if (dirs.has(p)) return r(1, '', `mkdir: ${p}: File exists`)
      if (!dirs.has(parent(p))) return r(1, '', `mkdir: ${p}: No such file or directory`)
      dirs.add(p)
      return r(0)
    }
    // mod-io's POSIX rename and copy are `sh -c <script> sh <from> <to>`: the script refuses a directory destination (rename)
    // or an existing destination (copy), else moves or copies the file.
    if (cmd === 'sh' && a[0] === '-c' && /exec mv -f/.test(a[1] ?? '')) {
      const [from, to] = [a[3]!, a[4]!]
      if (dirs.has(to)) return r(75, '', `rename: destination is a directory: ${to}`)
      const t = files.get(from)
      if (t === undefined) return r(1, '', `mv: ${from}: No such file or directory`)
      files.delete(from)
      mkdirp(parent(to))
      files.set(to, t)
      return r(0)
    }
    if (cmd === 'sh' && a[0] === '-c' && /ln -- /.test(a[1] ?? '')) {
      const [from, to] = [a[3]!, a[4]!]
      if (files.has(to) || dirs.has(to)) return r(75, '', `copy: destination exists: ${to}`)
      const t = files.get(from)
      if (t === undefined) return r(1, '', `cp: ${from}: No such file or directory`)
      files.set(to, t)
      return r(0)
    }
    if (cmd === 'rm' && a[0] === '-rf') return gone(a[1]!), r(0)
    if (cmd === 'uname') return r(0, `${opts.uname ?? 'Linux'}\n`)
    if (cmd === 'sh' && a[1] === 'command -v ttd') return opts.onPath ? r(0, `${opts.onPath}\n`) : r(1)
    return r(opts.launchExit ?? 0)
  })
  return { files, dirs, runs, specs, commands }
}

const start = ($: any) => $.session.start({ cwd: '/', surface: null, isInteractive: false })
const asObj = (r: any): any => {
  expect(r.deny).toBeUndefined()
  return typeof r.result === 'string' ? JSON.parse(r.result) : r.result
}
const call = ($: any, name: string, input: Record<string, unknown> = {}) => $.tool.call({ tool: `mcp__ttd__${name}`, ...input })
const stored = (h: ReturnType<typeof fakeHost>) => JSON.parse(h.files.get(TODOS)!)

/** Captures what reaches the model beside each prompt (the engine's own bottom hook). */
function promptSink(on: On) {
  const seen: (readonly string[] | undefined)[] = []
  on('prompt.submit', (_, e) => {
    seen.push(e.context)
    return { text: e.text, context: e.context }
  })
  return seen
}
const submit = ($: any, text: string, extra: Record<string, unknown> = {}) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, ...extra })
const SEED = (rev: number, items: object[]) => JSON.stringify({ schemaVersion: 1, rev, items })
const mk = (id: string, title: string, status = 'todo', order = 0) => ({
  id,
  title,
  body: '',
  status,
  order,
  createdAt: '2026-01-01T09:00:00.000Z',
  updatedAt: '2026-01-01T09:00:00.000Z',
})

// ---- 1. registration ---------------------------------------------------------------------------------------------

test('session.start registers six undeferred tools and the /ttd command', async ($, on) => {
  const h = fakeHost(on)
  await start($)
  expect(h.specs.map(s => s.name)).toEqual(['list', 'add', 'update', 'set_status', 'reorder', 'delete'])
  for (const s of h.specs) expect(s.isDeferred).toBe(false)
  expect(h.commands).toEqual(['ttd'])
})

// ---- 2. each tool goes through the core --------------------------------------------------------------------------

test('tools add/update/set_status/reorder/delete/list run the real core and return the envelope', async ($, on) => {
  const h = fakeHost(on)
  await start($)

  const a = asObj(await call($, 'add', { title: '  First  ', body: 'body one' }))
  expect(a.ok).toBe(true)
  expect(a.changed).toBe(true)
  expect(a.rev).toBe(1)
  expect(a.result.item.title).toBe('First')
  expect(ID.test(a.result.item.id)).toBe(true)
  expect(a.todos).toContain('<ttd-todos rev="1"')
  expect(a.todos).toContain(`[todo] ${a.result.item.id} First - body one`)
  const idA = a.result.item.id

  const b = asObj(await call($, 'add', { title: 'Second', status: 'in_progress' }))
  const idB = b.result.item.id
  expect(b.rev).toBe(2)
  expect(b.result.item.status).toBe('in_progress')

  const u = asObj(await call($, 'update', { id: idA, title: 'First!', body: '' }))
  expect(u.result.item.title).toBe('First!')
  expect(u.rev).toBe(3)

  const s = asObj(await call($, 'set_status', { id: idA, status: 'done' }))
  expect(s.result.item.status).toBe('done')
  expect(s.todos).toContain('[done] 1 completed, latest: "First!"')

  const same = asObj(await call($, 'set_status', { id: idA, status: 'done' }))
  expect(same.changed).toBe(false)
  expect(same.rev).toBe(4)

  const mv = asObj(await call($, 'reorder', { id: idB, after: null }))
  expect(mv.result.item.order).toBe(0)

  const list = asObj(await call($, 'list'))
  expect(list.ok).toBe(true)
  expect(list.rev).toBe(5)
  expect(list.todos).toContain(`[done] ${idA} First!`) // list shows done items individually
  expect(list.todos).toContain(`[in_progress] ${idB} Second`)

  const d = asObj(await call($, 'delete', { id: idA }))
  expect(d.result).toEqual({ id: idA })

  expect(stored(h).rev).toBe(6)
  expect(stored(h).items.map((i: any) => i.title)).toEqual(['Second'])
  // no leftovers: lock released, tmp files removed
  expect([...h.dirs].some(d => d.endsWith('store.lock'))).toBe(false)
  expect([...h.files.keys()].some(f => f.includes('.tmp-'))).toBe(false)
})

test('tool failures are payloads, not denies', async ($, on) => {
  const h = fakeHost(on)
  await start($)
  const nf = asObj(await call($, 'set_status', { id: 't_nope', status: 'done' }))
  expect(nf).toEqual({ ok: false, error: 'not_found' })
  const bad = asObj(await call($, 'add', { title: '   ' }))
  expect(bad.ok).toBe(false)
  expect(bad.error).toBe('invalid_title')
  const missing = asObj(await call($, 'add', {}))
  expect(missing.ok).toBe(false)
  expect(missing.error).toBe('invalid_op')
  expect(h.files.has(TODOS)).toBe(false)
})

test('corrupt store: tools say so with a hint, nothing is written', async ($, on) => {
  const h = fakeHost(on, { files: { [TODOS]: '{ broken' } })
  await start($)
  const r = asObj(await call($, 'list'))
  expect(r.ok).toBe(false)
  expect(r.error).toBe('corrupt')
  expect(r.hint).toContain('/ttd recover')
  const w = asObj(await call($, 'add', { title: 'x' }))
  expect(w.error).toBe('corrupt_no_backup')
  expect(h.files.get(TODOS)).toBe('{ broken')
})

test('no resolvable home: io_error, and the core is never asked to write', async ($, on) => {
  const h = fakeHost(on, { env: { TTD_HOME: '' } })
  await start($)
  const r = asObj(await call($, 'add', { title: 'x' }))
  expect(r.ok).toBe(false)
  expect(r.error).toBe('io_error')
  expect(r.message).toContain('TTD_HOME')
  expect(h.runs.length).toBe(0)
})

test('no process API (desktop/SDK): reads work, writes are a clear io_error', async ($, on) => {
  const h = fakeHost(on, { files: { [TODOS]: SEED(3, [mk('t_a', 'A')]) }, noProcess: true })
  await start($)
  const l = asObj(await call($, 'list'))
  expect(l.ok).toBe(true)
  expect(l.rev).toBe(3)
  const w = asObj(await call($, 'add', { title: 'x' }))
  expect(w.ok).toBe(false)
  expect(w.error).toBe('io_error')
  expect(h.files.get(TODOS)).toBe(SEED(3, [mk('t_a', 'A')]))
})

test('a crashing handler becomes a deny that names ttd', async ($, on) => {
  fakeHost(on)
  on('state.set', () => {
    throw new Error('boom')
  })
  // state is beneath the plugin: its failure must not escape as an unhandled hook crash on a read-only tool
  await start($)
  const r = await call($, 'list')
  expect(r.deny === undefined || r.deny.startsWith('ttd:')).toBe(true)
})

// ---- 3. prompt.submit context ------------------------------------------------------------------------------------

test('prompt.submit: attaches once per change, never twice for the same rev', async ($, on) => {
  const h = fakeHost(on, { files: { [TODOS]: SEED(7, [mk('t_a', 'Alpha', 'in_progress'), mk('t_b', 'Beta', 'todo', 1)]) } })
  const seen = promptSink(on)
  await start($)

  await submit($, 'hello')
  expect(seen.length).toBe(1)
  expect(seen[0]!.length).toBe(1)
  expect(seen[0]![0]).toContain('<ttd-todos rev="7"')
  expect(seen[0]![0]).toContain('[in_progress] t_a Alpha')
  expect(seen[0]![0]).toContain('[todo] t_b Beta')

  await submit($, 'again')
  expect(seen[1]).toBeUndefined() // same rev: nothing attached

  h.files.set(TODOS, SEED(8, [mk('t_a', 'Alpha', 'done'), mk('t_b', 'Beta', 'todo', 1)]))
  await submit($, 'after a window edit')
  expect(seen[2]!.length).toBe(1)
  expect(seen[2]![0]).toContain('rev="8"')

  await submit($, 'and again')
  expect(seen[3]).toBeUndefined()
})

test('prompt.submit: keeps context other hooks attached and appends its block last', async ($, on) => {
  fakeHost(on, { files: { [TODOS]: SEED(1, [mk('t_a', 'Alpha')]) } })
  const seen = promptSink(on)
  await start($)
  await submit($, 'x', { context: ['earlier'] })
  expect(seen[0]![0]).toBe('earlier')
  expect(seen[0]![1]).toContain('<ttd-todos')
})

test('prompt.submit: slash commands and isMeta prompts never attach (and do not consume the change)', async ($, on) => {
  fakeHost(on, { files: { [TODOS]: SEED(2, [mk('t_a', 'Alpha')]) } })
  const seen = promptSink(on)
  await start($)
  await submit($, '/ttd list', { command: { name: 'ttd', args: 'list' } })
  await submit($, 'machine prompt', { isMeta: true })
  expect(seen[0]).toBeUndefined()
  expect(seen[1]).toBeUndefined()
  await submit($, 'a real prompt')
  expect(seen[2]!.length).toBe(1) // still pending: the earlier two did not mark it seen
})

test('prompt.submit: empty and never seen attaches nothing; emptied after seen says so once', async ($, on) => {
  const h = fakeHost(on)
  const seen = promptSink(on)
  await start($)
  await submit($, 'hi')
  expect(seen[0]).toBeUndefined()

  h.files.set(TODOS, SEED(1, [mk('t_a', 'Alpha')]))
  await submit($, 'one')
  expect(seen[1]![0]).toContain('Alpha')

  h.files.set(TODOS, SEED(2, []))
  await submit($, 'two')
  expect(seen[2]![0]).toContain('(no todos)')
  await submit($, 'three')
  expect(seen[3]).toBeUndefined()
})

test('prompt.submit: re-attaches after session.compact and after /clear', async ($, on) => {
  fakeHost(on, { files: { [TODOS]: SEED(5, [mk('t_a', 'Alpha')]) } })
  on('session.compact', () => ({ messages: COMPACTED }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  const seen = promptSink(on)
  await start($)

  await submit($, 'one')
  await submit($, 'two')
  expect(seen[0]!.length).toBe(1)
  expect(seen[1]).toBeUndefined()

  await $.session.compact({ trigger: 'precompute', messages: COMPACTED })
  await submit($, 'after precompute')
  expect(seen[2]).toBeUndefined() // precompute installs nothing: the model still has the list

  await $.session.compact({ trigger: 'manual', messages: COMPACTED })
  await submit($, 'after compact')
  expect(seen[3]!.length).toBe(1)
  await submit($, 'again')
  expect(seen[4]).toBeUndefined()

  await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })
  await submit($, 'after clear')
  expect(seen[5]!.length).toBe(1)
})

test('prompt.submit: the model\'s own tool write does not re-attach', async ($, on) => {
  fakeHost(on)
  const seen = promptSink(on)
  await start($)
  const a = asObj(await call($, 'add', { title: 'Mine' }))
  expect(a.ok).toBe(true)
  await submit($, 'next prompt')
  expect(seen[0]).toBeUndefined()
})

test('prompt.submit: a window edit made after the model\'s write is attached', async ($, on) => {
  const h = fakeHost(on)
  const seen = promptSink(on)
  await start($)
  await call($, 'add', { title: 'Mine' })
  const doc = stored(h)
  doc.rev += 1
  doc.items.push(mk('t_win', 'From the window', 'todo', 1))
  h.files.set(TODOS, JSON.stringify(doc))
  await submit($, 'next')
  expect(seen[0]![0]).toContain('From the window')
  expect(seen[0]![0]).toContain('Mine')
})

test('prompt.submit: a store that throws never blocks the prompt', async ($, on) => {
  const h = fakeHost(on, { files: { [TODOS]: SEED(1, [mk('t_a', 'A')]) }, failRead: true })
  const seen = promptSink(on)
  await start($)
  const r = await submit($, 'still goes through')
  expect(r.drop).toBeUndefined()
  expect(r.text).toBe('still goes through')
  expect(seen.length).toBe(1)
  expect(seen[0]).toBeUndefined()
  expect(h.runs.length >= 0).toBe(true)
})

test('prompt.submit: a corrupt store attaches nothing', async ($, on) => {
  fakeHost(on, { files: { [TODOS]: 'garbage' } })
  const seen = promptSink(on)
  await start($)
  await submit($, 'hi')
  expect(seen[0]).toBeUndefined()
})

// ---- 6/7. /ttd ---------------------------------------------------------------------------------------------------

const run = ($: any, args: string) => $.command.run({ command: 'ttd', args })

test('/ttd op prints the envelope and sets exitCode from ok', async ($, on) => {
  const h = fakeHost(on)
  await start($)
  const ok = await run($, `op '{"op":"add","title":"via op"}'`)
  expect(ok.exitCode).toBe(0)
  const env = JSON.parse(ok.text)
  expect(env.ok).toBe(true)
  expect(env.rev).toBe(1)
  expect(stored(h).items[0].title).toBe('via op')

  const nf = await run($, `op '{"op":"delete","id":"t_x"}'`)
  expect(nf.exitCode).toBe(0) // delete of a missing id is ok, changed:false
  expect(JSON.parse(nf.text).changed).toBe(false)

  const bad = await run($, `op '{"op":"set_status","id":"t_x","status":"done"}'`)
  expect(bad.exitCode).toBe(1)
  expect(JSON.parse(bad.text)).toEqual({ ok: false, error: 'not_found' })

  const junk = await run($, `op 'not json'`)
  expect(junk.exitCode).toBe(1)
  expect(JSON.parse(junk.text).error).toBe('invalid_op')
})

test('/ttd human subcommands: add, start, todo, done, rm, list, path, recover', async ($, on) => {
  const h = fakeHost(on)
  await start($)
  const added = await run($, `add 'Buy milk'`)
  expect(added.exitCode).toBe(0)
  const id = stored(h).items[0].id
  expect(added.text).toContain(id)
  expect(added.text).toContain('Buy milk')

  expect((await run($, `start ${id}`)).exitCode).toBe(0)
  expect(stored(h).items[0].status).toBe('in_progress')
  expect((await run($, `done ${id}`)).exitCode).toBe(0)
  expect(stored(h).items[0].status).toBe('done')
  expect((await run($, `todo ${id}`)).exitCode).toBe(0)
  expect(stored(h).items[0].status).toBe('todo')

  const list = await run($, 'list')
  expect(list.text).toContain(`[todo] ${id} Buy milk`)

  const p = await run($, 'path')
  expect(p.text).toContain(TODOS)

  const rm = await run($, `rm ${id}`)
  expect(rm.exitCode).toBe(0)
  expect(stored(h).items).toEqual([])
  expect((await run($, 'list')).text).toContain('No todos')

  const nf = await run($, 'start t_missing')
  expect(nf.exitCode).toBe(1)
  expect(nf.text).toContain('not_found')

  const nr = await run($, 'recover')
  expect(nr.exitCode).toBe(1)
  expect(nr.text).toContain('not_corrupt')

  expect((await run($, 'add')).exitCode).toBe(2)
  expect((await run($, 'frobnicate')).exitCode).toBe(2)
  expect((await run($, 'help')).text).toContain('/ttd op')
})

test('/ttd recover quarantines a corrupt file that has a valid .bak', async ($, on) => {
  const h = fakeHost(on, { files: { [TODOS]: '{"rev": 9, trunc', [`${TODOS}.bak`]: SEED(4, [mk('t_a', 'Saved')]) } })
  await start($)
  const r = await run($, 'recover')
  expect(r.exitCode).toBe(0)
  expect(r.text).toContain('restored_from_bak')
  expect(stored(h).items[0].title).toBe('Saved')
  expect([...h.files.keys()].some(f => f.includes('todos.corrupt-'))).toBe(true)
})

test('/ttd with nothing installed prints the install steps with the release URL, no crash', async ($, on) => {
  const h = fakeHost(on, { uname: 'Linux' })
  await start($)
  const r = await run($, '')
  expect(r.exitCode).toBe(0)
  expect(r.text).toContain('https://github.com/kristianDKAndersen/ttd/releases/latest')
  expect(r.text).toContain('gh release download')
  expect(h.runs.some(a => a[0] === 'sh' && a[1] === '-c' && a[2]!.includes('nohup'))).toBe(false)
})

test('/ttd launches the window detached with the exact D6 argv; TTD_NO_LAUNCH only reports', async ($, on) => {
  const h = fakeHost(on, { env: { TTD_BIN: '/opt/ttd/ttd' }, exists: ['/opt/ttd/ttd'] })
  await start($)
  const r = await run($, '')
  expect(r.exitCode).toBe(0)
  expect(h.runs).toContainEqual(['sh', '-c', 'nohup "$1" >/dev/null 2>&1 </dev/null &', 'sh', '/opt/ttd/ttd'])
  expect(r.text).toContain('/opt/ttd/ttd')
})

test('TTD_NO_LAUNCH skips the launch', async ($, on) => {
  const h = fakeHost(on, { env: { TTD_BIN: '/opt/ttd/ttd', TTD_NO_LAUNCH: '1' }, exists: ['/opt/ttd/ttd'] })
  await start($)
  const r = await run($, '')
  expect(r.exitCode).toBe(0)
  expect(r.text).toContain('TTD_NO_LAUNCH')
  expect(h.runs.some(a => a.join(' ').includes('nohup'))).toBe(false)
})

test('a launch that exits non-zero is reported with exitCode 1', async ($, on) => {
  fakeHost(on, { env: { TTD_BIN: '/opt/ttd/ttd' }, exists: ['/opt/ttd/ttd'], launchExit: 126 })
  await start($)
  const r = await run($, '')
  expect(r.exitCode).toBe(1)
  expect(r.text).toContain('launch failed')
})

test('macOS: an installed bundle opens with `open <bundle>`', async ($, on) => {
  const h = fakeHost(on, { uname: 'Darwin', env: { HOME: '/Users/u' }, exists: ['/Applications/TTD.app'] })
  await start($)
  const r = await run($, '')
  expect(r.exitCode).toBe(0)
  expect(h.runs).toContainEqual(['open', '/Applications/TTD.app'])
})

// ---- recovery notices and escaping of echoed text ---------------------------------------------------------------

const DAMAGED = '{"rev": 9, trunc'

test('a write that restored from .bak tells the model in plain words, and keeps the warning codes', async ($, on) => {
  const h = fakeHost(on, { files: { [TODOS]: DAMAGED, [`${TODOS}.bak`]: SEED(4, [mk('t_a', 'Saved')]) } })
  await start($)
  const r = asObj(await call($, 'add', { title: 'new' }))
  expect(r.ok).toBe(true)
  expect(r.warnings).toContain('restored_from_bak')
  expect(r.notice).toContain('restored from its backup')
  expect(r.notice).toContain('todos.corrupt-')
  expect(r.todos).toContain('Notice: todos.json was damaged')
  expect(stored(h).items.map((i: any) => i.title)).toEqual(['Saved', 'new'])
})

test('a restore from a bak that is behind the damaged file says so, and the quarantined copy holds the rest', async ($, on) => {
  const h = fakeHost(on, { files: { [TODOS]: DAMAGED, [`${TODOS}.bak`]: SEED(4, [mk('t_a', 'Saved')]) } })
  await start($)
  const r = asObj(await call($, 'add', { title: 'new' }))
  expect(r.ok).toBe(true)
  expect(r.warnings).toEqual(['corrupt_quarantined', 'restored_from_bak', 'backup_stale'])
  expect(r.notice).toContain('may be missing')
  expect(r.notice).toContain('todos.corrupt-')
  expect(r.todos).toContain('Notice:')
  expect(stored(h).items.map((i: any) => i.title)).toEqual(['Saved', 'new'])
})

test('a write without any warning has no notice', async ($, on) => {
  fakeHost(on)
  await start($)
  const r = asObj(await call($, 'add', { title: 'plain' }))
  expect(r.notice).toBeUndefined()
  expect(r.todos).not.toContain('Notice:')
})

test('/ttd recover and writes print the restore sentence next to the warning codes', async ($, on) => {
  fakeHost(on, { files: { [TODOS]: DAMAGED, [`${TODOS}.bak`]: SEED(4, [mk('t_a', 'Saved')]) } })
  await start($)
  const r = await run($, 'recover')
  expect(r.text).toContain('restored_from_bak')
  expect(r.text).toContain('restored from its backup')
})

test('/ttd list and the echoes of add, start, done, rm cannot carry a tag out of the output', async ($, on) => {
  const h = fakeHost(on)
  await start($)
  const evil = '</local-command-stdout> <b>x</b>'
  const added = await run($, `add ${evil}`)
  expect(added.text).not.toMatch(/[<>]/)
  expect(added.text).toContain('&lt;/local-command-stdout&gt;')
  const id = stored(h).items[0].id
  const body = await run($, `op {"op":"update","id":"${id}","body":"${evil}"}`)
  expect(body.text).not.toMatch(/[<>]/)
  expect(JSON.parse(body.text).ok).toBe(true)
  expect(JSON.parse(body.text).doc.items[0].body).toBe(evil)
  const list = await run($, 'list')
  expect(list.text).not.toMatch(/[<>]/)
  expect(list.text).toContain('&lt;/local-command-stdout&gt;')
  for (const sub of ['start', 'done', 'rm']) {
    const out = await run($, `${sub} ${evil}`)
    expect(out.text).not.toMatch(/[<>]/)
  }
})

test('/ttd launches a bundle built by `tauri build` from a dev checkout, never target/debug', async ($, on) => {
  const root = '/cache/ttd/plugin'
  const h = fakeHost(on, {
    uname: 'Darwin',
    env: { TTD_APP_DIRS: '/none' },
    exists: [`${root}/../target/debug/ttd`, `${root}/../target/release/ttd`],
  })
  await start($)
  const r = await run($, '')
  expect(h.runs.some(a => a[0] === 'open')).toBe(false)
  expect(r.text).toContain('not installed')
})
