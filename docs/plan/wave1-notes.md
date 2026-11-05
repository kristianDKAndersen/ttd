# Wave 1 hand-off notes (from job a - TS core; authoritative where STORE.md was ambiguous)

## IO contract changes job b's mod-io MUST honour
- `IO.ensureDir(p)` (mkdir -p) is a required method; the engine calls it before the lock mkdir.
- `mkdirExclusive` returns `false` ONLY for "already exists"; throws for any other failure (else the engine ends in `io_error` after lockTimeoutMs).
- `IO.now()` = real epoch ms, only for lock staleness; item timestamps come from `ctx.now`.
- The core imports siblings as `./x.ts` (mod loader acceptance unverified - job b must check).

## Contract readings (the never-lose-an-item reading; Rust must match)
1. Corrupt file + valid .bak: op applied first; corrupt file renamed to quarantine name only immediately before the final rename; on op failure nothing moves. A no-op op still writes and reports changed:true.
2. reset_corrupt with valid .bak restores bak (warnings corrupt_quarantined + restored_from_bak, rev = max+1); empty doc only when no valid bak.
3. CAS compares raw file text (absent / corrupt / present), not just rev.
4. Writers retry a torn read 3x 50ms apart before declaring corrupt.
5. Lone surrogates refused: in title -> invalid_title, in body -> invalid_op.
6. Explicit null for optional fields -> invalid_op; missing move.after -> invalid_op.
7. Size limit applies only when the op grows the file; deletes never blocked.
8. schemaVersion < 1, rev < 0, and a leading BOM -> corrupt.
9. `message` present only on io_error and invalid_op.
10. CLI usage errors exit 2.
11. watch: corrupt/unsupported read prints {"error":code,"at":ms} instead of rev/count.
12. No sweep of stale .todos.json.tmp-* (IO has no list method).

## Public TS API (plugin/hooks/store/index.ts)
createStore(io, homeDir, {lockTimeoutMs?, lockStaleMs?}) -> {read(), apply(op, {now?, beforeCommit?})}
applyOp, validateOp, parseDoc, normalise, emptyDoc, serialize, scrapeRev, trimTtd, cpLen, isValidId, makeId,
compactTimestamp, joinPath, resolveHomeDir(env) + StoreError, constants, types (Doc, Item, Op, IO, ApplyResult, ReadResult, ...).
ApplyResult = {ok:true, changed, rev, result, warnings, attempts, doc} | {ok:false, error, message?}
ReadResult  = {ok:true, doc, warnings} | {ok:false, error: corrupt|unsupported_version|io_error}
Node side: store-node/node-io.ts createNodeIO()/nodeIO; store-node/watch.ts watchStore({homeDir,onEvent,...}), eventLine(e); store-node/cli.ts main(argv, env, out, err).

## UI (job c) facts for d/g
Backend interface: read(), apply(op), subscribe(cb) -> unsubscribe, close?() (Tauri only; window is undecorated, shows a close button).
HttpBackend: GET /api/doc, POST /api/op, SSE named event `doc` on /api/events. TauriBackend: invoke store_read / store_apply {op}, listen store-changed.
`mount(root, backend, { onRender(count) })` exposes rendered row count - job d wires smoke_report from app/src/main.ts.
Selectors: li.row[data-id][data-status] (.row-toggle .row-title .row-body .act.trash|play|check), .add, .close, .new-form .f-title .f-body,
.banner[data-kind] .reset .retry, .toast, mid-drag .ghost .drop-slot; tokens --status-todo / --status-in-progress / --status-done (+dark).
