# TTD beta - morning report (2026-11-06)

The beta works on this Mac. The TTD window is open (always on top) with one welcome todo. In Claude Code, the agent can read and edit the same list. Everything is on branch `feat/beta` in `~/dev/ttd`. It is committed locally and not pushed: only `main`, which holds the design inputs, is on GitHub.

## Try it (2 minutes)

1. **The window.** It is already open. If not, run `open ~/dev/ttd/target/release/bundle/macos/TTD.app`. The app is unsigned, so if macOS blocks it, right-click it and choose Open.
   - `+` adds a todo (Enter saves, Esc cancels).
   - Click a row to expand it: trash deletes, play marks it in progress (blue), check marks it done (green).
   - Drag rows to reorder.
2. **The agent.**
   - Start Claude Code with the plugin: `claude --plugin-dir ~/dev/ttd/plugin`.
   - `/ttd` opens or focuses the window.
   - `/ttd list`, `/ttd add <title>`, `/ttd start|done|todo|rm <id>` manage todos from the prompt.
   - Or just ask "add a todo to review PR 12". The agent has six tools, `mcp__ttd__{list,add,update,set_status,reorder,delete}`.
   - When you change the list in the window, the agent sees the updated list on your next message (only when it changed).
3. **Install the way a coworker would.** In Claude Code, run `/plugin install ttd --marketplace kristianDKAndersen/ttd`. This works only after `feat/beta` is merged to `main` and pushed. The repo is private, so coworkers need collaborator access.

Data lives in `~/.ttd/todos.json`, with `todos.json.bak` as a copy of the latest good version.

## What was verified (final commit `4431e54`, every step exit 0)

| Area | Result |
|---|---|
| TS store core + CLI + watcher | 152 pass, incl. 15 contract fixtures, 4x25 concurrent processes, stale-lock race tests, strict UTF-8 |
| Rust store crate | 121 pass across 6 suites, clippy clean |
| Window UI (happy-dom) | 97 pass |
| UI in real Chrome against the dev shim | 14 pass (add, live external update, real mouse drag, colours light/dark, delete, corrupt recovery) |
| Tauri window smoke | 7/7 at `00b1916`: always-on-top, 320x480, external change rendered in about 0.4 s, position remembered, single instance, breadcrumb. Not re-run at `4431e54` because your TTD window was open; the window's Rust code did not change after that run. |
| Claude Code plugin | `claude plugin validate` OK (plugin + marketplace), 55 unit tests, 11 real `claude -p` end-to-end tests |
| Cross-process integration | 7 pass. One run had 582 writes from TS, Rust and plugin writers at once with nothing lost; also `kill -9` crash recovery and corrupt-file recovery across all three |
| Agent in the loop | At `00b1916`, Haiku with the plugin loaded called `add`, then `set_status`, on its own, and the file showed the todo as in progress |

The release app was rebuilt from `4431e54` and relaunched. I couldn't screenshot the window because the screensaver was on, so its look is unchecked; the process is running and found your `~/.ttd`.

The last check run needed `caffeinate -i`. Without it, the Mac idle-slept in the middle of tests: one test logged 15 minutes against a 45-second limit. Those failures were stalls, not real failures. If you see similar timeouts locally, run `caffeinate -i bun run verify`.

## Code reviews

Three independent reviews ran over the branch (full branch, fix round 1, fix round 2). Together they found 0 Blockers, 3 Majors and about 17 Minors, and no security issues. Security covered XSS, shell injection (11 hostile `TTD_HOME` names were tried), the window's CSP and capabilities, the dev shim, and breaking out of the agent context block.

All 3 Majors are fixed:
- Recovery rolled back your last change.
- A failed `.bak` write went unreported.
- A file with non-UTF-8 bytes could be silently rewritten, damaging the backup too.

The remaining Minors are listed below.

## Decisions I made while you slept (please check)

1. **Plugin, not an MCP server.** The agent integration is a Claude Code plugin with its own tools. That keeps it to a single install with no separate server. A plain MCP server for Claude Desktop chat is listed as a next step.
2. **The two implementations are kept in step by a written contract.** The window's store is in Rust and the plugin's store is in TypeScript. Both follow `docs/contract/STORE.md` and are tested against the same fixture files.
3. **Contract change: `.bak` = copy of the latest successful write.** It used to be the version before the last write. The code review found that recovering a damaged file then silently dropped your most recent change. Now nothing TTD wrote is lost on recovery. The damaged file is always kept as `todos.corrupt-*.json`, and the window and the agent both tell you when a restore happened. The trade-off is that `.bak` is no longer a one-step undo.
4. **Not supported yet:** plugin writes from the desktop app or SDK sessions. Writing needs the CLI's process API. Reads work everywhere.

## Bugs found and fixed tonight

- A race where two writers both break a crashed writer's lock could lose an update. Both TS and Rust had it. It was reproduced first, then fixed with a break guard.
- Rust spun forever on a lock it could not remove. It now times out properly.
- Recovery from a damaged file rolled back the last change (decision 3 above).
- The plugin's rename could nest a directory. `/ttd` could launch a dev build that showed a blank window.
- A `.bak` rename failure after a commit was swallowed. It is now retried once, then reported as `backup_stale`. A restore from a backup older than the damaged file also reports `backup_stale`, and the window and the agent both say so.
- The plugin read files lossily: invalid UTF-8 became U+FFFD and was written back, into the backup too. It now reads bytes and decodes strictly, so a damaged file is quarantined, not rewritten.

## Not verified / open

- **Windows and Linux.** They are covered by unit tests with stand-in hosts only. The GitHub release and CI workflows have never run; they are only YAML-checked.
- **Signing.** Builds are unsigned (Gatekeeper and SmartScreen warnings). The `.dmg` was built with `CI=true`, which skips Finder styling because Finder automation permission is missing.
- **Minor follow-ups from the review:**
  - Rust spins with no backoff if `store.lock` is a dangling symlink.
  - TS and Rust disagree on an owner `ts` written as `1e3`.
  - A crash during a write can leave a `.todos.json.tmp-*` file behind. No reader is affected, and nothing cleans these files up.
  - The TS writers don't `fsync`, so a power cut can lose the very latest write.
  - There is no undo when the agent deletes something by mistake: `.bak` is now the latest version, not the previous one.
  - On Windows, the plugin's rename doesn't refuse a directory destination the way the macOS and Linux version does.
  - The restore notice is one-sided: it shows only on the write that recovered, not on later reads.
- **No LICENSE yet.** That is your call.

## Things only you can do

1. **Trust `~/dev/ttd` in Claude Code.** Open Claude Code there once and accept the trust prompt. Then advisor workers can run in this repo. Tonight they could not: summon's worker sat on the trust dialog for 25 minutes. That is why the build used in-session subagents.
2. **Advisor fix to decide on.** `bin/summon` should also pre-trust the main repo for worktree agents. Otherwise every new repo stalls the same way.
3. **Review and merge.** Review `feat/beta` and open the PR. To push the branch, run `! cd ~/dev/ttd && git push -u origin feat/beta`.
4. **Pick a license, and private or public.** If the repo goes public, coworkers can install without collaborator access.
