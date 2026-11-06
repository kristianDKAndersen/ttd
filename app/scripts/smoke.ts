// Integration proof for job d: really opens the Tauri window (target/debug/ttd, built with
// `tauri build --debug --no-bundle` so it embeds app/dist) against a temp TTD_HOME and checks plan
// steps 1-7. Needs a window server; without one it prints "SMOKE BLOCKED: ..." and exits 2.
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
const EXE = process.platform === 'win32' ? '.exe' : ''
const APP = join(ROOT, 'target', 'debug', `ttd${EXE}`)
const STORE_CLI = join(ROOT, 'target', 'debug', `ttd-store${EXE}`)

interface Line {
  type: 'render' | 'window'
  count: number | null
  alwaysOnTop: boolean
  width: number
  height: number
  x: number
  y: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol

class Fail extends Error {}
const check = (cond: unknown, msg: string): void => {
  if (!cond) throw new Fail(msg)
}

async function windowServer(): Promise<string | null> {
  if (process.platform === 'darwin') {
    const p = Bun.spawnSync(['launchctl', 'managername'])
    const name = p.stdout.toString().trim()
    return name === 'Aqua' ? null : `no window server (launchctl managername: "${name || 'unknown'}")`
  }
  if (process.platform === 'linux') {
    return process.env.DISPLAY || process.env.WAYLAND_DISPLAY ? null : 'no window server (DISPLAY/WAYLAND_DISPLAY unset)'
  }
  return null
}

class Instance {
  readonly proc: ReturnType<typeof Bun.spawn>
  readonly lines: Line[] = []
  stderr = ''

