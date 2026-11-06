//! The engine: lock (section 5), CAS commit (sections 4-5), recovery (section 8), reads (section 7).

use crate::doc::{Doc, ParseError};
use crate::error::{ErrorCode, StoreError, Warning};
use crate::ops::apply_op;
use serde_json::{json, Value};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use time::macros::format_description;

const TODOS: &str = "todos.json";
const BAK: &str = "todos.json.bak";
const LOCK: &str = "store.lock";
const BREAK_GUARD: &str = "store.lock.break";
const MAX_ATTEMPTS: u32 = 5;
const RENAME_RETRIES: u32 = 5;
const RENAME_BACKOFF: Duration = Duration::from_millis(20);
const READ_RETRIES: u32 = 3;
const READ_RETRY_GAP: Duration = Duration::from_millis(50);

/// Lock timings (STORE.md section 5). Env overrides: `TTD_LOCK_TIMEOUT_MS`, `TTD_LOCK_STALE_MS`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Options {
    pub lock_timeout: Duration,
    pub lock_stale: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Options { lock_timeout: Duration::from_millis(5000), lock_stale: Duration::from_millis(15000) }
    }
}

impl Options {
    pub fn from_env() -> Options {
        Options::from_env_fn(|k| std::env::var(k).ok())
    }

    /// Unset, empty or unparseable values keep the default.
    pub fn from_env_fn(get: impl Fn(&str) -> Option<String>) -> Options {
        let ms = |k: &str| get(k).and_then(|v| v.trim().parse::<u64>().ok()).map(Duration::from_millis);
        let d = Options::default();
        Options { lock_timeout: ms("TTD_LOCK_TIMEOUT_MS").unwrap_or(d.lock_timeout), lock_stale: ms("TTD_LOCK_STALE_MS").unwrap_or(d.lock_stale) }
    }
}

/// `HOME_DIR` of section 1: `TTD_HOME` (non-empty), else `<USERPROFILE>/.ttd`, else `<HOME>/.ttd`.
/// No `~` expansion.
pub fn home_dir_from(get: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let non_empty = |k: &str| get(k).filter(|v| !v.is_empty());
    if let Some(h) = non_empty("TTD_HOME") {
        return Some(PathBuf::from(h));
    }
    if let Some(u) = non_empty("USERPROFILE") {
        return Some(PathBuf::from(u).join(".ttd"));
    }
    non_empty("HOME").map(|h| PathBuf::from(h).join(".ttd"))
}

/// The commit rename (tmp -> todos.json) and the stale-lock break renames. A seam for fault injection
/// (EPERM on Windows); production uses [`StdRenamer`].
pub trait Renamer: Send + Sync {
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
}

pub struct StdRenamer;

impl Renamer for StdRenamer {
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        fs::rename(from, to)
    }
}

/// Per-call context. `before_commit` is the test seam of section 6 (after the temp file is written,
/// before the CAS read); production callers leave it `None`.
#[derive(Default)]
pub struct ApplyCtx {
    /// ISO-8601 UTC with milliseconds and `Z`; default is the wall clock.
    pub now: Option<String>,
    pub before_commit: Option<Box<dyn FnMut() + Send>>,
}

impl ApplyCtx {
    pub fn at(now: &str) -> ApplyCtx {
        ApplyCtx { now: Some(now.to_string()), before_commit: None }
    }
}

#[derive(Debug, Clone)]
pub struct ApplyOk {
    pub changed: bool,
    pub rev: u64,
    pub result: Value,
    pub warnings: Vec<Warning>,
    pub attempts: u32,
    /// Post-state document (normalised).
    pub doc: Doc,
}

impl ApplyOk {
    pub fn to_envelope(&self) -> Value {
        json!({
            "ok": true,
            "changed": self.changed,
            "rev": self.rev,
            "result": self.result,
            "warnings": warnings_json(&self.warnings),
            "attempts": self.attempts,
            "doc": self.doc.to_value(),
        })
    }
}

#[derive(Debug, Clone)]
pub struct ReadOk {
    /// Normalised view; the file is not modified.
    pub doc: Doc,
    pub warnings: Vec<Warning>,
}

