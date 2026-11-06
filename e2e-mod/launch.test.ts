// /ttd opens the window: detached launch through TTD_BIN, and the install text when nothing is installed.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { cleanup, isolatedPlugin, runClaude, say, scrubbedEnv, tmpDir } from "./harness.ts"

setDefaultTimeout(180_000)
afterAll(cleanup)

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("f) TTD_BIN script is launched detached: marker appears, /ttd returns while it is still running", async () => {
  const dir = tmpDir()
  const marker = join(dir, "launched.marker")
  const pidFile = join(dir, "launched.pid")
  const script = join(dir, "fake-ttd.sh")
  writeFileSync(script, `#!/bin/sh\ntouch "$TTD_TEST_MARKER"\necho $$ > "$TTD_TEST_PIDFILE"\nexec sleep 30\n`)
  chmodSync(script, 0o755)
  let pid = 0
  try {
    const r = await runClaude("/ttd", {
      home: join(dir, "ttd"),
      env: { TTD_NO_LAUNCH: undefined, TTD_BIN: script, TTD_TEST_MARKER: marker, TTD_TEST_PIDFILE: pidFile },
    })
    expect(r.code, say(r)).toBe(0)
    expect(r.out).toContain(script)
    for (let i = 0; i < 50 && !existsSync(pidFile); i++) await sleep(100)
    expect(existsSync(marker)).toBe(true)
    pid = Number(readFileSync(pidFile, "utf8").trim())
    expect(pid > 1).toBe(true)
    // Detached: /ttd returned (claude exited) well before the script's 30 s sleep ended, and the script outlives it.
    expect(r.ms < 25_000, say(r)).toBe(true)
    expect(alive(pid)).toBe(true)
  } finally {
    if (pid > 1) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
  }
})

test("g) nothing installed: the install text with the release URL, no crash, nothing launched", async () => {
  const dir = tmpDir()
  const plugin = isolatedPlugin()
  const r = await runClaude("/ttd", {
    home: join(dir, "ttd"),
    pluginDir: plugin,
    env: { TTD_NO_LAUNCH: undefined, TTD_BIN: undefined, TTD_APP_DIRS: join(dir, "no-apps"), LOCALAPPDATA: undefined, PROGRAMFILES: undefined, PATH: scrubbedEnv().PATH },
  })
  expect(r.code, say(r)).toBe(0)
  expect(r.out).toContain("https://github.com/kristianDKAndersen/ttd/releases/latest")
  expect(r.out).toContain("gh release download -R kristianDKAndersen/ttd")
  expect(r.out).toContain("xattr -dr com.apple.quarantine")
  expect(r.stderr).not.toContain("Error")
})
