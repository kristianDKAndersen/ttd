// Real-browser E2E (plan job g, E1-E7): installed Google Chrome driven by playwright-core against the BUILT app/dist,
// served by a real `bun store-node/shim.ts` process on a random port with a fresh temp TTD_HOME per test.
// Needs `bun run build:ui` first. Never touches ~/.ttd. Mouse input goes through page.mouse (real input events).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "playwright-core"
import type { Browser, Page } from "playwright-core"

setDefaultTimeout(45_000)

const ROOT = join(import.meta.dir, "../..")
const SHIM = join(ROOT, "store-node/shim.ts")
const CLI = join(ROOT, "store-node/cli.ts")
const OUT = join(import.meta.dir, "out")

let browser: Browser
const tmps: string[] = []

beforeAll(async () => {
  if (!existsSync(join(ROOT, "app/dist/index.html"))) throw new Error("app/dist is missing: run `bun run build:ui` before the E2E tests")
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true })
  } catch (e) {
    throw new Error(`E2E needs the real Google Chrome installed (playwright channel "chrome"); launch failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}, 60_000)

afterAll(async () => {
  await browser?.close()
  for (const t of tmps) rmSync(t, { recursive: true, force: true })
})

// ---------------------------------------------------------------- harness

interface Env {
  page: Page
  home: string
  url: string
  /** Run `bun store-node/cli.ts apply` against this test's home; throws unless the envelope is ok. */
  cli(op: unknown): Promise<{ ok: true; doc: { rev: number; items: Array<{ id: string; title: string }> } }>
  todos(): { rev: number; items: Array<{ id: string; title: string; body: string; status: string; order: number }> }
  titles(): string[] // on-disk titles in `order` order
  rows(): Promise<string[]> // DOM row titles in display order
  errors: string[]
}

async function firstLine(stream: ReadableStream<Uint8Array>, ms: number): Promise<string> {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let buf = ""
  const deadline = Date.now() + ms
  while (!buf.includes("\n")) {
    const left = deadline - Date.now()
    if (left <= 0) throw new Error(`shim printed nothing within ${ms}ms`)
    const r = await Promise.race([reader.read(), new Promise<null>((res) => setTimeout(() => res(null), left))])
    if (r === null) continue
    if (r.done) throw new Error(`shim stdout closed early: ${JSON.stringify(buf)}`)
    buf += dec.decode(r.value)
  }
  reader.releaseLock()
  return buf.slice(0, buf.indexOf("\n"))
}

async function withApp(
  body: (e: Env) => Promise<void>,
  opts: { viewport?: { width: number; height: number }; scale?: number } = {},
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "ttd-e2e-"))
  tmps.push(home)
  const childEnv = { ...(process.env as Record<string, string>), TTD_HOME: home }
  const proc = Bun.spawn(["bun", SHIM], { env: { ...childEnv, TTD_SHIM_PORT: "0" }, stdout: "pipe", stderr: "pipe" })
  let ctx: Awaited<ReturnType<Browser["newContext"]>> | undefined
  try {
    ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 360, height: 640 }, deviceScaleFactor: opts.scale ?? 1 })
    const info = JSON.parse(await firstLine(proc.stdout as ReadableStream<Uint8Array>, 10_000)) as { listening: string; home: string }
    expect(info.home).toBe(home) // the shim must be on the temp home, never ~/.ttd
    const page = await ctx.newPage()
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))
    const file = join(home, "todos.json")
    const env: Env = {
      page,
      home,
      url: info.listening,
      errors,
      async cli(op) {
        const p = Bun.spawn(["bun", CLI, "apply", JSON.stringify(op)], { env: childEnv, stdout: "pipe", stderr: "pipe" })
        const out = await new Response(p.stdout as ReadableStream).text()
        await p.exited
        const env = JSON.parse(out)
        if (!env.ok) throw new Error(`cli apply failed: ${out}`)
        return env
      },
      todos: () => JSON.parse(readFileSync(file, "utf8")),
      titles: () => env.todos().items.sort((a, b) => a.order - b.order).map((i) => i.title),
      rows: () => page.locator("li.row .row-title").allTextContents(),
    }
    await body(env)
    expect(errors).toEqual([]) // no uncaught page exception during the scenario
  } finally {
    proc.kill() // first: a failing ctx.close() must not skip it
    await ctx?.close()
  }
}

async function open(e: Env): Promise<void> {
  await e.page.goto(e.url)
  await e.page.waitForSelector(".panel")
}

const seed = async (e: Env, titles: string[], bodyOf: (t: string) => string = () => "") => {
  for (const title of titles) await e.cli({ op: "add", title, body: bodyOf(title) })
}
const row = (e: Env, title: string) => e.page.locator("li.row", { has: e.page.locator(".row-title", { hasText: new RegExp(`^${title}$`) }) })
const SIX = ["some task i need to do 1", "some task i need to do 2", "some task i need to do 3", "some task i need to do 4", "some task i need to do 5", "some task i need to do 6"]
const FIVE = ["T1", "T2", "T3", "T4", "T5"]

/** Retry `read` until it deep-equals `want` or `ms` pass (bun 1.3.4 has no expect.poll). */
async function pollEqual<T>(read: () => T | Promise<T>, want: T, ms = 3000): Promise<void> {
  const t0 = Date.now()
  let last: T | undefined
  let lastErr: unknown
  for (;;) {
    try {
      last = await read()
      lastErr = undefined
      if (JSON.stringify(last) === JSON.stringify(want)) return
    } catch (e) {
      lastErr = e // e.g. todos.json mid-rename on a non-atomic reader; retry
    }
    if (Date.now() - t0 > ms) throw new Error(`timeout after ${ms}ms: wanted ${JSON.stringify(want)}, last ${lastErr ? String(lastErr) : JSON.stringify(last)}`)
    await new Promise((r) => setTimeout(r, 40))
  }
}

/** Drag row `from` to the gap between the rows currently at indexes `gap-1` and `gap` using page.mouse. Returns after the release. */
async function dragTo(page: Page, fromTitle: string, gap: number, opts: { release: boolean } = { release: true }): Promise<void> {
  const rects = await page.locator("li.row").evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, width: r.width } }))
  const titles = await page.locator("li.row .row-title").allTextContents()
  const i = titles.indexOf(fromTitle)
  expect(i).toBeGreaterThanOrEqual(0)
  const src = rects[i]!
  const x = src.left + 24
  const y0 = src.top + 16
  const y1 = (rects[gap - 1]!.bottom + rects[gap]!.top) / 2
  await page.mouse.move(x, y0)
  await page.mouse.down()
  const steps = 18
  for (let s = 1; s <= steps; s++) await page.mouse.move(x + 6, y0 + ((y1 - y0) * s) / steps)
  if (opts.release) await page.mouse.up()
}

// ---------------------------------------------------------------- E1

describe("E1 add via the form", () => {
  test("typing a title and body and pressing Enter writes the todo to todos.json", async () => {
    await withApp(async (e) => {
      await open(e)
      await expect(e.page.locator(".empty").textContent()).resolves.toContain("Nothing here yet")
      await e.page.click(".add")
      await e.page.locator(".f-title").waitFor()
      await e.page.keyboard.type("Fix the login bug")
      await e.page.locator(".f-body").click()
      await e.page.keyboard.type("repro: wrong password twice")
      await e.page.locator(".f-title").click()
      await e.page.keyboard.press("Enter")
      await row(e, "Fix the login bug").waitFor({ timeout: 3000 })
      await e.page.locator(".new-form").waitFor({ state: "detached" })
      const disk = e.todos()
      expect(disk.rev).toBe(1)
      expect(disk.items).toHaveLength(1)
      expect(disk.items[0]).toMatchObject({ title: "Fix the login bug", body: "repro: wrong password twice", status: "todo", order: 0 })
    })
  })

  test("an empty title is refused in the page and nothing is written", async () => {
    await withApp(async (e) => {
      await open(e)
      await e.page.click(".add")
      await e.page.locator(".f-title").focus()
      await e.page.keyboard.press("Enter")
      await expect(e.page.locator(".f-title").getAttribute("aria-invalid")).resolves.toBe("true")
      expect(existsSync(join(e.home, "todos.json"))).toBe(false)
    })
  })
})

// ---------------------------------------------------------------- E2

describe("E2 external writes keep the UI state", () => {
  test("an agent's cli add appears within 2 s; the open form keeps its text and the expanded row stays expanded", async () => {
    await withApp(async (e) => {
      await seed(e, ["alpha", "bravo", "charlie"], (t) => `details of ${t}`)
      await open(e)
      await expect(e.rows()).resolves.toEqual(["alpha", "bravo", "charlie"])

      await row(e, "bravo").locator(".row-toggle").click()
      await expect(row(e, "bravo").getAttribute("class")).resolves.toContain("expanded")
      await e.page.click(".add")
      await e.page.locator(".f-title").click()
      await e.page.keyboard.type("half typed title")
      await e.page.locator(".f-body").click()
      await e.page.keyboard.type("half typed body")

      await e.cli({ op: "add", title: "from the agent" })
      await row(e, "from the agent").waitFor({ timeout: 2000 })
      await e.cli({ op: "set_status", id: e.todos().items.find((i) => i.title === "alpha")!.id, status: "in_progress" })
      await e.page.locator('li.row[data-status="in_progress"]').waitFor({ timeout: 2000 })

      await expect(e.page.locator(".f-title").inputValue()).resolves.toBe("half typed title")
      await expect(e.page.locator(".f-body").inputValue()).resolves.toBe("half typed body")
      await expect(e.page.evaluate(() => document.activeElement?.className)).resolves.toBe("f-body")
      await expect(row(e, "bravo").getAttribute("class")).resolves.toContain("expanded")
      await expect(row(e, "bravo").locator(".row-body").isVisible()).resolves.toBe(true)
      await expect(e.rows()).resolves.toEqual(["alpha", "bravo", "charlie", "from the agent"])
    })
  })

  test("an external delete of the expanded row collapses it without breaking the rest", async () => {
    await withApp(async (e) => {
      await seed(e, ["one", "two"])
      await open(e)
      await row(e, "one").locator(".row-toggle").click()
      await e.cli({ op: "delete", id: e.todos().items.find((i) => i.title === "one")!.id })
      await pollEqual(() => e.rows(), ["two"], 2000)
      await expect(e.page.locator("li.row.expanded").count()).resolves.toBe(0)
    })
  })
})

// ---------------------------------------------------------------- E3

describe("E3 real mouse drag reorder", () => {
  test("row 5 dropped between rows 2 and 3: disk order matches, ghost and drop slot show mid-drag, survives reload", async () => {
    await withApp(async (e) => {
      await seed(e, FIVE)
      await open(e)
      await dragTo(e.page, "T5", 2, { release: false })
      await expect(e.page.locator(".ghost").count()).resolves.toBe(1)
      await expect(e.page.locator(".drop-slot").isVisible()).resolves.toBe(true)
      await e.page.mouse.up()
      await expect(e.page.locator(".ghost").count()).resolves.toBe(0)

      const want = ["T1", "T2", "T5", "T3", "T4"]
      await pollEqual(() => e.titles(), want, 3000)
      expect(e.todos().items.map((i) => i.order).sort()).toEqual([0, 1, 2, 3, 4])
      await expect(e.rows()).resolves.toEqual(want)
      await expect(e.page.locator("li.row.expanded").count()).resolves.toBe(0) // a drag is not a click

      await e.page.reload()
      await e.page.waitForSelector("li.row")
      await expect(e.rows()).resolves.toEqual(want)
      expect(e.titles()).toEqual(want)
    })
  })

  test("dragging a row to the very top and the very bottom", async () => {
    await withApp(async (e) => {
      await seed(e, FIVE)
      await open(e)
      await dragTo(e.page, "T3", 1) // between T1 and T2 ...
      await pollEqual(() => e.titles(), ["T1", "T3", "T2", "T4", "T5"], 3000)
      await dragTo(e.page, "T1", 4) // ... then T1 down between T4 and T5
      await pollEqual(() => e.titles(), ["T3", "T2", "T4", "T1", "T5"], 3000)
      await expect(e.rows()).resolves.toEqual(["T3", "T2", "T4", "T1", "T5"])
    })
  })

  test("a drag over an external write is applied on top of it (no lost item)", async () => {
    await withApp(async (e) => {
      await seed(e, FIVE)
      await open(e)
      await dragTo(e.page, "T5", 2, { release: false })
      await e.cli({ op: "add", title: "agent-added" })
      await new Promise((r) => setTimeout(r, 900)) // let the watcher publish while the drag is in flight
      await e.page.mouse.up()
      await pollEqual(() => e.titles(), ["T1", "T2", "T5", "T3", "T4", "agent-added"], 4000)
      await pollEqual(() => e.rows(), ["T1", "T2", "T5", "T3", "T4", "agent-added"], 4000)
    })
  })
})

// ---------------------------------------------------------------- E4

type Rgb = [number, number, number]
const parseRgb = (s: string): Rgb => {
  const m = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(s)
  if (!m) throw new Error(`unparseable colour ${s}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}
const hue = ([r, g, b]: Rgb): "grey" | "blue" | "green" | "other" => {
  const spread = Math.max(r, g, b) - Math.min(r, g, b)
  if (spread <= 12) return "grey"
  if (b > r && b > g) return "blue"
  if (g > r && g > b) return "green"
  return "other"
}

describe("E4 status colours", () => {
  test("play and check change the row background to the in-progress and done tokens (grey, blue, green) in light and dark", async () => {
    await withApp(async (e) => {
      await seed(e, ["idle", "working", "finished"])
      await open(e)
      await row(e, "working").locator(".row-toggle").click()
      await row(e, "working").locator(".act.play").click()
      await e.page.locator('li.row[data-status="in_progress"]').waitFor({ timeout: 3000 })
      await row(e, "finished").locator(".row-toggle").click()
      await row(e, "finished").locator(".act.check").click()
      await e.page.locator('li.row[data-status="done"]').waitFor({ timeout: 3000 })
      expect(e.todos().items.map((i) => `${i.title}:${i.status}`).sort()).toEqual(["finished:done", "idle:todo", "working:in_progress"])

      const seen: Record<string, Rgb[]> = {}
      for (const scheme of ["light", "dark"] as const) {
        await e.page.emulateMedia({ colorScheme: scheme })
        const bg = await e.page.evaluate(() => {
          const rowBg = (t: string) => {
            const li = [...document.querySelectorAll("li.row")].find((x) => x.querySelector(".row-title")?.textContent === t)!
            return getComputedStyle(li).backgroundColor
          }
          // The tokens resolved by the browser in the active scheme, via probe elements.
          const token = (name: string) => {
            const p = document.createElement("div")
            p.style.background = `var(${name})`
            document.body.appendChild(p)
            const c = getComputedStyle(p).backgroundColor
            p.remove()
            return c
          }
          return {
            todo: [rowBg("idle"), token("--status-todo")],
            in_progress: [rowBg("working"), token("--status-in-progress")],
            done: [rowBg("finished"), token("--status-done")],
          }
        })
        for (const k of ["todo", "in_progress", "done"] as const) expect(bg[k][0]).toBe(bg[k][1]) // row uses the token
        const [todo, prog, done] = [parseRgb(bg.todo[0]), parseRgb(bg.in_progress[0]), parseRgb(bg.done[0])]
        expect(new Set([bg.todo[0], bg.in_progress[0], bg.done[0]]).size).toBe(3)
        expect(hue(todo)).toBe("grey")
        expect(hue(prog)).toBe("blue")
        expect(hue(done)).toBe("green")
        seen[scheme] = [todo, prog, done]
      }
      expect(seen.light).not.toEqual(seen.dark) // the dark theme really changed the palette
    })
  })

  test("pressing the active status button again returns the row to todo", async () => {
    await withApp(async (e) => {
      await seed(e, ["x"])
      await open(e)
      await row(e, "x").locator(".row-toggle").click()
      await row(e, "x").locator(".act.play").click()
      await e.page.locator('li.row[data-status="in_progress"]').waitFor({ timeout: 3000 })
      await row(e, "x").locator(".act.play").click()
      await e.page.locator('li.row[data-status="todo"]').waitFor({ timeout: 3000 })
      expect(e.todos().items[0]!.status).toBe("todo")
    })
  })
})

// ---------------------------------------------------------------- E5

describe("E5 delete", () => {
  test("the trash icon on an expanded row removes it from the page and from disk", async () => {
    await withApp(async (e) => {
      await seed(e, ["keep 1", "drop me", "keep 2"])
      await open(e)
      await row(e, "drop me").locator(".row-toggle").click()
      await row(e, "drop me").locator(".act.trash").click()
      await row(e, "drop me").waitFor({ state: "detached", timeout: 3000 })
      await expect(e.rows()).resolves.toEqual(["keep 1", "keep 2"])
      expect(e.titles()).toEqual(["keep 1", "keep 2"])
      await e.page.reload()
      await e.page.waitForSelector("li.row")
      await expect(e.rows()).resolves.toEqual(["keep 1", "keep 2"])
    })
  })
})

// ---------------------------------------------------------------- E6

describe("E6 corrupt file", () => {
  test("a corrupted todos.json shows the banner; Reset restores the last good state from .bak and quarantines the bytes", async () => {
    await withApp(async (e) => {
      await seed(e, ["first", "second"])
      await open(e)
      await expect(e.rows()).resolves.toEqual(["first", "second"])
      const bakDoc = JSON.parse(readFileSync(join(e.home, "todos.json.bak"), "utf8")) as { items: unknown[] }
      writeFileSync(join(e.home, "todos.json"), "{ truncated")
      await e.page.locator('.banner[data-kind="corrupt"]').waitFor({ timeout: 3000 })
      await e.page.click(".banner .reset")
      await e.page.locator(".banner").waitFor({ state: "detached", timeout: 3000 })
      expect(readdirSync(e.home).some((f) => f.startsWith("todos.corrupt-"))).toBe(true)
      expect(e.todos().items).toHaveLength(bakDoc.items.length)
      await expect(e.rows()).resolves.toHaveLength(bakDoc.items.length)
    })
  })

  test("with no .bak, Reset starts an empty list and the page keeps working", async () => {
    await withApp(async (e) => {
      await seed(e, ["lonely"])
      rmSync(join(e.home, "todos.json.bak"), { force: true })
      await open(e)
      writeFileSync(join(e.home, "todos.json"), "not json at all")
      await e.page.locator('.banner[data-kind="corrupt"]').waitFor({ timeout: 3000 })
      await e.page.click(".banner .reset")
      await e.page.locator(".banner").waitFor({ state: "detached", timeout: 3000 })
      await e.page.locator(".empty").waitFor({ timeout: 3000 })
      expect(readdirSync(e.home).some((f) => f.startsWith("todos.corrupt-"))).toBe(true)
      await e.page.click(".add")
      await e.page.locator(".f-title").click()
      await e.page.keyboard.type("after reset")
      await e.page.keyboard.press("Enter")
      await row(e, "after reset").waitFor({ timeout: 3000 })
      expect(e.titles()).toEqual(["after reset"])
    })
  })

  test("a file from a newer schema shows the read-only banner and refuses edits", async () => {
    await withApp(async (e) => {
      writeFileSync(join(e.home, "todos.json"), JSON.stringify({ schemaVersion: 99, rev: 3, items: [] }))
      await open(e)
      await e.page.locator('.banner[data-kind="unsupported_version"]').waitFor({ timeout: 3000 })
      await expect(e.page.locator(".add").isDisabled()).resolves.toBe(true)
    })
  })
})

// ---------------------------------------------------------------- E7 (for human review; not pixel-asserted)

describe("E7 screenshots of the five mockup stages", () => {
  test("writes app/e2e/out/{1..5}-*.png", async () => {
    mkdirSync(OUT, { recursive: true })
    for (const f of readdirSync(OUT)) if (/^[1-5]-.*\.png$/.test(f)) rmSync(join(OUT, f))
    await withApp(
      async (e) => {
        const shot = async (name: string) => {
          await e.page.waitForTimeout(150) // let transitions settle
          await e.page.screenshot({ path: join(OUT, name) })
        }
        // 1. no tasks added
        await open(e)
        await e.page.locator(".empty").waitFor()
        await shot("1-no-tasks.png")

        // 2. click + : the title/body form
        await e.page.click(".add")
        await e.page.locator(".f-title").waitFor()
        await shot("2-add-form.png")
        await e.page.keyboard.press("Escape") // close it again

        // 3. six todos, the sixth expanded with its body
        await seed(e, SIX, (t) => (t === SIX[5] ? "some more information on the task i need to do some task i need to do. ".repeat(6) : ""))
        await row(e, SIX[5]!).waitFor({ timeout: 3000 })
        await row(e, SIX[5]!).locator(".row-toggle").click()
        await row(e, SIX[5]!).locator(".act.check").waitFor()
        await shot("3-expanded.png")
        await row(e, SIX[5]!).locator(".row-toggle").click() // collapse so the drag needs no scrolling

        // 4. mid-drag: task 5 held between 2 and 3
        await dragTo(e.page, SIX[4]!, 2, { release: false })
        await e.page.locator(".ghost").waitFor()
        await shot("4-dragging.png")
        await e.page.mouse.up()
        await pollEqual(() => e.titles().slice(0, 3), [SIX[0]!, SIX[1]!, SIX[4]!], 3000)

        // 5. statuses: 2 and 3 done, 5 and 6 in progress, 1 and 4 not started
        const idOf = (t: string) => e.todos().items.find((i) => i.title === t)!.id
        await e.cli({ op: "set_status", id: idOf(SIX[1]!), status: "done" })
        await e.cli({ op: "set_status", id: idOf(SIX[2]!), status: "done" })
        await e.cli({ op: "set_status", id: idOf(SIX[4]!), status: "in_progress" })
        await e.cli({ op: "set_status", id: idOf(SIX[5]!), status: "in_progress" })
        await e.page.locator('li.row[data-status="done"]').nth(1).waitFor({ timeout: 3000 })
        await e.page.locator('li.row[data-status="in_progress"]').nth(1).waitFor({ timeout: 3000 })
        await shot("5-status-colours.png")
        await expect(e.rows()).resolves.toEqual([SIX[0]!, SIX[1]!, SIX[4]!, SIX[2]!, SIX[3]!, SIX[5]!])
      },
      { viewport: { width: 360, height: 560 }, scale: 2 },
    )
    const written = readdirSync(OUT).filter((f) => /^[1-5]-.*\.png$/.test(f)).sort()
    expect(written).toEqual(["1-no-tasks.png", "2-add-form.png", "3-expanded.png", "4-dragging.png", "5-status-colours.png"])
    for (const f of written) expect(Bun.file(join(OUT, f)).size).toBeGreaterThan(2000)
  })
})

// ---------------------------------------------------------------- E8 save anywhere, save button, edit

const idOf = (e: Env, t: string) => e.todos().items.find((i) => i.title === t)!.id
/** A press on the header title: outside every form, and nothing under it moves when a form closes. */
const clickOutside = (e: Env) => e.page.locator(".head .title").click()
const noWrite = (e: Env) => expect(existsSync(join(e.home, "todos.json"))).toBe(false)
/** What the OS delivers when the user switches to another app: field blur + focusout, window blur, page hidden. No clicks. */
const deactivate = (e: Env) =>
  e.page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null
    a?.dispatchEvent(new FocusEvent("blur"))
    a?.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }))
    window.dispatchEvent(new Event("blur"))
    document.dispatchEvent(new Event("visibilitychange"))
  })