impl ReadOk {
    pub fn to_envelope(&self) -> Value {
        json!({ "ok": true, "doc": self.doc.to_value(), "warnings": warnings_json(&self.warnings) })
    }
}

fn warnings_json(w: &[Warning]) -> Value {
    Value::Array(w.iter().map(|w| Value::String(w.as_str().into())).collect())
}

/// Handle on one `HOME_DIR`. Cheap to clone; safe to share between threads.
#[derive(Clone)]
pub struct Store {
    home: PathBuf,
    opts: Options,
    renamer: Arc<dyn Renamer>,
}

enum State {
    Absent,
    Valid { raw: Vec<u8>, doc: Doc },
    Corrupt { raw: Vec<u8> },
}

/// What `todos.json` must still look like at the CAS step.
enum Expected {
    Absent,
    Bytes(Vec<u8>),
}

enum Attempt {
    Done(Box<ApplyOk>),
    Conflict,
}

impl Store {
    pub fn new(home: impl Into<PathBuf>) -> Store {
        Store { home: home.into(), opts: Options::default(), renamer: Arc::new(StdRenamer) }
    }

    /// `HOME_DIR` from the environment plus the lock-timing overrides; `None` if no home can be resolved.
    pub fn from_env() -> Option<Store> {
        home_dir_from(|k| std::env::var(k).ok()).map(|h| Store::new(h).with_options(Options::from_env()))
    }

    pub fn with_options(mut self, opts: Options) -> Store {
        self.opts = opts;
        self
    }

    pub fn with_renamer(mut self, renamer: Arc<dyn Renamer>) -> Store {
        self.renamer = renamer;
        self
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    pub fn todos_path(&self) -> PathBuf {
        self.home.join(TODOS)
    }

    // ---- reading (section 7) -------------------------------------------------------------

    /// Lock-free read. Retries a parse failure 3 times, 50 ms apart, then reports `corrupt`.
    /// Never creates or modifies a file.
    pub fn read(&self) -> Result<ReadOk, StoreError> {
        match self.load_state()? {
            State::Absent => Ok(ReadOk { doc: Doc::empty(), warnings: vec![] }),
            State::Valid { doc, .. } => Ok(ReadOk { doc: doc.normalized(), warnings: vec![] }),
            State::Corrupt { .. } => Err(StoreError::new(ErrorCode::Corrupt)),
        }
    }

    /// [`Store::read`] as the section 7 envelope.
    pub fn read_json(&self) -> Value {
        match self.read() {
            Ok(r) => r.to_envelope(),
            Err(e) => e.to_envelope(),
        }
    }

    fn read_raw(&self, path: &Path) -> Result<Option<Vec<u8>>, StoreError> {
        match fs::read(path) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(StoreError::io(&format!("read {}", path.display()), &e)),
        }
    }

    fn load_state(&self) -> Result<State, StoreError> {
        let path = self.todos_path();
        let mut tries = 0;
        loop {
            let Some(raw) = self.read_raw(&path)? else { return Ok(State::Absent) };
            let parsed = match std::str::from_utf8(&raw) {
                Ok(text) => Doc::parse(text),
                Err(_) => Err(ParseError::Corrupt),
            };
            match parsed {
                Ok(doc) => return Ok(State::Valid { raw, doc }),
                Err(ParseError::Unsupported) => return Err(StoreError::new(ErrorCode::UnsupportedVersion)),
                Err(ParseError::Corrupt) => {
                    if tries >= READ_RETRIES {
                        return Ok(State::Corrupt { raw });
                    }
                    tries += 1;
                    std::thread::sleep(READ_RETRY_GAP);
                }
            }
        }
    }

    fn read_bak(&self) -> Option<Doc> {
        let raw = fs::read(self.home.join(BAK)).ok()?;
        Doc::parse(std::str::from_utf8(&raw).ok()?).ok()
    }

    // ---- writing (sections 4, 5, 8) --------------------------------------------------------

    /// [`Store::apply`] as the section 3 envelope.
    pub fn apply_json(&self, op: &Value, ctx: ApplyCtx) -> Value {
        match self.apply(op, ctx) {
            Ok(r) => r.to_envelope(),
            Err(e) => e.to_envelope(),
        }
    }

