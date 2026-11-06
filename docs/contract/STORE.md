# TTD store contract (v1)

Normative for every implementation: the TS core (`plugin/hooks/store/`, shared by the Claude Code
mod and the dev shim), the Rust crate (`crates/ttd-store`, used by the window and the CLI). All are
tested against `docs/contract/fixtures/*.json`. Words MUST / SHOULD are used in the RFC sense.

Why this is hard: the file has several independent writers at once (the window, plus one mod
instance per running Claude Code session, plus CLIs), none can be made the owner, and losing a todo is
the failure this product exists to remove. Two facts from the Claude Code mod API (verified against
`types/claude-code.d.ts` of build 2.1.318) shape the protocol: `$.fs` has no rename, remove,
exclusive-create or watch, so the mod does atomic replace and locking through `$.process.run`
(`mv`, `mkdir`, `rm`), and "read rev, then rename" alone has a check-then-act gap. Hence: a lock
for prevention, a rev check for detection, ops (not file overwrites) so a retry is safe.

## 1. Paths

`HOME_DIR` is resolved as: env `TTD_HOME` if set and non-empty; else `<USERPROFILE>/.ttd` if
`USERPROFILE` is set (Windows); else `<HOME>/.ttd`. No `~` expansion anywhere. All of these live in
`HOME_DIR`, in the same directory so rename never crosses a filesystem:

| Name | Purpose |
|---|---|
| `todos.json` | the store |
| `todos.json.bak` | byte-identical copy of the LATEST successfully committed `todos.json` (last known good; section 4) |
| `.todos.json.tmp-<token>` | per-writer temp files (one for the new `todos.json`, one for the new `.bak`); `<token>` = 12 random `[a-z0-9]`; removed on every failure path; stale ones (> 1 h old) MAY be swept by a writer holding the lock |
| `store.lock/` | lock directory (section 5); contains `owner.json` |
| `todos.corrupt-<yyyymmddThhmmssZ>-<token>.json` | quarantined unparseable file, kept forever, byte-identical to what was found |
| `app.json` | breadcrumb the window writes at start: `{"path": <abs exe path>, "version": "x.y.z", "writtenAt": <iso>}`; read by the mod's `/ttd` launcher; not part of the store protocol |

Window position/size is NOT stored here (Tauri window-state plugin keeps it in the app config dir).

## 2. File format

```json
{
  "schemaVersion": 1,
  "rev": 7,
  "items": [
    { "id": "t_lq2x9a1b4k", "title": "Write plan", "body": "", "status": "todo",
      "order": 0, "createdAt": "2026-01-01T09:00:00.000Z", "updatedAt": "2026-01-01T09:00:00.000Z" }
  ]
}
```

- UTF-8, no BOM, `JSON.stringify(doc, null, 2) + "\n"` style (2-space indent, trailing newline).
  Key order and whitespace are NOT significant to readers; fixtures compare parsed values (deep equal).
- `schemaVersion`: integer, currently `1`.
- `rev`: integer >= 0, monotonic. An absent file is the empty doc: `{schemaVersion:1, rev:0, items:[]}`.
  Every effective write increments `rev` by exactly 1. No-op ops do not write (file, mtime and rev unchanged).
- Item: `id` matches `^[A-Za-z0-9_-]{1,64}$`, unique in the file. `title` string, 1..200 code points
  after trim, no code point < U+0020. `body` string, 0..10000 code points (any characters). `status` is
  `todo | in_progress | done`. `order` integer. `createdAt`/`updatedAt` ISO-8601 UTC with milliseconds
  and `Z` (`2026-01-01T09:00:00.000Z`), supplied by the caller's clock.
- Stored strings (`title`, `body`, `id`, unknown fields) MUST be well-formed Unicode: no unpaired surrogates in
  UTF-16 (JS), valid UTF-8 (Rust). A lone surrogate is not representable in UTF-8: JS `JSON.stringify` writes it as
  a `\udXXX` escape, and the Rust reader turns it into U+FFFD, so the two implementations would read different
  values from one file. Behaviour for such input is undefined (callers must not pass it; the fixtures never do).
- Lengths are counted in Unicode code points (JS: `[...s].length`; Rust: `chars().count()`), never UTF-16
  units or bytes (fixture 04 checks this).