describe("E8 add and edit forms save without the keyboard", () => {
  test("add: title and body, then a click outside the form writes the todo and closes the form", async () => {
    await withApp(async (e) => {
      await open(e)
      await e.page.click(".add")
      await e.page.locator(".f-title").fill("Saved by click outside")
      await e.page.locator(".f-body").fill("body typed, no keyboard shortcut")
      await clickOutside(e)
      await row(e, "Saved by click outside").waitFor({ timeout: 3000 })
      await e.page.locator(".new-form").waitFor({ state: "detached" })
      expect(e.todos().items).toHaveLength(1)
      expect(e.todos().items[0]).toMatchObject({ title: "Saved by click outside", body: "body typed, no keyboard shortcut", status: "todo" })
    })
  })

  test("add: an empty form closes silently on a click outside; a body without a title stays open and is flagged", async () => {
    await withApp(async (e) => {
      await open(e)
      await e.page.click(".add")
      await clickOutside(e)
      await e.page.locator(".new-form").waitFor({ state: "detached" })
      noWrite(e)
      await e.page.click(".add")
      await e.page.locator(".f-body").fill("orphan body")
      await clickOutside(e)
      await expect(e.page.locator(".f-title").getAttribute("aria-invalid")).resolves.toBe("true")
      await expect(e.page.locator(".f-hint").textContent()).resolves.toBe("Title needed")
      await expect(e.page.locator(".f-hint").isVisible()).resolves.toBe(true)
      await expect(e.page.locator(".f-body").inputValue()).resolves.toBe("orphan body")
      noWrite(e)
    })
  })

  test("add: the visible check button saves; the x cancels; both are reachable by Tab after the body", async () => {
    await withApp(async (e) => {
      await open(e)
      await e.page.click(".add")
      await e.page.locator(".f-title").fill("Saved by the button")
      await e.page.keyboard.press("Tab")
      await expect(e.page.evaluate(() => document.activeElement?.className)).resolves.toBe("f-body")
      await e.page.keyboard.press("Tab")
      await expect(e.page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).resolves.toBe("Save")
      await e.page.keyboard.press("Tab")
      await expect(e.page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).resolves.toBe("Cancel")
      await e.page.locator(".new-form .save").click()
      await row(e, "Saved by the button").waitFor({ timeout: 3000 })
      expect(e.titles()).toEqual(["Saved by the button"])

      await e.page.click(".add")
      await e.page.locator(".f-title").fill("Cancelled")
      await e.page.locator(".new-form .cancel").click()
      await e.page.locator(".new-form").waitFor({ state: "detached" })
      expect(e.titles()).toEqual(["Saved by the button"])
    })
  })

  test("add: the window losing focus saves nothing and keeps the draft (blur, focusout, visibilitychange, no clicks)", async () => {
    await withApp(async (e) => {
      await open(e)
      await e.page.click(".add")
      await e.page.locator(".f-title").fill("draft title")
      await e.page.locator(".f-body").fill("draft body")
      await deactivate(e)
      await e.page.waitForTimeout(400)
      await expect(e.page.locator(".new-form").count()).resolves.toBe(1)
      await expect(e.page.locator(".f-title").inputValue()).resolves.toBe("draft title")
      await expect(e.page.locator(".f-body").inputValue()).resolves.toBe("draft body")
      noWrite(e)
    })
  })

  test("+ while the form is open focuses it instead of saving or opening a second one", async () => {
    await withApp(async (e) => {
      await open(e)
      await e.page.click(".add")
      await e.page.locator(".f-title").fill("still typing")
      await e.page.locator(".f-body").click()
      await e.page.click(".add")
      await expect(e.page.locator(".new-form").count()).resolves.toBe(1)
      await expect(e.page.evaluate(() => document.activeElement?.className)).resolves.toBe("f-title")
      await expect(e.page.locator(".f-title").inputValue()).resolves.toBe("still typing")
      noWrite(e)
    })
  })

  test("edit: the pencil, new title and body, then a click outside writes only that item", async () => {
    await withApp(async (e) => {
      await seed(e, ["keep me", "edit me", "leave me"], (t) => `body of ${t}`)
      await open(e)
      const before = e.todos()
      await row(e, "edit me").locator(".row-toggle").click()
      await row(e, "edit me").locator(".act.edit").click()
      await expect(e.page.locator("li.row.editing .f-title").inputValue()).resolves.toBe("edit me")
      await expect(e.page.locator("li.row.editing .f-body").inputValue()).resolves.toBe("body of edit me")
      await expect(e.page.evaluate(() => document.activeElement?.className)).resolves.toBe("f-title")
      await e.page.locator(".f-title").fill("edited title")
      await e.page.locator(".f-body").fill("edited body\nsecond line")
      await clickOutside(e)
      await e.page.locator(".new-form").waitFor({ state: "detached" })
      await pollEqual(() => e.titles(), ["keep me", "edited title", "leave me"], 3000)
      const after = e.todos()
      expect(after.rev).toBe(before.rev + 1)
      const it = after.items.find((i) => i.id === idOf(e, "edited title"))!
      expect(it).toMatchObject({ title: "edited title", body: "edited body\nsecond line", status: "todo" })
      expect(after.items.map((i) => i.body)).toEqual(["body of keep me", "edited body\nsecond line", "body of leave me"])
      await expect(e.rows()).resolves.toEqual(["keep me", "edited title", "leave me"])
    })
  })

  test("edit: changing only the body sends only the body; an unchanged editor writes nothing", async () => {
    await withApp(async (e) => {
      await seed(e, ["solo"], () => "old body")
      await open(e)
      const rev = e.todos().rev
      await row(e, "solo").locator(".row-toggle").click()
      await row(e, "solo").locator(".act.edit").click()
      await clickOutside(e)
      await e.page.locator(".new-form").waitFor({ state: "detached" })
      expect(e.todos().rev).toBe(rev)
      await row(e, "solo").locator(".act.edit").click()
      await e.page.locator(".f-body").fill("new body")
      await e.page.locator(".new-form .save").click()
      await pollEqual(() => e.todos().items[0]!.body, "new body", 3000)
      expect(e.todos().items[0]!.title).toBe("solo")
      expect(e.todos().rev).toBe(rev + 1)
    })
  })

  test("edit: Escape cancels without writing; the row keeps its text", async () => {
    await withApp(async (e) => {
      await seed(e, ["original"], () => "original body")
      await open(e)
      const before = readFileSync(join(e.home, "todos.json"), "utf8")
      await row(e, "original").locator(".row-toggle").click()
      await row(e, "original").locator(".act.edit").click()
      await e.page.locator(".f-title").fill("typed but cancelled")
      await e.page.locator(".f-body").fill("also cancelled")
      await e.page.keyboard.press("Escape")
      await e.page.locator(".new-form").waitFor({ state: "detached" })
      await e.page.waitForTimeout(300)
      expect(readFileSync(join(e.home, "todos.json"), "utf8")).toBe(before)
      await expect(e.rows()).resolves.toEqual(["original"])
      await expect(row(e, "original").locator(".row-body").textContent()).resolves.toBe("original body")
    })
  })

  test("edit: the window losing focus does not save the edit", async () => {
    await withApp(async (e) => {
      await seed(e, ["original"])
      await open(e)
      const before = readFileSync(join(e.home, "todos.json"), "utf8")
      await row(e, "original").locator(".row-toggle").click()
      await row(e, "original").locator(".act.edit").click()
      await e.page.locator(".f-title").fill("half edited")
      await deactivate(e)
      await e.page.waitForTimeout(400)
      await expect(e.page.locator("li.row.editing").count()).resolves.toBe(1)
      await expect(e.page.locator(".f-title").inputValue()).resolves.toBe("half edited")
      expect(readFileSync(join(e.home, "todos.json"), "utf8")).toBe(before)
    })
  })

  test("only one form: pressing another row saves the open edit; the second row's pencil then opens the second form", async () => {
    await withApp(async (e) => {
      await seed(e, ["first", "second"])
      await open(e)
      await row(e, "first").locator(".row-toggle").click()
      await row(e, "first").locator(".act.edit").click()
      await e.page.locator(".f-title").fill("first (edited)")
      await row(e, "second").locator(".row-toggle").click() // the press saves; the click may land on a row that just moved
      await pollEqual(() => e.titles(), ["first (edited)", "second"], 3000)
      await e.page.locator(".new-form").waitFor({ state: "detached" })
      if (!((await row(e, "second").getAttribute("class")) ?? "").includes("expanded")) await row(e, "second").locator(".row-toggle").click()
      await row(e, "second").locator(".act.edit").click()
      await expect(e.page.locator("li.row.editing .f-title").inputValue()).resolves.toBe("second")
      await expect(e.page.locator(".new-form").count()).resolves.toBe(1)
    })
  })

  test("edit: an agent reordering rows past the edited row keeps the form, the typed text, the caret and the focus", async () => {
    await withApp(async (e) => {
      await seed(e, ["r1", "r2", "r3", "r4"])
      await open(e)
      await row(e, "r2").locator(".row-toggle").click()
      await row(e, "r2").locator(".act.edit").click()
      await e.page.locator(".f-title").fill("typed text")
      await e.page.locator(".f-title").evaluate((el) => (el as HTMLInputElement).setSelectionRange(2, 5))
      await e.cli({ op: "move", id: idOf(e, "r4"), after: null }) // r4 jumps above the row being edited
      await e.cli({ op: "move", id: idOf(e, "r1"), after: idOf(e, "r2") }) // and r1 jumps below it
      await pollEqual(() => e.rows(), ["r4", "r2", "r1", "r3"], 3000)
      await expect(e.page.locator(".new-form").count()).resolves.toBe(1)
      await expect(e.page.evaluate(() => document.activeElement?.className)).resolves.toBe("f-title")
      await expect(e.page.locator(".f-title").inputValue()).resolves.toBe("typed text")
      await expect(e.page.locator(".f-title").evaluate((el) => [(el as HTMLInputElement).selectionStart, (el as HTMLInputElement).selectionEnd])).resolves.toEqual([2, 5])
    })
  })

  test("edit: an agent changing the same item keeps the typed text; the user's save wins and the agent's other field survives", async () => {
    await withApp(async (e) => {
      await seed(e, ["shared"], () => "orig body")
      await open(e)
      await row(e, "shared").locator(".row-toggle").click()
      await row(e, "shared").locator(".act.edit").click()
      await e.page.locator(".f-title").fill("user title")
      await e.cli({ op: "update", id: idOf(e, "shared"), title: "agent title", body: "agent body" })
      await e.page.waitForTimeout(1300) // let the watcher publish the agent's write to the open page
      await expect(e.page.locator(".f-title").inputValue()).resolves.toBe("user title")
      await clickOutside(e)
      await pollEqual(() => e.titles(), ["user title"], 3000)
      expect(e.todos().items[0]!.body).toBe("agent body")
    })
  })

  test("edit: the item deleted by an agent while being edited closes the editor with a notice", async () => {
    await withApp(async (e) => {
      await seed(e, ["doomed", "survivor"])
      await open(e)
      await row(e, "doomed").locator(".row-toggle").click()
      await row(e, "doomed").locator(".act.edit").click()
      await e.page.locator(".f-title").fill("typing into the void")
      await e.cli({ op: "delete", id: idOf(e, "doomed") })
      await e.page.locator(".new-form").waitFor({ state: "detached", timeout: 3000 })
      await expect(e.page.locator(".toast").textContent()).resolves.toContain("deleted")
      await expect(e.rows()).resolves.toEqual(["survivor"])
    })
  })

  test("a press inside the edit form does not start a drag", async () => {
    await withApp(async (e) => {
      await seed(e, FIVE)
      await open(e)
      await row(e, "T3").locator(".row-toggle").click()
      await row(e, "T3").locator(".act.edit").click()
      const box = (await e.page.locator("li.row.editing .f-body").boundingBox())!
      await e.page.mouse.move(box.x + 20, box.y + 10)
      await e.page.mouse.down()
      for (let i = 1; i <= 10; i++) await e.page.mouse.move(box.x + 20, box.y + 10 - i * 15)
      await expect(e.page.locator(".ghost").count()).resolves.toBe(0)
      await e.page.mouse.up()
      await expect(e.page.locator("li.row.editing").count()).resolves.toBe(1)
      expect(e.titles()).toEqual(FIVE)
    })
  })
})