    /// Run one op under the lock with the CAS/retry protocol. `now` and a generated id are fixed
    /// once, before the retry loop, so a retry re-applies exactly the same op.
    pub fn apply(&self, op: &Value, mut ctx: ApplyCtx) -> Result<ApplyOk, StoreError> {
        let now = match ctx.now.take() {
            Some(n) if valid_now(&n) => n,
            Some(n) => return Err(StoreError::with_message(ErrorCode::InvalidOp, format!("now must be ISO-8601 UTC with milliseconds and Z, got {n:?}"))),
            None => wall_clock_iso(),
        };
        // Chosen once, before the retry loop: every attempt offers the same first candidate id.
        let first_id = generate_id();
        let _ = fs::create_dir_all(&self.home);
        let mut warnings = Vec::new();
        let mut lock = self.acquire_lock(&mut warnings)?;
        let result = (|| {
            for attempt in 1..=MAX_ATTEMPTS {
                let mut offered = false;
                let mut gen = || {
                    if offered {
                        generate_id()
                    } else {
                        offered = true;
                        first_id.clone()
                    }
                };
                match self.attempt(op, &now, attempt, &warnings, &mut ctx, &mut gen)? {
                    Attempt::Done(ok) => return Ok(*ok),
                    Attempt::Conflict => continue,
                }
            }
            Err(StoreError::new(ErrorCode::ConflictExhausted))
        })();
        lock.release();
        result
    }

    fn attempt(&self, op: &Value, now: &str, attempt: u32, lock_warnings: &[Warning], ctx: &mut ApplyCtx, gen: &mut dyn FnMut() -> String) -> Result<Attempt, StoreError> {
        let state = self.load_state()?;
        let mut warnings: Vec<Warning> = lock_warnings.to_vec();
        let is_reset = op.get("op").and_then(Value::as_str) == Some("reset_corrupt");

        if is_reset {
            // Only valid while the file is corrupt. With a valid .bak the "reset" restores it (the
            // never-lose-an-item reading, shared with the TS core); an empty doc only without one.
            let State::Corrupt { raw } = state else { return Err(StoreError::with_message(ErrorCode::NotCorrupt, "the file is not corrupt")) };
            let raw_rev = scrape_rev(&raw);
            warnings.push(Warning::CorruptQuarantined);
            let mut doc = match self.read_bak() {
                Some(mut bak) => {
                    bak.rev = bak.rev.max(raw_rev);
                    warnings.push(Warning::RestoredFromBak);
                    bak.normalized()
                }
                None => {
                    let mut d = Doc::empty();
                    d.rev = raw_rev;
                    d
                }
            };
            doc.rev = doc.rev.saturating_add(1);
            let commit = Commit { doc: &doc, expected: Expected::Bytes(raw.clone()), quarantine: Some(raw) };
            return Ok(match self.commit(commit, ctx)? {
                true => Attempt::Done(Box::new(ApplyOk { changed: true, rev: doc.rev, result: json!({}), warnings, attempts: attempt, doc })),
                false => Attempt::Conflict,
            });
        }

        // Base document, what the file must still be at the CAS step, and whether this is a restore.
        let (base, expected, restore_raw) = match state {
            State::Absent => (Doc::empty(), Expected::Absent, None),
            State::Valid { raw, doc } => (doc, Expected::Bytes(raw), None),
            State::Corrupt { raw } => {
                let Some(mut bak) = self.read_bak() else { return Err(StoreError::new(ErrorCode::CorruptNoBackup)) };
                bak.rev = bak.rev.max(scrape_rev(&raw));
                (bak, Expected::Bytes(raw.clone()), Some(raw))
            }
        };
        let restoring = restore_raw.is_some();

        // The op is applied (and so validated) before anything is quarantined or moved.
        let applied = apply_op(&base, op, now, gen)?;
        if !applied.changed && !restoring {
            let rev = base.rev;
            return Ok(Attempt::Done(Box::new(ApplyOk { changed: false, rev, result: applied.result, warnings, attempts: attempt, doc: applied.doc })));
        }
        let mut doc = applied.doc;
        doc.rev = base.rev.saturating_add(1);
        if restoring {
            warnings.push(Warning::CorruptQuarantined);
            warnings.push(Warning::RestoredFromBak);
        }
        let commit = Commit { doc: &doc, expected, quarantine: restore_raw };
        Ok(match self.commit(commit, ctx)? {
            true => Attempt::Done(Box::new(ApplyOk { changed: true, rev: doc.rev, result: applied.result, warnings, attempts: attempt, doc })),
            false => Attempt::Conflict,
        })
    }

