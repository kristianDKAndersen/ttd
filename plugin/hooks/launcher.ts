// /ttd with no arguments: find the TTD window and start it detached (plan D6), or say how to install it.
import { joinPath, resolveHomeDir } from './store/index.ts'
import { looksWindows } from './mod-io.ts'

export const RELEASE_URL = 'https://github.com/kristianDKAndersen/ttd/releases/latest'
const LAUNCH_TIMEOUT_MS = 10_000
// `run` waits for the child's pipes to close, so a launched GUI must not inherit them: redirect everything and background it.
const NOHUP = 'nohup "$1" >/dev/null 2>&1 </dev/null &'

export type Target = { kind: 'binary' | 'bundle' | 'exe'; path: string }

export function launchArgvFor(t: Target): string[] {
  if (t.kind === 'bundle') return ['open', t.path]
  if (t.kind === 'exe') return ['cmd', '/c', 'start', '', t.path]
  return ['sh', '-c', NOHUP, 'sh', t.path]
}

export interface LauncherEnv {
  TTD_BIN?: string
  TTD_APP_DIRS?: string
  LOCALAPPDATA?: string
  PROGRAMFILES?: string
  USERPROFILE?: string
  HOME?: string
}

export interface LauncherDeps {
  env: LauncherEnv
  /** the resolved HOME_DIR (holds app.json); empty when it cannot be resolved */
  home: string
  /** `$.plugin.root` */
  pluginRoot: string
  exists(p: string): Promise<boolean>
  readText(p: string): Promise<string | null>
  run(argv: readonly string[]): Promise<{ exitCode: number; stdout: string }>
}

export interface Launch {
  via: 'TTD_BIN' | 'breadcrumb' | 'bundle' | 'windows' | 'path' | 'dev' | 'open-a'
  argv: string[]
  /** what is being started, for the message */
  bin: string
  /** existence could not be checked (macOS `open -a`): a non-zero exit means "not installed" */
  unverified?: true
}

type Os = 'windows' | 'darwin' | 'linux'
const BUNDLE_EXE = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/

function targetFor(path: string, os: Os): Target {
  if (os === 'windows') return { kind: 'exe', path }
  if (os === 'darwin') {
    const m = BUNDLE_EXE.exec(path)
    if (m) return { kind: 'bundle', path: m[1]! }
    if (path.endsWith('.app')) return { kind: 'bundle', path }
  }
  return { kind: 'binary', path }
}

async function detectOs(d: LauncherDeps): Promise<Os> {
  // No platform API exists in the mod environment: Windows shows in its env and paths, the rest asks uname.
  if (d.env.LOCALAPPDATA || d.env.USERPROFILE || looksWindows(d.home)) return 'windows'
  try {
    const r = await d.run(['uname', '-s'])
    if (r.exitCode === 0 && /darwin/i.test(r.stdout)) return 'darwin'
  } catch {
    // fall through: treat as Linux
  }
  return 'linux'
}

/** First hit wins: TTD_BIN, the window's breadcrumb, the OS's install location, the dev checkout, then macOS `open -a`. */
export async function resolveLauncher(d: LauncherDeps): Promise<Launch | null> {
  const os = await detectOs(d)
  const hit = (via: Launch['via'], path: string): Launch => {
    const t = targetFor(path, os)
    return { via, argv: launchArgvFor(t), bin: t.path }
  }

  if (d.env.TTD_BIN && (await d.exists(d.env.TTD_BIN))) return hit('TTD_BIN', d.env.TTD_BIN)

  if (d.home) {
    try {
      const raw = await d.readText(joinPath(d.home, 'app.json'))
      const p = raw === null ? undefined : (JSON.parse(raw) as { path?: unknown }).path
      if (typeof p === 'string' && p !== '' && (await d.exists(p))) return hit('breadcrumb', p)
    } catch {
      // unreadable or malformed breadcrumb: keep looking
    }
  }

  if (os === 'darwin') {
    const dirs = d.env.TTD_APP_DIRS ? d.env.TTD_APP_DIRS.split(':').filter(Boolean) : ['/Applications', ...(d.env.HOME ? [`${d.env.HOME}/Applications`] : [])]
    for (const dir of dirs) {
      const app = `${dir.replace(/\/+$/, '')}/TTD.app`
      if (await d.exists(app)) return hit('bundle', app)
    }
  } else if (os === 'windows') {
    for (const base of [d.env.LOCALAPPDATA, d.env.PROGRAMFILES]) {
      if (!base) continue
      const exe = `${base.replace(/[\\/]+$/, '')}\\TTD\\ttd.exe`
      if (await d.exists(exe)) return hit('windows', exe)
    }
  } else {
    try {
      const r = await d.run(['sh', '-c', 'command -v ttd'])
      const p = r.stdout.trim().split('\n')[0] ?? ''
      if (r.exitCode === 0 && p !== '') return hit('path', p)
    } catch {
      // no sh: nothing on PATH to find
    }
  }

  const exe = os === 'windows' ? '.exe' : ''
  const sep = os === 'windows' ? '\\' : '/'
  for (const profile of ['debug', 'release']) {
    // Only works under --plugin-dir: an installed plugin is just plugin/, with no target/ beside it.
    const dev = [d.pluginRoot, '..', 'target', profile, `ttd${exe}`].join(sep)
    if (await d.exists(dev)) return hit('dev', dev)
  }

  if (os === 'darwin' && !d.env.TTD_APP_DIRS) return { via: 'open-a', argv: ['open', '-a', 'TTD'], bin: 'TTD', unverified: true }
  return null
}