describe("E9 screenshots of the add and edit forms", () => {
  test("writes app/e2e/out/{6-add-form,7-edit-form}.png", async () => {
    mkdirSync(OUT, { recursive: true })
    await withApp(
      async (e) => {
        await seed(e, SIX, (t) => (t === SIX[2] ? "some more information on the task i need to do." : ""))
        await open(e)
        await e.page.click(".add")
        await e.page.locator(".f-title").fill("Write the release notes")
        await e.page.locator(".f-body").fill("Mention the new save and edit controls.")
        await e.page.waitForTimeout(150)
        await e.page.screenshot({ path: join(OUT, "6-add-form.png") })
        await e.page.keyboard.press("Escape")
        await e.page.locator(".new-form").waitFor({ state: "detached" })
        await row(e, SIX[2]!).locator(".row-toggle").click()
        await row(e, SIX[2]!).locator(".act.edit").click()
        await e.page.locator(".f-title").fill("some task i need to do 3 (reworded)")
        await e.page.waitForTimeout(150)
        await e.page.screenshot({ path: join(OUT, "7-edit-form.png") })
      },
      { viewport: { width: 320, height: 480 }, scale: 2 },
    )
    for (const f of ["6-add-form.png", "7-edit-form.png"]) expect(Bun.file(join(OUT, f)).size).toBeGreaterThan(2000)
  })
})

describe("harness cleanup", () => {
  // Must stay the last test: it closes the shared browser.
  test("withApp reaps the shim it spawned when the browser is already gone", async () => {
    const count = () => Bun.spawnSync(["pgrep", "-f", "store-node/shim.ts"]).stdout.toString().split("\n").filter(Boolean).length
    const before = count()
    await browser.close()
    await expect(withApp(async () => {})).rejects.toBeDefined()
    await Bun.sleep(1500)
    expect(count()).toBe(before)
  })
})