- `trim` removes only these characters from both ends: U+0009-U+000D, U+0020, U+00A0, U+2028, U+2029,
  U+FEFF. Do not use the language's built-in `trim` (JS and Rust differ).
- Unknown top-level and per-item fields MUST be preserved on read-modify-write (fixture 09).
- Normalisation: `items` are ordered by `(order, createdAt, id)` and `order` is renumbered `0..n-1`.
  Readers present the normalised view without writing it; the next effective write persists it.
- Hard limits: at most 1000 items; serialized file at most 1 MiB (the mod's `$.fs.read` rejects over
  4 MiB, L3366-3367 of the types file). Violations are `limit_exceeded` (item count / size after the op)
  or `too_long` (field length).

## 3. Operations (the only way to change the file)

An op is a JSON object. `apply(doc, op, now) -> { doc', changed, result } | error` is a pure function
(semantics below) that every implementation exposes for unit tests; the engine wraps it in the
protocol of sections 5-6. `now` and a generated `id` are chosen ONCE per op invocation, before the
retry loop, so a retry re-applies exactly the same op (idempotent: re-adding an existing `id` is a no-op).

| op | fields | semantics |
|---|---|---|
| `add` | `title`, `body?` (""), `status?` ("todo"), `id?` (generated `t_` + base36 ms + 6 random base36 if absent) | append at the bottom (`order = n`); if `id` already exists: `changed:false`, result is the existing item |
| `update` | `id`, `title?`, `body?` (at least one) | set provided fields; `changed` only if a value differs (title compared after trim); bumps `updatedAt` only when changed |
| `set_status` | `id`, `status` | same status: `changed:false`; else set + bump `updatedAt` |
| `move` | `id`, `after` (id or `null`) | relative reorder: item goes directly after `after`, or to the top when `null`. `after == id` is `invalid_op`; unknown `after` or `id` is `not_found`; same position: `changed:false`. Renumbers `order`; does NOT bump `updatedAt` |
| `delete` | `id` | remove and renumber; missing id: ok, `changed:false` (idempotent) |
| `reset_corrupt` | none | only valid while the file is corrupt (section 8): quarantine it and write a fresh empty doc. Not corrupt: `not_corrupt` |

Result payloads (`result`): `add/update/set_status/move` -> `{ "item": <post-state item incl. its new order> }`;
`delete` -> `{ "id": ... }`; `reset_corrupt` -> `{}`. Validation order: op shape and field types
(`invalid_op`), then field values (`invalid_title`, `too_long`), then lookups (`not_found`).
Missing or non-string `title` is `invalid_op`; empty-after-trim or control character is `invalid_title`.
Agents address items by `id` only (never by index) so a re-read between edits cannot retarget them.

Error codes (`error`): `invalid_op`, `invalid_title`, `too_long`, `limit_exceeded`, `not_found`,
`not_corrupt`, `corrupt` (read only), `corrupt_no_backup` (write), `unsupported_version`,
`lock_timeout`, `conflict_exhausted`, `io_error` (with `message`). Success/failure envelope:

```
{ "ok": true,  "changed": bool, "rev": n, "result": {...}, "warnings": [codes], "attempts": n, "doc": <post-state doc> }
{ "ok": false, "error": code, "message"?: string }
```

Warning codes: `corrupt_quarantined`, `restored_from_bak`, `stale_lock_broken`.

## 4. Atomic write

Under the lock: write the full new content to `.todos.json.tmp-<token>` (same directory), then
replace `todos.json` by rename. POSIX `rename(2)`; Windows `MoveFileExW(REPLACE_EXISTING)`. The mod
cannot call either, so its IO adapter runs `mv -f tmp dst` behind a directory-destination check (POSIX, section 12)
or `cmd /c move /Y tmp dst` (Windows) through `$.process.run` and treats a non-zero exit as failure. Rename failures on
EPERM/EACCES/EBUSY (Windows, another process has the file open) are retried 5 times, 20 ms apart,
before `io_error`. A reader can therefore never see a half-written `todos.json` from a conforming
writer; a non-conforming writer or a crash mid-write is handled by section 8.

**`.bak` rule.** The product promise is "never lose a todo", so `.bak` is not "the version before": it is a
byte-identical copy of the latest commit. Under the same lock, the writer writes the new content to TWO temp files
before anything visible changes (`.todos.json.tmp-<token>` for `todos.json`, a second token for `.bak`; a failure to
write either aborts the op with nothing committed), then after the CAS:

1. rename temp over `todos.json` (the commit point; acknowledged to the caller once the lock is released);
2. rename the second temp over `todos.json.bak` (atomic, never a direct write, so a kill cannot leave a truncated
   `.bak`).

Consequences, all deliberate:

- A crash between 1 and 2, or a failed rename in 2, leaves `.bak` ONE VERSION BEHIND `todos.json`. Nothing
  acknowledged is at risk: the crashed writer never acknowledged its write (its caller got no result), and a later
  successful commit catches `.bak` up. A failed step 2 does not fail the op (the commit stands); it is not reported
  as a warning either.
- Every commit writes `.bak`, including the first one, `reset_corrupt`, and a restore from `.bak` itself. A no-op
  that does not write leaves both files alone.
- Restoring from `.bak` after a clobbered `todos.json` therefore loses nothing a TTD writer acknowledged.
- A `.bak` from an older build (the version before the last commit) is replaced by the next commit.

## 5. Concurrency protocol (every write op, every implementation)

```
acquire lock                                   (lockTimeoutMs = 5000, lockStaleMs = 15000)
  attempt = 1..5:
     raw  = read todos.json ; doc = parse+validate      (absent => empty doc; corrupt => section 8)
     (doc', changed, result) = apply(doc, op, now)       (error => release, return error; no write)
     if !changed => release, return ok changed:false rev:doc.rev   (no write)
     doc'.rev = doc.rev + 1 ; write tmp and bak-tmp (same bytes)
     CAS: re-read todos.json, parse rev; if absent-vs-present or rev != doc.rev:
            remove tmp ; attempt++ ; continue          (re-read, RE-APPLY the same op)
     (corrupt: copy todos.json byte-identical to its quarantine name first, section 8)
     rename tmp -> todos.json                            (commit)
     rename bak-tmp -> todos.json.bak                    (bak = the commit just made; best effort, section 4)
     release, return ok changed:true rev:doc'.rev attempts:attempt
  attempts exhausted => release, return conflict_exhausted
```

Lock = the directory `HOME_DIR/store.lock`, created with an atomic exclusive `mkdir` (Rust
`create_dir`, Node `mkdirSync` without `recursive`, mod: `mkdir` through `$.process.run`, exit 0 =
acquired, non-zero = held). `HOME_DIR` MUST exist before the first `mkdir` of the lock (a missing parent
also makes `mkdir` fail, which would read as "held"): every writer first ensures `HOME_DIR`
(`create_dir_all`, Node `mkdirSync` recursive, mod `mkdir -p` once per process; its failure is ignored here and
surfaces as `io_error` if the directory really is missing).

- After acquiring, write `store.lock/owner.json`: `{"token": <12 chars>, "pid": n, "ts": <epoch ms>}`.
- Contended: sleep 10-40 ms (random jitter) and retry until `lockTimeoutMs`, then `lock_timeout`
  (nothing changed; the foreign lock is NOT removed).
- Stale: held lock whose `owner.json` `ts` is older than `lockStaleMs` is stale. `owner.json` counts only if it
  parses as an object with a string `token` and a non-negative integer `ts`; otherwise (missing, unparseable,
  other shape) the lock directory's mtime is used instead. A lock that vanished while being judged is "gone":
  retry `mkdir`. A `ts` in the future is not stale.
