import { createBackend } from './backend.ts'
import { mount } from './view.ts'

const root = document.getElementById('app')
if (!root) throw new Error('#app missing')

/** Under `TTD_SMOKE=1` the Tauri shell asks for the rendered row count (app/scripts/smoke.ts). */
async function smokeReporter(): Promise<((count: number) => void) | undefined> {
  const core = await import('@tauri-apps/api/core')
  if (!core.isTauri() || !(await core.invoke<boolean>('is_smoke'))) return undefined
  return (count) => void core.invoke('smoke_report', { count }).catch(() => {})
}

void Promise.all([createBackend(), smokeReporter().catch(() => undefined)]).then(([backend, onRender]) => mount(root, backend, { onRender }))