    /// tmp + bak tmp -> seam -> CAS -> (quarantine link) -> rename tmp over todos.json -> rename bak tmp over .bak
    /// (STORE.md sections 4 and 8). `Ok(false)` = CAS conflict, temp files removed.
    fn commit(&self, c: Commit<'_>, ctx: &mut ApplyCtx) -> Result<bool, StoreError> {
        let text = c.doc.to_json_pretty();
        let todos = self.todos_path();
        // Both files are complete before anything visible changes, so a write failure aborts the op uncommitted.
        let mut tmp = TempFile::new(self.home.join(format!(".todos.json.tmp-{}", token())));
        write_file_synced(&tmp.path, text.as_bytes()).map_err(|e| StoreError::io("write temp file", &e))?;
        let mut bak_tmp = TempFile::new(self.home.join(format!(".todos.json.tmp-{}", token())));
        write_file_synced(&bak_tmp.path, text.as_bytes()).map_err(|e| StoreError::io("write backup", &e))?;

        if let Some(f) = ctx.before_commit.as_mut() {
            f();
        }

        let current = self.read_raw(&todos)?;
        let still = match (&c.expected, &current) {
            (Expected::Absent, None) => true,
            (Expected::Bytes(want), Some(now)) => want == now,
            _ => false,
        };
        if !still {
            return Ok(false);
        }

        // Quarantine by hard link (byte-identical); copy as fallback. todos.json is only ever replaced by the rename
        // below, so it is never absent.
        let mut quarantine = None;
        if c.quarantine.is_some() {
            let q = QuarantineFile::new(self.home.join(format!("todos.corrupt-{}-{}.json", wall_clock_compact(), token())));
            if fs::hard_link(&todos, &q.path).is_err() {
                fs::copy(&todos, &q.path).map_err(|e| StoreError::io("quarantine corrupt file", &e))?;
            }
            quarantine = Some(q);
        }

        self.rename_retrying(&tmp.path, &todos)?;
        tmp.disarm();
        if let Some(q) = quarantine.as_mut() {
            q.disarm();
        }
        // .bak = the commit just made, swapped in atomically. Failing here (or a crash) leaves the previous .bak, one
        // version behind; the commit is already durable and acknowledged.
        if self.rename_retrying(&bak_tmp.path, &self.home.join(BAK)).is_ok() {
            bak_tmp.disarm();
        }
        sync_dir(&self.home);
        Ok(true)
    }

    /// Rename; EPERM/EACCES/EBUSY (Windows sharing violations) are retried 5 times, 20 ms apart.
    fn rename_retrying(&self, from: &Path, to: &Path) -> Result<(), StoreError> {
        let mut retries = 0;
        loop {
            match self.renamer.rename(from, to) {
                Ok(()) => return Ok(()),
                Err(e) if retries < RENAME_RETRIES && retryable(&e) => {
                    retries += 1;
                    std::thread::sleep(RENAME_BACKOFF);
                }
                Err(e) => return Err(StoreError::io(&format!("rename to {}", to.display()), &e)),
            }
        }
    }

    // ---- lock (section 5) ------------------------------------------------------------------