  constructor(env: Record<string, string>) {
    this.proc = Bun.spawn([APP], { env: { ...process.env, ...env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    void this.pump(this.proc.stdout as ReadableStream<Uint8Array>, (l) => {
      try {
        const v = JSON.parse(l) as Line
        if (v && typeof v === 'object' && 'type' in v) this.lines.push(v)
      } catch {
        /* non-JSON stdout from webview/tauri: ignore */
      }
    })
    void this.pump(this.proc.stderr as ReadableStream<Uint8Array>, (l) => {
      this.stderr += l + '\n'
    })
  }

  private async pump(stream: ReadableStream<Uint8Array>, onLine: (l: string) => void): Promise<void> {
    const dec = new TextDecoder()
    let buf = ''
    for await (const chunk of stream) {
      buf += dec.decode(chunk, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    }
  }

  get alive(): boolean {
    return this.proc.exitCode === null && !this.proc.killed
  }

  send(cmd: string): void {
    const sink = this.proc.stdin as import('bun').FileSink
    sink.write(cmd + '\n')
    void sink.flush()
  }

  async waitLine(pred: (l: Line) => boolean, ms: number, what: string, from = 0): Promise<Line> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const hit = this.lines.slice(from).find(pred)
      if (hit) return hit
      if (!this.alive && !this.lines.slice(from).find(pred)) {
        throw new Fail(`app exited (code ${this.proc.exitCode}) before: ${what}\n--- app stderr ---\n${this.stderr.slice(-1500)}`)
      }
      await sleep(50)
    }
    throw new Fail(`timeout after ${ms} ms waiting for: ${what}\n--- app stderr ---\n${this.stderr.slice(-1500)}`)
  }

  /** Ask the Rust side for the current window geometry (does not depend on the webview). */
  async geometry(): Promise<Line> {
    const from = this.lines.length
    this.send('report')
    return this.waitLine((l) => l.type === 'window', 5000, 'window report', from)
  }

  async exited(ms: number): Promise<boolean> {
    const done = await Promise.race([this.proc.exited.then(() => true), sleep(ms).then(() => false)])
    return done
  }

  async close(): Promise<void> {
    if (!this.alive) return
    this.send('close')
    if (!(await this.exited(10_000))) this.proc.kill()
    await this.proc.exited
  }
}

function runStore(home: string, args: string[]): void {
  const p = Bun.spawnSync([STORE_CLI, ...args], { env: { ...process.env, TTD_HOME: home } })
  check(p.exitCode === 0, `ttd-store ${args.join(' ')} failed (${p.exitCode}): ${p.stdout.toString()}${p.stderr.toString()}`)
}

const say = (n: number, msg: string) => console.log(`[smoke] step ${n}: ${msg}`)

async function main(): Promise<number> {
  const blocked = await windowServer()
  if (blocked) {
    console.log(`SMOKE BLOCKED: ${blocked}`)
    return 2
  }
  if (process.platform !== 'win32') {
    const running = Bun.spawnSync(['pgrep', '-x', 'ttd'])
    if (running.exitCode === 0) {
      console.log('SMOKE BLOCKED: another ttd process is running; single-instance would swallow the smoke launch (quit it and retry)')
      return 2
    }
  }
  check(existsSync(APP), `${APP} missing: run \`bun run build:ui && bun run tauri build --debug --no-bundle\` first`)
  const build = Bun.spawnSync(['cargo', 'build', '-p', 'ttd-store', '--quiet'], { cwd: ROOT, env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` } })
  check(build.exitCode === 0 && existsSync(STORE_CLI), `cargo build -p ttd-store failed: ${build.stderr.toString()}`)

  const tmp = mkdtempSync(join(tmpdir(), 'ttd-smoke-'))
  const home = join(tmp, 'ttd-home')
  const env = { TTD_HOME: home, TTD_SMOKE: '1' }
  const started: Instance[] = []
  const launch = () => {
    const i = new Instance(env)
    started.push(i)
    return i
  }
  try {
    // 1: seed two items with the real CLI
    runStore(home, ['apply', '{"op":"add","title":"smoke one"}'])
    runStore(home, ['apply', '{"op":"add","title":"smoke two","status":"in_progress"}'])
    say(1, 'seeded 2 items via target/debug/ttd-store')

    // 2+3: start the window; first render with 2 rows, always on top, 320x480
    const a = launch()
    say(2, `started ${APP} (TTD_SMOKE=1, TTD_HOME=${home})`)
    const first = await a.waitLine((l) => l.type === 'render' && l.count === 2, 30_000, 'render report with count 2')
    check(first.alwaysOnTop === true, `alwaysOnTop should be true, got ${first.alwaysOnTop}`)
    check(near(first.width, 320) && near(first.height, 480), `inner size should be 320x480 +-2, got ${first.width}x${first.height}`)
    say(3, `count=2 alwaysOnTop=true size=${first.width}x${first.height} at (${first.x},${first.y})`)

    // 4: external write -> watcher -> store-changed -> re-render in the real webview
    const mark = a.lines.length
    const t0 = Date.now()
    runStore(home, ['apply', '{"op":"add","title":"smoke three"}'])
    await a.waitLine((l) => l.type === 'render' && l.count === 3, 5000, 'render report with count 3 within 5 s of an external add', mark)
    say(4, `external add rendered in ${Date.now() - t0} ms (count=3)`)

    // 7 (first half): breadcrumb exists while the window runs
    const crumbPath = join(home, 'app.json')
    check(existsSync(crumbPath), `${crumbPath} not written`)
    const crumb = JSON.parse(readFileSync(crumbPath, 'utf8')) as { path: string; version: string; writtenAt: string }
    check(realpathSync(crumb.path) === realpathSync(APP), `app.json path ${crumb.path} != ${APP}`)
    check(crumb.version === '0.1.0' && !Number.isNaN(Date.parse(crumb.writtenAt)), `app.json version/writtenAt wrong: ${JSON.stringify(crumb)}`)

    // 5: move/resize, close, relaunch -> same geometry
    const want = { x: 140, y: 110, w: 410, h: 330 }
    let moved: Line | undefined
    for (let i = 0; i < 25 && !moved; i++) {
      a.send(`geometry ${want.x} ${want.y} ${want.w} ${want.h}`)
      await sleep(200)
      const g = await a.geometry()
      if (near(g.width, want.w) && near(g.height, want.h) && near(g.x, want.x) && near(g.y, want.y)) moved = g
    }
    check(moved, `window did not reach ${JSON.stringify(want)}`)
    check(!near(moved.x, first.x, 1) || !near(moved.y, first.y, 1), 'position did not change from the default')
    await a.close()
    check(!a.alive, 'first instance still alive after close')
    const stateFile = join(home, '.window-state.json')
    check(existsSync(stateFile), `window-state file ${stateFile} not written on close`)
    const b = launch()
    const again = await b.waitLine((l) => l.type === 'render' && l.count === 3, 30_000, 'relaunch render report with count 3')
    check(near(again.width, moved.width) && near(again.height, moved.height), `size not restored: ${again.width}x${again.height} vs ${moved.width}x${moved.height}`)
    check(near(again.x, moved.x) && near(again.y, moved.y), `position not restored: (${again.x},${again.y}) vs (${moved.x},${moved.y})`)
    check(again.alwaysOnTop === true, 'alwaysOnTop lost after relaunch (window-state must not touch it)')
    say(5, `restored ${again.width}x${again.height} at (${again.x},${again.y}); alwaysOnTop=true`)

    // 6: second instance exits promptly, first keeps running
    const t1 = Date.now()
    const c = launch()
    const exited = await c.exited(8000)
    check(exited, 'second instance did not exit within 8 s')
    check(b.alive, 'first instance died when the second started')
    const still = await b.geometry()
    check(near(still.x, again.x) && near(still.y, again.y), 'first window moved after the second launch')
    say(6, `second instance exited in ${Date.now() - t1} ms (code ${c.proc.exitCode}); first still alive`)

    // 7: breadcrumb refreshed by the relaunch
    const crumb2 = JSON.parse(readFileSync(crumbPath, 'utf8')) as { path: string; writtenAt: string }
    check(realpathSync(crumb2.path) === realpathSync(APP), 'app.json path wrong after relaunch')
    check(Date.parse(crumb2.writtenAt) >= Date.parse(crumb.writtenAt), 'app.json writtenAt did not advance')
    say(7, `app.json path=${crumb2.path}`)
    await b.close()

    console.log('SMOKE OK (steps 1-7)')
    return 0
  } catch (e) {
    console.log(`SMOKE FAIL: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  } finally {
    for (const i of started) if (i.alive) i.proc.kill()
    rmSync(tmp, { recursive: true, force: true })
  }
}

process.exit(await main())