export function installText(o: { isDevCheckout: boolean }): string {
  const lines = [
    'The TTD window is not installed on this machine, so there is nothing to open.',
    '',
    'Install it:',
    `  1. Download the installer for your system from ${RELEASE_URL}`,
    '     (while the repository is private you need collaborator access: gh release download -R kristianDKAndersen/ttd)',
    '  2. Run it, then run /ttd again.',
    '',
    'The builds are unsigned:',
    '  macOS: xattr -dr com.apple.quarantine /Applications/TTD.app   (or right-click the app, Open)',
    '  Windows: SmartScreen "More info", then "Run anyway"',
    '',
    'A window in a custom place: set TTD_BIN to its path.',
  ]
  if (o.isDevCheckout) lines.push('From a checkout of the repository: bun run tauri dev')
  lines.push('', 'Todos work without the window: /ttd list, /ttd add <title>, or the mcp__ttd__* tools.')
  return lines.join('\n')
}

/** The slice of the engine's `$` the launcher uses. */
export type LauncherHost = {
  env: { get(name: string): Promise<string | undefined> }
  plugin: { root: string }
  fs: { exists(path: string): Promise<boolean>; read(path: string): Promise<string | { base64: string }> }
  process: { run(argv: readonly string[], init?: { timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }> }
}

export async function openWindow($: LauncherHost): Promise<{ text: string; exitCode: number }> {
  const TTD_BIN = await $.env.get('TTD_BIN')
  const TTD_APP_DIRS = await $.env.get('TTD_APP_DIRS')
  const LOCALAPPDATA = await $.env.get('LOCALAPPDATA')
  const PROGRAMFILES = await $.env.get('PROGRAMFILES')
  const USERPROFILE = await $.env.get('USERPROFILE')
  const HOME = await $.env.get('HOME')
  const TTD_HOME = await $.env.get('TTD_HOME')
  const TTD_NO_LAUNCH = await $.env.get('TTD_NO_LAUNCH')
  const exists = async (p: string): Promise<boolean> => {
    try {
      return await $.fs.exists(p)
    } catch {
      return false
    }
  }
  const deps: LauncherDeps = {
    env: { TTD_BIN, TTD_APP_DIRS, LOCALAPPDATA, PROGRAMFILES, USERPROFILE, HOME },
    home: resolveHomeDir({ TTD_HOME, USERPROFILE, HOME }),
    pluginRoot: $.plugin.root,
    exists,
    readText: async (p) => {
      try {
        const r = await $.fs.read(p)
        return typeof r === 'string' ? r : null
      } catch {
        return null
      }
    },
    run: (argv) => $.process.run(argv, { timeoutMs: LAUNCH_TIMEOUT_MS }),
  }

  const found = await resolveLauncher(deps)
  const notInstalled = async (): Promise<{ text: string; exitCode: number }> => ({
    text: installText({ isDevCheckout: await exists(`${$.plugin.root}/../app/src-tauri`) }),
    exitCode: 0,
  })
  if (!found) return notInstalled()

  if (TTD_NO_LAUNCH && TTD_NO_LAUNCH !== '0') return { text: `TTD_NO_LAUNCH is set, not launching. Would start (${found.via}): ${found.bin}`, exitCode: 0 }

  let r: { exitCode: number; stderr?: string; stdout?: string }
  try {
    r = await $.process.run(found.argv, { timeoutMs: LAUNCH_TIMEOUT_MS })
  } catch (e) {
    // No $.process (desktop app, SDK sessions) lands here too.
    return { text: `launch failed (${found.via}: ${found.bin}): ${e instanceof Error ? e.message : String(e)}`, exitCode: 1 }
  }
  if (r.exitCode === 0) return { text: `Opened the TTD window (${found.via}: ${found.bin}).`, exitCode: 0 }
  if (found.unverified) return notInstalled()
  return { text: `launch failed (${found.via}: ${found.bin}, exit ${r.exitCode}): ${(r.stderr ?? '').trim() || 'no output'}`, exitCode: 1 }
}