- Breaking a stale lock (every implementation, same directory names). Renaming alone is NOT enough: two waiters
  can judge the same stale `owner.json`, the first renames it away and a successor creates a FRESH lock, and
  the second then renames that fresh lock away too, so two writers hold the lock (a lost update).
  Breakers are therefore serialised through a second lock directory, and what was renamed is verified:

  ```
  judge store.lock                      stale (token T, or none if owner.json is unusable) / fresh / gone
  stale: mkdir HOME_DIR/store.lock.break        (exclusive, the break guard)
     exists => the guard is held: if the guard directory's mtime is older than lockStaleMs
               (a crashed breaker) remove it; either way do NOT break, back off and retry
     created => re-judge store.lock UNDER the guard; not stale any more => release guard, retry
                rename store.lock -> store.lock.stale-<token>   (fails => someone released it: release guard, retry)
                verify the renamed directory is the one judged:
                   judged token T:      its owner.json token == T
                   judged no token:     its owner.json is still unusable and its mtime is older than lockStaleMs
                not the same (we took a live lock) => rename it back to store.lock; do NOT claim the break
                   (if the name is taken again, remove the renamed copy: the IO `rename` MUST FAIL when the destination
                    is a directory, never move the source INTO it, as plain `mv` does; section 12)
                same => remove the renamed directory, warning stale_lock_broken
                remove store.lock.break in every case, then retry mkdir of store.lock
  ```

  The guard is held for milliseconds, only by breakers; a writer's own `mkdir store.lock` never touches it.
  `lock_timeout` still applies while waiting on a guard, and an unbreakable stale lock is never removed
  (nothing changed => `lock_timeout`). Crash recovery: a leftover `store.lock.break` is cleared by the next
  breaker once it is older than `lockStaleMs`. A test that pre-creates `store.lock` with an old `ts` and
  launches concurrent writers MUST end with every add present and `rev` equal to the number of effective
  writes (`store-node/test/stale-race.test.ts`).
- Release: read `owner.json`; if its `token` is ours (or unreadable), remove the whole directory
  (`rm -rf` / `cmd /c rmdir /s /q`). A writer whose lock was broken under it must not delete the
  successor's lock (token check); the CAS step is what protects the data in that case (fixture 05).
- Critical sections are tens of milliseconds. A writer MUST NOT hold the lock across user interaction,
  network, or model calls.
- If a platform cannot take the lock (the mod when `$.process.run` is unavailable - it is documented
  "CLI only", L3640 - or throws), the writer returns `io_error` "cannot write safely here". Reads still
  work. A write without the lock and without atomic replace is never attempted.

## 6. Test seam

Engines accept an optional `beforeCommit` callback invoked after the temp file is written and before
the CAS read. Fixture 05 uses it to replace the file as a lock-violating writer would. The seam is
test-only; production callers never set it.

## 7. Reading and change detection

- `read()` takes no lock. It reads and parses; on a parse failure it retries 3 times, 50 ms apart
  (covers a non-atomic foreign writer), then reports `corrupt`. Readers NEVER modify any file. Missing
  file = empty doc rev 0 and nothing is created.
- Read envelope: `{ok:true, doc, warnings:[]}` or `{ok:false, error: corrupt | unsupported_version | io_error}`.
- Change detection (everyone): poll `stat(todos.json)` every 400 ms; when `(mtimeMs, size)` differs from
  the last poll, or at least every 2 s regardless, read it and publish if the normalised JSON differs
  from the last published one. `rev` is a hint for cheap comparison, not the only gate: after a
  recovery (section 8) correctness does not depend on it. Watching the directory is deliberately not
  used: atomic rename replaces the inode (a file watch would be lost) and directory events differ per OS;
  a 400 ms stat poll of one tiny file is cheap and uniform. The mod has no watch API at all (`$.fs`:
  read/write/list/exists/stat only), so it polls lazily: `stat` + read at each `prompt.submit` and
  tool call.
- Self-writes are published like any other change (the UI reconciles by item id, section 10 of plan.md).

## 8. Corruption, recovery, versions

Corrupt = not valid JSON, not an object, `schemaVersion`/`rev`/`order` not integers, `items` not an array,
an item missing a field or with a wrong type or an invalid `status`/`id`, or duplicate ids.

Writers (under the lock) that find `todos.json` corrupt:

1. If `todos.json.bak` exists and is valid: base = the `.bak` doc with `rev = max(bak.rev, rawRev)` where `rawRev` is
   scraped from the corrupt text with `/"rev"\s*:\s*(\d+)/` (0 if none), so `rev` never repeats a value a live
   window may have shown; apply the op (a rejected op changes nothing, nothing is quarantined); commit with
   `rev = base.rev + 1` (always write, even when the op was a no-op). Warnings `corrupt_quarantined` and
   `restored_from_bak`. The commit is the ordinary sequence of section 4 with ONE extra step, and the order is
   normative (TS and Rust identical):

   1. write both temp files (new `todos.json`, new `.bak`), run the CAS against the corrupt bytes;
   2. copy the corrupt `todos.json` byte-identical to `todos.corrupt-<ts>-<token>.json`, creating it atomically
      (Rust: hard link, copy as fallback; TS: `IO.copyFile`, a hard link or copy-then-rename; never a partial file);
   3. rename the temp over `todos.json`; if that fails, delete the quarantine copy (the corrupt file is still there);
   4. rename the bak temp over `todos.json.bak`.

   `todos.json` is never absent: it is replaced only by step 3, which swaps one existing file for another. A crash
   after step 2 leaves the corrupt `todos.json` in place, a valid `.bak`, and one extra quarantine copy (duplicate
   bytes, harmless; the next writer recovers again and makes its own). A crash after step 3 is the section 4
   "`.bak` one version behind" case. `.bak` is never overwritten with corrupt content: its new content is the
   restored commit.