    fn acquire_lock(&self, warnings: &mut Vec<Warning>) -> Result<LockGuard, StoreError> {
        let lock = self.home.join(LOCK);
        let deadline = Instant::now() + self.opts.lock_timeout;
        let mut rng = fastrand::Rng::new();
        loop {
            match fs::create_dir(&lock) {
                Ok(()) => {
                    let tok = token();
                    let owner = json!({ "token": tok, "pid": std::process::id(), "ts": epoch_ms() });
                    match fs::write(lock.join("owner.json"), owner.to_string()) {
                        Ok(()) => return Ok(LockGuard { path: lock, token: tok, released: false }),
                        Err(e) => {
                            // Our fresh (still empty) directory was taken from under us by a stale-lock
                            // breaker: that is a lost race, not a failure. Try again.
                            let _ = fs::remove_dir(&lock);
                            if matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::InvalidInput) {
                                continue;
                            }
                            return Err(StoreError::io("write lock owner", &e));
                        }
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists || lock.exists() => {
                    match self.judge(&lock) {
                        Judgement::Gone => continue,
                        Judgement::Stale(_) => match self.try_break(&lock) {
                            Break::Broke => {
                                if !warnings.contains(&Warning::StaleLockBroken) {
                                    warnings.push(Warning::StaleLockBroken);
                                }
                                continue;
                            }
                            // Not broken (rename refused, lost race, guard held): back off and honour the
                            // deadline below, as the TS engine does; never retry in a tight loop.
                            Break::Attempted | Break::Busy => {}
                        },
                        Judgement::Fresh => {}
                    }
                    let now = Instant::now();
                    if now >= deadline {
                        return Err(StoreError::new(ErrorCode::LockTimeout));
                    }
                    let pause = Duration::from_millis(rng.u64(10..=40)).min(deadline - now);
                    std::thread::sleep(pause);
                }
                Err(e) => return Err(StoreError::io("create lock directory", &e)),
            }
        }
    }

    /// Break a lock judged stale. Breakers are serialised through `store.lock.break` (an exclusive
    /// `mkdir`) and re-judge under it: without that, a second breaker that read the same stale
    /// `owner.json` can rename away the fresh lock the first breaker's successor just created.
    fn try_break(&self, lock: &Path) -> Break {
        let guard_path = self.home.join(BREAK_GUARD);
        match fs::create_dir(&guard_path) {
            Ok(()) => {
                let _guard = RemoveDirOnDrop(guard_path);
                match self.judge(lock) {
                    Judgement::Stale(j) if self.break_stale(lock, &j) => Break::Broke,
                    _ => Break::Attempted,
                }
            }
            Err(_) => {
                // A crashed breaker's guard must not wedge the store forever.
                let old = fs::metadata(&guard_path).and_then(|m| m.modified()).map(|m| SystemTime::now().duration_since(m).unwrap_or_default() > self.opts.lock_stale);
                if old.unwrap_or(false) {
                    let _ = fs::remove_dir(&guard_path);
                }
                Break::Busy
            }
        }
    }

    fn judge(&self, lock: &Path) -> Judgement {
        let age = |ms: u64| Duration::from_millis(epoch_ms().saturating_sub(ms));
        if let Some(owner) = read_owner(lock) {
            return if age(owner.ts) > self.opts.lock_stale { Judgement::Stale(Judged { token: Some(owner.token) }) } else { Judgement::Fresh };
        }
        match fs::metadata(lock).and_then(|m| m.modified()) {
            Ok(mtime) => {
                if SystemTime::now().duration_since(mtime).unwrap_or_default() > self.opts.lock_stale {
                    Judgement::Stale(Judged { token: None })
                } else {
                    Judgement::Fresh
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Judgement::Gone,
            Err(_) => Judgement::Fresh,
        }
    }

    /// Rename the stale lock away (atomic: one breaker wins), then verify that what we renamed is
    /// the lock we judged. If another writer swapped in a live lock between the judgement and the
    /// rename, put it back and do not claim the break.
    fn break_stale(&self, lock: &Path, judged: &Judged) -> bool {
        let moved = self.home.join(format!("{LOCK}.stale-{}", token()));
        if self.renamer.rename(lock, &moved).is_err() {
            return false;
        }
        let same = match (&judged.token, read_owner(&moved)) {
            (Some(t), Some(o)) => *t == o.token,
            (None, None) => fs::metadata(&moved)
                .and_then(|m| m.modified())
                .map(|m| SystemTime::now().duration_since(m).unwrap_or_default() > self.opts.lock_stale)
                .unwrap_or(false),
            _ => false,
        };
        if !same && self.renamer.rename(&moved, lock).is_ok() {
            return false;
        }
        let _ = fs::remove_dir_all(&moved);
        same
    }
}

struct Commit<'a> {
    doc: &'a Doc,
    expected: Expected,
    /// Bytes of the corrupt file to quarantine (hard-linked, so byte-identical).
    quarantine: Option<Vec<u8>>,
}

struct Judged {
    token: Option<String>,
}

enum Break {
    Broke,
    Attempted,
    Busy,
}

struct RemoveDirOnDrop(PathBuf);

impl Drop for RemoveDirOnDrop {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

enum Judgement {
    Fresh,
    Stale(Judged),
    Gone,
}

struct Owner {
    token: String,
    ts: u64,
}

fn read_owner(lock: &Path) -> Option<Owner> {
    let v: Value = serde_json::from_slice(&fs::read(lock.join("owner.json")).ok()?).ok()?;
    Some(Owner { token: v.get("token")?.as_str()?.to_string(), ts: v.get("ts")?.as_u64()? })
}

/// Holds the lock directory; releases on drop (token-checked, section 5).
struct LockGuard {
    path: PathBuf,
    token: String,
    released: bool,
}

impl LockGuard {
    fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        // Ours, or unreadable: remove. Someone else's token: a successor's lock, leave it.
        let foreign = matches!(read_owner(&self.path), Some(o) if o.token != self.token);
        if !foreign {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        self.release();
    }
}

struct TempFile {
    path: PathBuf,
    armed: bool,
}

impl TempFile {
    fn new(path: PathBuf) -> TempFile {
        TempFile { path, armed: true }
    }
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

struct QuarantineFile {
    path: PathBuf,
    armed: bool,
}

impl QuarantineFile {
    fn new(path: PathBuf) -> QuarantineFile {
        QuarantineFile { path, armed: true }
    }
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for QuarantineFile {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn retryable(e: &io::Error) -> bool {
    if e.kind() == io::ErrorKind::PermissionDenied {
        return true;
    }
    // Windows: ERROR_ACCESS_DENIED (5), ERROR_SHARING_VIOLATION (32), ERROR_LOCK_VIOLATION (33).
    cfg!(windows) && matches!(e.raw_os_error(), Some(5 | 32 | 33))
}

fn write_file_synced(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut f = fs::File::create(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

/// Best effort: persist the rename itself. Not possible on every platform.
fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

fn token() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = fastrand::Rng::new();
    (0..12).map(|_| ALPHABET[rng.usize(..ALPHABET.len())] as char).collect()
}

fn epoch_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn wall_clock_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"))
        .expect("format wall clock")
}

fn wall_clock_compact() -> String {
    time::OffsetDateTime::now_utc().format(format_description!("[year][month][day]T[hour][minute][second]Z")).expect("format wall clock")
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ`.
fn valid_now(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 24
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b'T',
            13 | 16 => *c == b':',
            19 => *c == b'.',
            23 => *c == b'Z',
            _ => c.is_ascii_digit(),
        })
}

/// `t_` + base36 ms + 6 random base36.
fn generate_id() -> String {
    let mut rng = fastrand::Rng::new();
    let mut s = String::from("t_");
    s.push_str(&base36(epoch_ms()));
    for _ in 0..6 {
        s.push(char::from_digit(rng.u32(..36), 36).expect("digit < 36"));
    }
    s
}

fn base36(mut n: u64) -> String {
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(char::from_digit((n % 36) as u32, 36).expect("digit < 36") as u8);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("ascii")
}

/// `/"rev"\s*:\s*(\d+)/` over lossily decoded text; first match wins; 0 if none.
fn scrape_rev(raw: &[u8]) -> u64 {
    const MAX_SAFE: u64 = 9_007_199_254_740_992;
    let text = String::from_utf8_lossy(raw);
    let js_ws = |c: char| matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}');
    let mut from = 0;
    while let Some(pos) = text[from..].find("\"rev\"") {
        let start = from + pos;
        let rest = text[start + 5..].trim_start_matches(js_ws);
        if let Some(rest) = rest.strip_prefix(':') {
            let rest = rest.trim_start_matches(js_ws);
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            if !digits.is_empty() {
                return digits.parse::<u64>().unwrap_or(MAX_SAFE).min(MAX_SAFE);
            }
        }
        from = start + 1;
    }
    0
}
