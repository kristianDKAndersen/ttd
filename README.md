# TTD - Tiny Todo

TTD is a tiny todo list that lives in a floating, always-on-top window next to Claude Code, and that the
agent can read and update too. You and the agent share one local file (`~/.ttd/todos.json`), so a todo you
add in the window is visible to Claude and the other way round. Writes are atomic and conflict-safe, because
losing an item is the one thing this tool exists to prevent. Click a todo to expand it (body, trash, play =
in progress, check = done), drag to reorder; grey = not started, blue = in progress, green = done.

![TTD mockup](docs/mockup.png)

Status: beta, v0.1.0. The pieces are a Claude Code plugin (the "mod"), a Tauri v2 window, and a shared
store implemented in TypeScript and Rust. Design and decisions: `docs/DECISIONS.md`, `docs/plan/plan.md`.
Anything marked "unverified" below has not been exercised yet.

## 1. Install the plugin

In a Claude Code session:

```
/plugin install ttd --marketplace kristianDKAndersen/ttd
```

Or from a shell:

```
claude plugin install ttd --marketplace kristianDKAndersen/ttd
```

The repository is **private**, so the install needs git credentials that can read it: collaborator access
first, then for example `gh auth login && gh auth setup-git`. The plugin is the `plugin/` folder of this
repo; nothing else ships with it.

Claude desktop-app and SDK sessions: the plugin can read the list there but is **read-only** (see Limits).
Use the Claude Code CLI to let the agent write.

Unverified: the install line has not been run end to end against GitHub (marketplace file
`.claude-plugin/marketplace.json`, plugin source `./plugin`).

## 2. Get the window

The agent tools work without the window; the window is the visual half.

**Download a build.** Needs collaborator access to the private repo. Releases are created as drafts and a
maintainer publishes them.

```
gh auth login
gh release list -R kristianDKAndersen/ttd
gh release download <tag> -R kristianDKAndersen/ttd          # all assets, or add --pattern '*.dmg'
```

Or open https://github.com/kristianDKAndersen/ttd/releases/latest in a browser while signed in. The
release workflow builds a macOS universal app, a Windows build and a Linux build. Exact asset names depend on
the Tauri bundle targets (unverified: the workflow has never run).

**Build from source.** Needs [bun](https://bun.sh) and a Rust toolchain; on Linux also
`libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf xdg-utils`.

```
bun install
bun run build:ui
bun run tauri build
```

### Unsigned binaries: first launch

The builds are not code-signed or notarised, so each OS warns once.

- **macOS** (Gatekeeper): move the app to `/Applications`, then
  `xattr -dr com.apple.quarantine /Applications/TTD.app`, or right-click the app and choose Open.
- **Windows** (SmartScreen): "More info" then "Run anyway".
- **Linux** (AppImage): `chmod +x TTD*.AppImage`, then run it. A `.deb` puts `ttd` on the PATH.

Run the window once: it records its own path in `~/.ttd/app.json`, which is how `/ttd` finds it later.

## 3. Use it

- `/ttd` in Claude Code launches the window; a second launch focuses the existing one. If no window is
  installed it prints the install steps and the release link. `TTD_NO_LAUNCH=1` skips launching, and
  `TTD_BIN=<path>` points at a specific binary.
- Sub-commands (planned, check `plugin/README.md` for the final list): `/ttd list`, `add <title>`,
  `start|todo|done|rm <id>`, `recover`, `path`.
- The agent gets six tools: `mcp__ttd__list`, `add`, `update`, `set_status`, `reorder`, `delete`. Items are
  addressed by `id`. Claude sees your window edits at its next prompt (a short `<ttd-todos>` block is attached
  only when the list changed since it last looked) or in the result of its next ttd tool call.
- Data lives in `~/.ttd/todos.json` (plus `todos.json.bak` and a lock directory). Set `TTD_HOME` to use another
  directory. If the file is corrupt, writes are refused until it is recovered from `todos.json.bak`; corrupt
  files are quarantined, not overwritten.

## Limits

- **Writes need the Claude Code CLI.** The mod writes through `$.process`, documented as CLI-only. Desktop-app
  and SDK sessions can read the list, but writes return a clear `io_error`.
- A window edit made mid-turn reaches the model at its next prompt or next ttd tool result, not sooner.
- Windows and Linux are unverified end to end (Windows store IO, NSIS install path, AppImage path,
  undecorated-window resize edges, multi-monitor position memory). The release workflow has never run.
- The model choosing `mcp__ttd__*` tools on its own is not covered by automated tests; engine-level tests and
  real-file `/ttd op` tests cover the same handlers. Manual check: run `claude --plugin-dir plugin`, ask
  "add a todo to fix login", watch the window update.
- Deleting a todo in the window is immediate (no undo); `.bak` holds only the previous state.
- Binaries are unsigned (above). The mod API is early access and the plugin was validated against Claude Code
  build 2.1.318 only.
- There is no MCP server yet, so Claude Desktop chat users cannot use TTD in the beta.

### If the repository goes public

Anyone could `/plugin install` and download releases without being a collaborator, runner minutes become free,
an arm Linux runner can join the release matrix, and an updater (`uploadUpdaterJson` in the release action)
becomes practical. While private, collaborator access is required for both the plugin and the downloads.

## Development

```
bun install
bun run shim        # store-backed dev server on 127.0.0.1; TTD_HOME selects the file (default ~/.ttd)
bun run dev:ui      # Vite UI, /api proxied to the shim
bun run verify      # typecheck, TS tests, UI build, browser e2e, Rust tests, plugin tests, app smoke, integration
```

`bun run verify` needs Chrome (browser e2e), Rust, the `claude` CLI and a GUI session (app smoke). Smaller
pieces: `bun run test:store`, `bun run test:ui`, `bun run test:rust`, `bun run typecheck`.
`bun run tauri dev` runs the window against the Vite dev server.

CI (`.github/workflows/ci.yml`) runs typecheck, the bun tests and `cargo test -p ttd-store` on Ubuntu.
Releases: push a tag `v*` or run the `release` workflow manually; it creates a draft release with the bundles.

## Next steps

- A plain stdio MCP server, `ttd-store mcp` in the Rust crate (left out of the beta, plan D2).
- Code signing and notarisation (Apple Developer account, Windows signing certificate).
- An updater, which is only practical once the repo is public.
- An undo toast for deletes.