2. Otherwise refuse with `corrupt_no_backup`: `todos.json` stays exactly as found, nothing is written or
   moved. The explicit op `reset_corrupt` (window banner button, `/ttd recover`) quarantines it (the same
   steps as above) and writes `{rev: rawRev+1, items: []}`. Never write an empty list over a file that could not be parsed.

`schemaVersion` greater than supported: `unsupported_version` on read and write; the file is not
quarantined, not rewritten, not downgraded. Lower versions: migrate in memory, persist on the next effective
write (none exist yet; the hook exists so v2 is a table entry).

## 9. CLI contract (TS `store-node/cli.ts` and Rust `ttd-store`, identical)

Env `TTD_HOME`. Output is one JSON document per line on stdout; diagnostics on stderr.

```
<cli> read                                  -> read envelope; exit 0 if ok else 1
<cli> apply '<op json>' [--now <iso>]       -> apply envelope; exit 0 if ok else 1
<cli> watch [--interval-ms 400] [--max-events N] [--timeout-ms T]
                                            -> a line {"rev":n,"at":<epoch ms>,"count":<items>} for the initial state and
                                               every observed change; exit 0 after N events or T ms
```

`--now` exists so fixtures and tests are deterministic; default is the wall clock. Both CLIs read the
optional env overrides `TTD_LOCK_TIMEOUT_MS` and `TTD_LOCK_STALE_MS` (defaults 5000 / 15000) so the
crash-recovery integration test does not have to wait 15 s.

## 10. Reference API shape (TS, non-normative signatures)

```ts
interface IO {                       // injected; node-io.ts for bun/node, mod-io.ts for the mod ($.fs / $.process)
  now(): number; sleep(ms: number): Promise<void>; random(): number; pid(): number
  readText(p: string): Promise<string | null>          // null = ENOENT
  writeText(p: string, t: string): Promise<void>        // creates parent dirs
  rename(from: string, to: string): Promise<void>       // atomic replace, retries per section 4; MUST fail, never nest, when `to` is a directory
  copyFile(from: string, to: string): Promise<void>     // `to` (must not exist) = byte-identical copy of `from`, complete or absent
  mkdirExclusive(p: string): Promise<boolean>           // true created, false exists
  removeTree(p: string): Promise<void>                  // missing is fine
  mtimeMs(p: string): Promise<number | null>
}
createStore(io: IO, homeDir: string, opts?: { lockTimeoutMs?: number; lockStaleMs?: number }): {
  read(): Promise<ReadResult>
  apply(op: Op, ctx?: { now?: string; beforeCommit?: () => Promise<void> }): Promise<ApplyResult>
}
applyOp(doc: Doc, op: Op, now: string, newId: () => string): { doc: Doc; changed: boolean; result: unknown } // throws StoreError
```

The core imports nothing and touches no host API: ECMAScript built-ins only (`Date`, `Math.random`,
`JSON`, `TextEncoder` and `crypto` exist in the mod environment - probe-verified - but `process`, `Buffer`,
`fs`, `require` and dynamic `import()` do not, and `import()` makes a module fail to load). Time and
randomness still come from `IO`/`ctx` so tests are deterministic. The Rust crate exposes the same shapes (`Store::read`, `Store::apply`, `apply_op`).

## 11. Fixtures and the shared harness

`docs/contract/fixtures/NN-name.json`, schema:

```
{ "fixture": 1, "name", "description",
  "options"?: { "lockTimeoutMs"?, "lockStaleMs"? },
  "setup": { "file": null | <Doc> | {"raw": string},         // todos.json before the steps
             "bak":  null | <Doc> | {"raw": string},
             "lock": null | {"ownerAgeMs": n} },             // pre-existing lock whose owner.json ts = wallclock - ownerAgeMs
  "steps": [ { "now": <iso>, "op": <Op> | "read": true,
               "seam"?: {"beforeCommit": {"replaceFile": <Doc>}},
               "expect": { "ok": true, "changed"?, "rev"?, "result"?, "warnings"?: [...], "attempts"?, "doc"? }
                        | { "ok": false, "error": code } } ],
  "final": { "file": <Doc> | {"raw"} | "absent", "bakExists"?: bool, "bakEqualsFile"?: true,   // bytes of .bak == bytes of todos.json
             "quarantined": n, "quarantinedRaw"?: [string], "lockDir": bool, "tmpFiles": n } }
```

Harness rules (identical in TS and Rust): create a fresh temp `TTD_HOME`; materialise `setup`; run steps
in order with `ctx.now = step.now`; `expect` keys that are present are compared (objects deep-equal,
`warnings` exact list, default `[]`); `result` compared deep-equal; after the last step compare `final`
(`quarantined` = count of `todos.corrupt-*.json`, `lockDir` = `store.lock` exists, `tmpFiles` = count
of `.todos.json.tmp-*`). Real files in a real temp dir; no mocked filesystem. Index:

| # | covers |
|---|---|
| 01 | add/set_status/update/delete from an absent file, rev 0->6, trim |
| 02 | relative move, no-op move, self/unknown targets, renumbering, updatedAt untouched |
| 03 | idempotent add, delete-missing, same-value updates (no write), not_found, invalid_op |
| 04 | validation and code-point limits (emoji), file untouched on error |
| 05 | CONFLICT: rev changes between read and commit; retry re-applies; both changes survive; attempts=2 |
| 06 | CORRUPT with valid .bak: quarantine, restore, rev jump, warnings, .bak ends equal to the new file |
| 07 | CORRUPT without .bak: refuse, file untouched, read=corrupt, reset_corrupt, not_corrupt |
| 08 | unsupported schemaVersion: no write, no quarantine |
| 09 | unknown fields preserved |
| 10 | stale lock broken |
| 11 | live lock -> lock_timeout, foreign lock left alone |
| 12 | read normalises order without writing |
| 13 | read of an absent file |
| 14 | CORRUPT after a status flip: the restore keeps the flip (the last acknowledged write), .bak ends equal to the new file |

Real concurrency (many processes, mixed implementations) is not a fixture: it is the wave 3
integration test in `docs/plan/plan.md`.

## 12. Platform notes for the mod adapter (`plugin/hooks/mod-io.ts`)

| IO method | POSIX | Windows (UNVERIFIED on the dev box) |
|---|---|---|
| `readText` | `$.fs.read` (reject ENOENT -> null) | same |
| `writeText` | `$.fs.write` | same |
| `rename` | `$.process.run(["sh","-c",<script>,"sh",a,b])`; the script refuses (exit 75) when `b` is a directory, else `exec mv -f -- a b` | `["cmd","/c","move","/Y",a,b]` |
| `copyFile` | `["sh","-c",<script>,"sh",a,b]`; refuses an existing `b`, tries `ln a b`, else `cp a b.part` + `mv -f` | `["cmd","/c","copy","/Y","/B",a,b]` |
| `mkdirExclusive` | `["mkdir", p]` exit 0 / non-zero | `["cmd","/c","mkdir",p]` |
| `removeTree` | `["rm","-rf",p]` | `["cmd","/c","rmdir","/s","/q",p]` |
| `mtimeMs` | `$.fs.stat(p).mtimeMs` | same |

There is no platform API in the types (grep for platform/win32/darwin finds only speech and surface
nouns), so Windows is detected from the resolved home path (`^[A-Za-z]:` or contains a backslash).
`$.env.get` takes literal names only, so the adapter reads `TTD_HOME`, `USERPROFILE`, `HOME` as three
literal calls. Probe-verified on macOS (claude 2.1.318): `claude -p --plugin-dir <dir> "/cmd"` runs a
registered command with real `$.fs` and `$.process`, sees the shell's env, `mkdir` is exclusive
(second call exit 1), `mv -f` replaces files, and `CommandRunResult.exitCode` becomes the process exit code.
