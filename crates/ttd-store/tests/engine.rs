//! Engine tests: lock, CAS, atomic write, recovery, read semantics. Real files in temp dirs; the only
//! injected faults are a rename wrapper over the real rename and the documented beforeCommit seam.

mod common;

use common::*;
use serde_json::{json, Value};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};
use ttd_store::{home_dir_from, ApplyCtx, ErrorCode, Options, Renamer, Store, Warning};

const NOW: &str = "2026-01-01T09:00:00.000Z";

fn fast(lock_timeout_ms: u64, lock_stale_ms: u64) -> Options {
    Options { lock_timeout: Duration::from_millis(lock_timeout_ms), lock_stale: Duration::from_millis(lock_stale_ms) }
}

fn add(store: &Store, id: &str, title: &str) -> Result<ttd_store::ApplyOk, ttd_store::StoreError> {
    store.apply(&json!({"op":"add","id":id,"title":title}), ApplyCtx::at(NOW))
}

fn setup() -> (tempfile::TempDir, PathBuf) {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    (t, home)
}

#[test]
fn creates_missing_home_directories_on_first_write() {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("a").join("b").join("ttd");
    let r = add(&Store::new(&home), "t1", "x").unwrap();
    assert_eq!(r.rev, 1);
    assert_eq!(read_json(&home.join("todos.json"))["rev"], 1);
}

#[test]
fn file_is_pretty_json_with_trailing_newline_and_bak_is_the_latest_commit_bytes() {
    let (_t, home) = setup();
    let store = Store::new(&home);
    add(&store, "t1", "one").unwrap();
    let first = fs::read(home.join("todos.json")).unwrap();
    assert!(first.ends_with(b"}\n"));
    assert!(!first.starts_with(&[0xEF, 0xBB, 0xBF]));
    assert!(String::from_utf8(first.clone()).unwrap().contains("\n  \"rev\": 1,"));
    assert_eq!(fs::read(home.join("todos.json.bak")).unwrap(), first, "even the first commit has a bak");
    add(&store, "t2", "two").unwrap();
    let second = fs::read(home.join("todos.json")).unwrap();
    assert_ne!(second, first);
    assert_eq!(fs::read(home.join("todos.json.bak")).unwrap(), second, "bak = byte-identical copy of the latest commit");
    assert_eq!(tmp_files(&home), 0);
}

#[test]
fn concurrent_applies_in_one_process_all_land() {
    let (_t, home) = setup();
    let store = Store::new(&home);
    let barrier = Arc::new(Barrier::new(8));
    let handles: Vec<_> = (0..8)
        .map(|i| {
            let store = store.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store.apply(&json!({"op":"add","title":format!("n{i}")}), ApplyCtx::at(NOW)).unwrap()
            })
        })
        .collect();
    let revs: Vec<u64> = handles.into_iter().map(|h| h.join().unwrap().rev).collect();
    let mut sorted = revs.clone();
    sorted.sort();
    assert_eq!(sorted, (1..=8).collect::<Vec<u64>>(), "every write gets its own rev");
    let doc = read_json(&home.join("todos.json"));
    assert_eq!(doc["rev"], 8);
    assert_eq!(doc["items"].as_array().unwrap().len(), 8);
    assert!(!home.join("store.lock").exists());
    assert_eq!(tmp_files(&home), 0);
}

#[test]
fn tmp_file_removed_on_validation_error() {
    let (_t, home) = setup();
    let store = Store::new(&home);
    add(&store, "t1", "x").unwrap();
    let e = store.apply(&json!({"op":"add","title":""}), ApplyCtx::at(NOW)).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidTitle);
    assert_eq!(tmp_files(&home), 0);
    assert!(!home.join("store.lock").exists(), "lock released on error");
}

#[test]
fn tmp_file_exists_while_committing_and_is_removed_after_a_cas_conflict() {
    let (_t, home) = setup();
    let store = Store::new(&home);
    add(&store, "t1", "x").unwrap();
    let seen_tmp = Arc::new(AtomicU32::new(0));
    let (h, s, calls) = (home.clone(), seen_tmp.clone(), Arc::new(AtomicU32::new(0)));
    let mut ctx = ApplyCtx::at(NOW);
    ctx.before_commit = Some(Box::new(move || {
        s.store(tmp_files(&h) as u32, Ordering::SeqCst);
        if calls.fetch_add(1, Ordering::SeqCst) == 0 {
            let mut d = read_json(&h.join("todos.json"));
            d["rev"] = json!(2);
            write_pretty(&h.join("todos.json"), &d);
        }
    }));
    let r = store.apply(&json!({"op":"add","id":"t2","title":"y"}), ctx).unwrap();
    assert_eq!(r.attempts, 2);
    assert_eq!(seen_tmp.load(Ordering::SeqCst), 2, "the todos temp file and the bak temp file are written before the seam");
    assert_eq!(tmp_files(&home), 0);
}

#[test]
fn conflict_exhausted_after_five_forced_conflicts_changes_nothing_of_ours() {
    let (_t, home) = setup();
    let store = Store::new(&home);
    add(&store, "t1", "x").unwrap();
    let h = home.clone();
    let calls = Arc::new(AtomicU32::new(0));
    let c = calls.clone();
    let mut ctx = ApplyCtx::at(NOW);
    ctx.before_commit = Some(Box::new(move || {
        let n = c.fetch_add(1, Ordering::SeqCst) as u64;
        write_pretty(&h.join("todos.json"), &doc_json(10 + n, vec![item("t1", "x", 0, "2026-01-01T08:00:00.000Z")]));
    }));
    let e = store.apply(&json!({"op":"add","id":"mine","title":"y"}), ctx).unwrap_err();
    assert_eq!(e.code, ErrorCode::ConflictExhausted);
    assert_eq!(calls.load(Ordering::SeqCst), 5, "exactly five attempts");
    assert_eq!(tmp_files(&home), 0);
    assert!(!home.join("store.lock").exists());
    let doc = read_json(&home.join("todos.json"));
    assert!(doc["items"].as_array().unwrap().iter().all(|i| i["id"] != "mine"));
}

struct FlakyRename {
    failures_left: AtomicU32,
    kind: io::ErrorKind,
    calls: AtomicU32,
}
impl Renamer for FlakyRename {
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.failures_left.load(Ordering::SeqCst) > 0 {
            self.failures_left.fetch_sub(1, Ordering::SeqCst);
            return Err(io::Error::new(self.kind, "injected"));
        }
        fs::rename(from, to)
    }
}

#[test]
fn rename_is_retried_after_eperm_twice_then_succeeds() {
    let (_t, home) = setup();
    let flaky = Arc::new(FlakyRename { failures_left: AtomicU32::new(2), kind: io::ErrorKind::PermissionDenied, calls: AtomicU32::new(0) });
    let store = Store::new(&home).with_renamer(flaky.clone());
    let started = Instant::now();
    let r = add(&store, "t1", "x").unwrap();
    assert_eq!(r.rev, 1);
    assert_eq!(flaky.calls.load(Ordering::SeqCst), 4, "commit: 2 failures + 1 success, then the bak rename");
    assert!(started.elapsed() >= Duration::from_millis(40), "two 20 ms back-offs");
    assert_eq!(tmp_files(&home), 0);
}

#[test]
fn rename_failure_exhausts_after_five_retries_cleans_up_and_leaves_the_file_alone() {
    let (_t, home) = setup();
    let ok = Store::new(&home);
    add(&ok, "t1", "x").unwrap();
    let before = fs::read(home.join("todos.json")).unwrap();
    let bak_before = fs::read(home.join("todos.json.bak")).ok();
    let flaky = Arc::new(FlakyRename { failures_left: AtomicU32::new(100), kind: io::ErrorKind::PermissionDenied, calls: AtomicU32::new(0) });
    let store = Store::new(&home).with_renamer(flaky.clone());
    let e = add(&store, "t2", "y").unwrap_err();
    assert_eq!(e.code, ErrorCode::IoError);
    assert!(e.message.is_some());
    assert_eq!(flaky.calls.load(Ordering::SeqCst), 6, "1 try + 5 retries");
    assert_eq!(fs::read(home.join("todos.json")).unwrap(), before);
    assert_eq!(tmp_files(&home), 0);
    assert!(!home.join("store.lock").exists());
    let _ = bak_before;
}

#[test]
fn non_retryable_rename_error_fails_immediately() {
    let (_t, home) = setup();
    let flaky = Arc::new(FlakyRename { failures_left: AtomicU32::new(100), kind: io::ErrorKind::NotFound, calls: AtomicU32::new(0) });
    let store = Store::new(&home).with_renamer(flaky.clone());
    assert_eq!(add(&store, "t1", "x").unwrap_err().code, ErrorCode::IoError);
    assert_eq!(flaky.calls.load(Ordering::SeqCst), 1);
    assert_eq!(tmp_files(&home), 0);
}

#[test]
fn lock_timeout_leaves_a_foreign_lock_completely_alone() {
    let (_t, home) = setup();
    fs::create_dir_all(&home).unwrap();
    make_lock(&home, 0);
    let owner_before = fs::read(home.join("store.lock/owner.json")).unwrap();
    let store = Store::new(&home).with_options(fast(250, 15_000));
    let started = Instant::now();
    let e = add(&store, "t1", "x").unwrap_err();
    assert_eq!(e.code, ErrorCode::LockTimeout);
    let el = started.elapsed();
    assert!(el >= Duration::from_millis(240) && el < Duration::from_millis(2000), "waited ~timeout, got {el:?}");
    assert_eq!(fs::read(home.join("store.lock/owner.json")).unwrap(), owner_before);
    assert!(!home.join("todos.json").exists());
    assert_eq!(tmp_files(&home), 0);
}

#[test]
fn waiter_gets_the_lock_when_the_holder_releases() {
    let (_t, home) = setup();
    fs::create_dir_all(&home).unwrap();
    make_lock(&home, 0);
    let h = home.clone();
    let releaser = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        fs::remove_dir_all(h.join("store.lock")).unwrap();
    });
    let store = Store::new(&home).with_options(fast(3000, 15_000));
    let r = add(&store, "t1", "x").unwrap();
    assert_eq!(r.rev, 1);
    assert!(r.warnings.is_empty());
    releaser.join().unwrap();
}

#[test]
fn stale_lock_by_owner_ts_is_broken_and_reported() {
    let (_t, home) = setup();
    fs::create_dir_all(&home).unwrap();
    make_lock(&home, 5_000);
    let store = Store::new(&home).with_options(fast(2000, 1_000));
    let r = add(&store, "t1", "x").unwrap();
    assert_eq!(r.warnings, vec![Warning::StaleLockBroken]);
    assert!(!home.join("store.lock").exists());
    assert_eq!(count_prefix(&home, "store.lock.stale-"), 0);
}

#[test]
fn lock_without_owner_json_falls_back_to_directory_mtime() {
    let (_t, home) = setup();
    fs::create_dir_all(home.join("store.lock")).unwrap();
    // Fresh dir, no owner.json: not stale yet -> timeout.
    let store = Store::new(&home).with_options(fast(200, 1_000));
    assert_eq!(add(&store, "t1", "x").unwrap_err().code, ErrorCode::LockTimeout);
    assert!(home.join("store.lock").exists());
    // Age the directory.
    let old = std::time::SystemTime::now() - Duration::from_secs(60);
    let f = fs::File::open(home.join("store.lock")).unwrap();
    f.set_modified(old).unwrap();
    drop(f);
    let r = add(&store, "t1", "x").unwrap();
    assert_eq!(r.warnings, vec![Warning::StaleLockBroken]);
    // Unparseable owner.json behaves the same.
    fs::create_dir_all(home.join("store.lock")).unwrap();
    fs::write(home.join("store.lock/owner.json"), "{garbage").unwrap();
    let f = fs::File::open(home.join("store.lock")).unwrap();
    f.set_modified(old).unwrap();
    drop(f);
    let r = add(&store, "t2", "y").unwrap();
    assert_eq!(r.warnings, vec![Warning::StaleLockBroken]);
}

#[test]
fn many_waiters_with_a_stale_lock_all_land_and_exactly_one_breaks_it() {
    let (_t, home) = setup();
    fs::create_dir_all(&home).unwrap();
    make_lock(&home, 60_000);
    let store = Store::new(&home).with_options(fast(10_000, 5_000));
    let barrier = Arc::new(Barrier::new(6));
    let handles: Vec<_> = (0..6)
        .map(|i| {
            let (store, barrier) = (store.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                store.apply(&json!({"op":"add","title":format!("n{i}")}), ApplyCtx::at(NOW)).unwrap()
            })
        })
        .collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let breakers = results.iter().filter(|r| r.warnings.contains(&Warning::StaleLockBroken)).count();
    assert_eq!(breakers, 1, "only one breaker wins the rename");
    assert_eq!(read_json(&home.join("todos.json"))["rev"], 6);
    assert_eq!(count_prefix(&home, "store.lock"), 0);
}

#[test]
fn a_writer_whose_lock_was_broken_never_deletes_the_successors_lock() {
    let (_t, home) = setup();
    let store = Store::new(&home);
    let h = home.clone();
    let mut ctx = ApplyCtx::at(NOW);
    ctx.before_commit = Some(Box::new(move || {
        let owner = json!({"token":"successor0001","pid":2,"ts":now_ms()});
        fs::write(h.join("store.lock/owner.json"), owner.to_string()).unwrap();
    }));
    let r = store.apply(&json!({"op":"add","id":"t1","title":"x"}), ctx).unwrap();
    assert_eq!(r.rev, 1);
    let owner = read_json(&home.join("store.lock/owner.json"));
    assert_eq!(owner["token"], "successor0001", "foreign lock left in place");
}

#[test]
fn own_lock_records_token_pid_and_ts_while_held() {
    let (_t, home) = setup();
    let store = Store::new(&home);
    let h = home.clone();
    let seen: Arc<std::sync::Mutex<Option<Value>>> = Arc::new(std::sync::Mutex::new(None));
    let s = seen.clone();
    let mut ctx = ApplyCtx::at(NOW);
    ctx.before_commit = Some(Box::new(move || {
        *s.lock().unwrap() = Some(read_json(&h.join("store.lock/owner.json")));
    }));
    add_with(&store, ctx);
    let owner = seen.lock().unwrap().clone().expect("seam ran");
    let token = owner["token"].as_str().unwrap();
    assert_eq!(token.len(), 12);
    assert!(token.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
    assert_eq!(owner["pid"], std::process::id());
    assert!(now_ms().abs_diff(owner["ts"].as_u64().unwrap()) < 5_000);
}

fn add_with(store: &Store, ctx: ApplyCtx) {
    store.apply(&json!({"op":"add","id":"t1","title":"x"}), ctx).unwrap();
}

#[test]
fn read_never_writes_or_creates_anything() {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("never-created");
    let r = Store::new(&home).read().unwrap();
    assert_eq!(r.doc.rev, 0);
    assert!(r.doc.items.is_empty());
    assert!(!home.exists(), "reading an absent home creates nothing");

    let (_t2, home2) = setup();
    fs::create_dir_all(&home2).unwrap();
    // Unnormalised file: the read normalises the view but leaves the bytes and mtime alone.
    write_pretty(&home2.join("todos.json"), &doc_json(4, vec![item("b", "B", 9, "2026-01-01T08:01:00.000Z"), item("a", "A", 3, "2026-01-01T08:00:00.000Z")]));
    let bytes = fs::read(home2.join("todos.json")).unwrap();
    let mtime = fs::metadata(home2.join("todos.json")).unwrap().modified().unwrap();
    let r = Store::new(&home2).read().unwrap();
    assert_eq!(r.doc.items[0].id, "a");
    assert_eq!(r.doc.items[0].order, 0);
    assert_eq!(fs::read(home2.join("todos.json")).unwrap(), bytes);
    assert_eq!(fs::metadata(home2.join("todos.json")).unwrap().modified().unwrap(), mtime);
    assert_eq!(names(&home2), vec!["todos.json"]);

    // Even a corrupt file is only reported, never quarantined or touched.
    fs::write(home2.join("todos.json"), "{broken").unwrap();
    assert_eq!(Store::new(&home2).read().unwrap_err().code, ErrorCode::Corrupt);
    assert_eq!(names(&home2), vec!["todos.json"]);
    assert_eq!(fs::read(home2.join("todos.json")).unwrap(), b"{broken");
}

#[test]
fn read_retries_a_torn_file_and_succeeds_when_it_heals() {
    let (_t, home) = setup();
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join("todos.json"), "{\"schemaVersion\":1,\"rev\":3,\"it").unwrap();
    let h = home.clone();
    let healer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(70));
        write_pretty(&h.join("todos.json"), &doc_json(3, vec![]));
    });
    let r = Store::new(&home).read().unwrap();
    assert_eq!(r.doc.rev, 3);
    healer.join().unwrap();
}

#[test]
fn read_reports_corrupt_only_after_three_retries_50ms_apart() {
    let (_t, home) = setup();
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join("todos.json"), "{nope").unwrap();
    let started = Instant::now();
    assert_eq!(Store::new(&home).read().unwrap_err().code, ErrorCode::Corrupt);
    let el = started.elapsed();
    assert!(el >= Duration::from_millis(140), "3 retries x 50 ms, got {el:?}");
    assert!(el < Duration::from_millis(1500));
}

#[test]
fn unsupported_version_is_not_retried() {
    let (_t, home) = setup();
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join("todos.json"), r#"{"schemaVersion":2,"rev":1,"items":[]}"#).unwrap();
    let started = Instant::now();
    assert_eq!(Store::new(&home).read().unwrap_err().code, ErrorCode::UnsupportedVersion);
    assert!(started.elapsed() < Duration::from_millis(100));
}

#[test]
fn io_error_when_todos_json_is_a_directory() {
    let (_t, home) = setup();
    fs::create_dir_all(home.join("todos.json")).unwrap();
    assert_eq!(Store::new(&home).read().unwrap_err().code, ErrorCode::IoError);
    assert_eq!(add(&Store::new(&home), "t1", "x").unwrap_err().code, ErrorCode::IoError);
    assert!(!home.join("store.lock").exists());
    assert_eq!(tmp_files(&home), 0);
}

#[test]
fn a_writer_does_not_quarantine_a_file_that_is_only_transiently_torn() {
    let (_t, home) = setup();
    fs::create_dir_all(&home).unwrap();
    write_pretty(&home.join("todos.json.bak"), &doc_json(1, vec![item("old", "Old", 0, "2026-01-01T08:00:00.000Z")]));
    fs::write(home.join("todos.json"), "{\"schemaVersion\":1,\"rev\":2,\"ite").unwrap();
    let h = home.clone();
    let healer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(60));
        write_pretty(&h.join("todos.json"), &doc_json(2, vec![item("keep", "Keep", 0, "2026-01-01T08:00:00.000Z")]));
    });
    let r = add(&Store::new(&home), "t1", "x").unwrap();
    healer.join().unwrap();
    assert!(r.warnings.is_empty(), "no quarantine for a healed file: {:?}", r.warnings);
    assert_eq!(quarantined(&home).len(), 0);
    let ids: Vec<String> = read_json(&home.join("todos.json"))["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(ids, ["keep", "t1"]);
}

#[test]
fn corrupt_with_valid_bak_and_a_rejected_op_touches_nothing() {
    let (_t, home) = setup();
    fs::create_dir_all(&home).unwrap();
    write_pretty(&home.join("todos.json.bak"), &doc_json(6, vec![item("t1", "One", 0, "2026-01-01T08:00:00.000Z")]));
    fs::write(home.join("todos.json"), "{\"rev\": 9, broken").unwrap();
    let store = Store::new(&home);
    let e = store.apply(&json!({"op":"add","title":""}), ApplyCtx::at(NOW)).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidTitle);
    assert_eq!(fs::read(home.join("todos.json")).unwrap(), b"{\"rev\": 9, broken");
    assert_eq!(quarantined(&home).len(), 0, "no quarantine before the op is known to apply");
    assert!(!home.join("store.lock").exists());
}

#[test]
fn corrupt_restore_quarantines_byte_identical_even_for_non_utf8_and_rewrites_bak_from_the_commit() {
    let (_t, home) = setup();
    fs::create_dir_all(&home).unwrap();
    let bak = doc_json(2, vec![item("t1", "One", 0, "2026-01-01T08:00:00.000Z")]);
    write_pretty(&home.join("todos.json.bak"), &bak);
    let bak_bytes = fs::read(home.join("todos.json.bak")).unwrap();
    let raw: Vec<u8> = b"\xff\xfe{\"rev\" :  41, garbage \x00\x80".to_vec();
    fs::write(home.join("todos.json"), &raw).unwrap();
    let r = add(&Store::new(&home), "t2", "Two").unwrap();
    assert_eq!(r.warnings, vec![Warning::CorruptQuarantined, Warning::RestoredFromBak]);
    assert_eq!(r.rev, 42, "rev = max(bak.rev 2, scraped 41) + 1");
    let q = quarantined(&home);
    assert_eq!(q.len(), 1);
    assert_eq!(fs::read(&q[0]).unwrap(), raw);
    let qname = q[0].file_name().unwrap().to_string_lossy().into_owned();
    let rest = qname.strip_prefix("todos.corrupt-").unwrap().strip_suffix(".json").unwrap();
    let (ts, token) = rest.split_once('-').unwrap();
    assert_eq!(ts.len(), 16, "yyyymmddThhmmssZ: {ts}");
    assert!(ts.as_bytes()[8] == b'T' && ts.ends_with('Z') && ts[..8].bytes().all(|b| b.is_ascii_digit()));
    assert_eq!(token.len(), 12);
    assert_eq!(fs::read(home.join("todos.json.bak")).unwrap(), fs::read(home.join("todos.json")).unwrap(), "bak = the restored commit, never the corrupt bytes");
    assert_ne!(fs::read(home.join("todos.json.bak")).unwrap(), bak_bytes);
    let doc = read_json(&home.join("todos.json"));
    assert_eq!(doc["rev"], 42);
    assert_eq!(doc["items"].as_array().unwrap().len(), 2);
}

/// Records every rename and checks, before and after each one, that todos.json exists (it did at the start).
struct Watching {
    home: PathBuf,
    absent_at: std::sync::Mutex<Vec<String>>,
    calls: std::sync::Mutex<Vec<(PathBuf, PathBuf)>>,
    fail_to: Option<&'static str>,
}

impl Watching {
    fn new(home: &Path, fail_to: Option<&'static str>) -> Arc<Watching> {
        Arc::new(Watching { home: home.to_path_buf(), absent_at: Default::default(), calls: Default::default(), fail_to })
    }
    fn check(&self, when: &str, from: &Path, to: &Path) {
        if !self.home.join("todos.json").exists() {
            self.absent_at.lock().unwrap().push(format!("{when} rename {} -> {}", from.display(), to.display()));
        }
    }
}

impl Renamer for Watching {
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        self.calls.lock().unwrap().push((from.to_path_buf(), to.to_path_buf()));
        self.check("before", from, to);
        if let Some(suffix) = self.fail_to {
            if to.to_string_lossy().ends_with(suffix) {
                return Err(io::Error::other("injected failure"));
            }
        }
        let r = fs::rename(from, to);
        self.check("after", from, to);
        r
    }
}

#[test]
fn bak_is_a_byte_identical_copy_of_the_latest_commit_written_by_tmp_and_rename() {
    let (_t, home) = setup();
    let w = Watching::new(&home, None);
    let store = Store::new(&home).with_renamer(w.clone());
    add(&store, "t1", "one").unwrap();
    add(&store, "t2", "two").unwrap();
    assert_eq!(fs::read(home.join("todos.json.bak")).unwrap(), fs::read(home.join("todos.json")).unwrap());
    let into_bak: Vec<_> = w.calls.lock().unwrap().iter().filter(|(_, to)| to.ends_with("todos.json.bak")).cloned().collect();
    assert_eq!(into_bak.len(), 2);
    for (from, _) in into_bak {
        assert!(from.file_name().unwrap().to_string_lossy().starts_with(".todos.json.tmp-"), "bak arrives by rename of a temp file: {from:?}");
    }
    assert_eq!(tmp_files(&home), 0);
}

#[test]
fn a_failure_after_the_commit_rename_leaves_the_commit_durable_and_bak_one_version_behind() {
    let (_t, home) = setup();
    add(&Store::new(&home), "t1", "one").unwrap();
    let v1 = fs::read(home.join("todos.json")).unwrap();
    let w = Watching::new(&home, Some("todos.json.bak"));
    let r = add(&Store::new(&home).with_renamer(w), "t2", "two").unwrap();
    assert_eq!(r.rev, 2);
    assert_eq!(read_json(&home.join("todos.json"))["items"].as_array().unwrap().len(), 2);
    assert_eq!(fs::read(home.join("todos.json.bak")).unwrap(), v1);
    assert_eq!(tmp_files(&home), 0, "the unused bak temp file is removed");
    add(&Store::new(&home), "t3", "three").unwrap();
    assert_eq!(fs::read(home.join("todos.json.bak")).unwrap(), fs::read(home.join("todos.json")).unwrap(), "the next commit catches bak up");
}

#[test]
fn restoring_from_bak_after_corruption_loses_no_acknowledged_write_including_the_last_status_flip() {
    let (_t, home) = setup();
    let store = Store::new(&home);
    add(&store, "a", "A").unwrap();
    add(&store, "b", "B").unwrap();
    store.apply(&json!({"op":"set_status","id":"b","status":"in_progress"}), ApplyCtx::at(NOW)).unwrap();
    let live = fs::read(home.join("todos.json")).unwrap();
    let torn = live[..live.len() / 2].to_vec();
    fs::write(home.join("todos.json"), &torn).unwrap();
    let r = add(&store, "c", "C").unwrap();
    assert_eq!(r.warnings, vec![Warning::CorruptQuarantined, Warning::RestoredFromBak]);
    let doc = read_json(&home.join("todos.json"));
    let got: Vec<(String, String)> = doc["items"].as_array().unwrap().iter().map(|i| (i["id"].as_str().unwrap().into(), i["status"].as_str().unwrap().into())).collect();
    assert_eq!(got, [("a".into(), "todo".into()), ("b".into(), "in_progress".into()), ("c".into(), "todo".into())]);
    assert_eq!(fs::read(quarantined(&home)[0].clone()).unwrap(), torn);
    assert_eq!(fs::read(home.join("todos.json.bak")).unwrap(), fs::read(home.join("todos.json")).unwrap());
}

#[test]
fn recovery_never_leaves_todos_json_absent_and_a_crash_before_the_final_rename_keeps_the_corrupt_file() {
    let (_t, home) = setup();
    fs::create_dir_all(&home).unwrap();
    write_pretty(&home.join("todos.json.bak"), &doc_json(4, vec![item("a", "A", 0, "2026-01-01T08:00:00.000Z")]));
    let torn = b"{\"rev\": 9, \"items\":[{\"id\":\"a".to_vec();
    fs::write(home.join("todos.json"), &torn).unwrap();
    let w = Watching::new(&home, None);
    add(&Store::new(&home).with_renamer(w.clone()), "b", "B").unwrap();
    assert_eq!(*w.absent_at.lock().unwrap(), Vec::<String>::new(), "todos.json present around every rename");

    // crash simulation: the final rename (and only it) fails
    let (_t2, home2) = setup();
    fs::create_dir_all(&home2).unwrap();
    write_pretty(&home2.join("todos.json.bak"), &doc_json(4, vec![item("a", "A", 0, "2026-01-01T08:00:00.000Z")]));
    fs::write(home2.join("todos.json"), &torn).unwrap();
    let w2 = Watching::new(&home2, Some("/todos.json"));
    let e = add(&Store::new(&home2).with_renamer(w2.clone()), "b", "B").unwrap_err();
    assert_eq!(e.code, ErrorCode::IoError);
    assert_eq!(fs::read(home2.join("todos.json")).unwrap(), torn, "still there, same bytes");
    assert_eq!(read_json(&home2.join("todos.json.bak"))["rev"], 4);
    assert_eq!(tmp_files(&home2), 0);
    assert!(w2.absent_at.lock().unwrap().is_empty());
    let r = add(&Store::new(&home2), "b", "B").unwrap();
    assert_eq!(r.warnings, vec![Warning::CorruptQuarantined, Warning::RestoredFromBak]);
    for q in quarantined(&home2) {
        assert_eq!(fs::read(q).unwrap(), torn);
    }
}

#[test]
fn restore_always_writes_even_when_the_op_is_a_noop() {
    let (_t, home) = setup();
    fs::create_dir_all(&home).unwrap();
    write_pretty(&home.join("todos.json.bak"), &doc_json(6, vec![item("t1", "One", 0, "2026-01-01T08:00:00.000Z")]));
    fs::write(home.join("todos.json"), "not json at all").unwrap();
    let r = Store::new(&home).apply(&json!({"op":"delete","id":"missing"}), ApplyCtx::at(NOW)).unwrap();
    assert_eq!(r.rev, 7);
    assert!(r.changed, "the file was rewritten and rev advanced");
    assert_eq!(r.warnings, vec![Warning::CorruptQuarantined, Warning::RestoredFromBak]);
    assert_eq!(read_json(&home.join("todos.json"))["rev"], 7);
}

#[test]
fn corrupt_with_an_invalid_bak_is_refused() {
    for bad_bak in ["{also broken", r#"{"schemaVersion":2,"rev":1,"items":[]}"#] {
        let (_t, home) = setup();
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("todos.json.bak"), bad_bak).unwrap();
        fs::write(home.join("todos.json"), "{x").unwrap();
        let e = add(&Store::new(&home), "t1", "x").unwrap_err();
        assert_eq!(e.code, ErrorCode::CorruptNoBackup, "bak {bad_bak}");
        assert_eq!(fs::read(home.join("todos.json")).unwrap(), b"{x");
        assert_eq!(quarantined(&home).len(), 0);
    }
}

#[test]
fn reset_corrupt_uses_the_scraped_rev_and_leaves_no_trace_when_not_corrupt() {
    let (_t, home) = setup();
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join("todos.json"), "{\"schemaVersion\":1,\n \"rev\"\t:\n 17,\"items\":[{").unwrap();
    let store = Store::new(&home);
    let r = store.apply(&json!({"op":"reset_corrupt"}), ApplyCtx::at(NOW)).unwrap();
    assert_eq!(r.rev, 18);
    assert_eq!(r.warnings, vec![Warning::CorruptQuarantined]);
    assert_eq!(r.result, json!({}));
    assert_eq!(quarantined(&home).len(), 1);
    // Healthy now: not_corrupt, nothing written.
    let before = fs::read(home.join("todos.json")).unwrap();
    let e = store.apply(&json!({"op":"reset_corrupt"}), ApplyCtx::at(NOW)).unwrap_err();
    assert_eq!(e.code, ErrorCode::NotCorrupt);
    assert_eq!(fs::read(home.join("todos.json")).unwrap(), before);
    // Absent file is not corrupt either.
    let (_t2, home2) = setup();
    let e = Store::new(&home2).apply(&json!({"op":"reset_corrupt"}), ApplyCtx::at(NOW)).unwrap_err();
    assert_eq!(e.code, ErrorCode::NotCorrupt);
    // Unsupported version is reported as such and is never reset.
    let (_t3, home3) = setup();
    fs::create_dir_all(&home3).unwrap();
    fs::write(home3.join("todos.json"), r#"{"schemaVersion":3,"rev":1,"items":[]}"#).unwrap();
    let e = Store::new(&home3).apply(&json!({"op":"reset_corrupt"}), ApplyCtx::at(NOW)).unwrap_err();
    assert_eq!(e.code, ErrorCode::UnsupportedVersion);
    assert_eq!(quarantined(&home3).len(), 0);
}

#[test]
fn rev_scrape_first_match_and_zero_when_absent() {
    let (_t, home) = setup();
    fs::create_dir_all(&home).unwrap();
    fs::write(home.join("todos.json"), "{ \"rev\": \"x\", \"rev\":5, \"rev\": 9").unwrap();
    let r = Store::new(&home).apply(&json!({"op":"reset_corrupt"}), ApplyCtx::at(NOW)).unwrap();
    assert_eq!(r.rev, 6, "first /\"rev\"\\s*:\\s*(\\d+)/ match wins");
    let (_t2, home2) = setup();
    fs::create_dir_all(&home2).unwrap();
    fs::write(home2.join("todos.json"), "{nope").unwrap();
    assert_eq!(Store::new(&home2).apply(&json!({"op":"reset_corrupt"}), ApplyCtx::at(NOW)).unwrap().rev, 1);
}

#[test]
fn noop_ops_do_not_write_and_report_the_current_rev() {
    let (_t, home) = setup();
    let store = Store::new(&home);
    add(&store, "t1", "x").unwrap();
    let md = || {
        let m = fs::metadata(home.join("todos.json")).unwrap();
        (m.modified().unwrap(), m.len(), fs::read(home.join("todos.json.bak")).ok())
    };
    let before = md();
    std::thread::sleep(Duration::from_millis(20));
    let r = add(&store, "t1", "other").unwrap();
    assert!(!r.changed);
    assert_eq!(r.rev, 1);
    assert_eq!(r.attempts, 1);
    assert_eq!(md(), before);
    assert_eq!(tmp_files(&home), 0);
    assert!(!home.join("store.lock").exists());
}

#[test]
fn generated_id_has_the_contract_shape_and_is_stable_across_retries() {
    let (_t, home) = setup();
    let store = Store::new(&home);
    let h = home.clone();
    let calls = Arc::new(AtomicU32::new(0));
    let mut ctx = ApplyCtx::at(NOW);
    ctx.before_commit = Some(Box::new(move || {
        if calls.fetch_add(1, Ordering::SeqCst) == 0 {
            // a foreign writer commits in between: the engine must retry the SAME op, same id
            write_pretty(&h.join("todos.json"), &doc_json(1, vec![item("f", "F", 0, "2026-01-01T08:00:00.000Z")]));
        }
    }));
    let r = store.apply(&json!({"op":"add","title":"gen"}), ctx).unwrap();
    assert_eq!(r.attempts, 2);
    let id = r.result["item"]["id"].as_str().unwrap().to_string();
    let body = id.strip_prefix("t_").expect("t_ prefix");
    assert!(body.len() > 6 && body.chars().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase()), "{id}");
    let (ms36, _rand) = body.split_at(body.len() - 6);
    let ms = u64::from_str_radix(ms36, 36).unwrap();
    assert!(now_ms().abs_diff(ms) < 60_000, "base36 wall-clock ms: {id}");
    let ids: Vec<&str> = r.doc.items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, ["f", id.as_str()]);
}

#[test]
fn home_resolution() {
    let env = |pairs: &'static [(&'static str, &'static str)]| move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string());
    assert_eq!(home_dir_from(env(&[("TTD_HOME", "/x/y"), ("HOME", "/h"), ("USERPROFILE", "C:\\u")])), Some(PathBuf::from("/x/y")));
    assert_eq!(home_dir_from(env(&[("TTD_HOME", ""), ("HOME", "/h")])), Some(PathBuf::from("/h/.ttd")));
    assert_eq!(home_dir_from(env(&[("USERPROFILE", "C:\\Users\\k"), ("HOME", "/h")])), Some(PathBuf::from("C:\\Users\\k").join(".ttd")));
    assert_eq!(home_dir_from(env(&[("USERPROFILE", ""), ("HOME", "/h")])), Some(PathBuf::from("/h/.ttd")));
    assert_eq!(home_dir_from(env(&[("HOME", "~")])), Some(PathBuf::from("~/.ttd")), "no ~ expansion");
    assert_eq!(home_dir_from(env(&[])), None);
}

#[test]
fn options_from_env_overrides() {
    let env = |k: &str| match k {
        "TTD_LOCK_TIMEOUT_MS" => Some("1234".to_string()),
        "TTD_LOCK_STALE_MS" => Some("567".to_string()),
        _ => None,
    };
    let o = Options::from_env_fn(env);
    assert_eq!(o.lock_timeout, Duration::from_millis(1234));
    assert_eq!(o.lock_stale, Duration::from_millis(567));
    let o = Options::from_env_fn(|k| if k == "TTD_LOCK_STALE_MS" { Some("junk".into()) } else { Some(String::new()) });
    assert_eq!(o, Options::default());
    assert_eq!(Options::default().lock_timeout, Duration::from_millis(5000));
    assert_eq!(Options::default().lock_stale, Duration::from_millis(15000));
}

#[test]
fn envelopes_have_the_contract_shape() {
    let (_t, home) = setup();
    let store = Store::new(&home);
    let ok = store.apply_json(&json!({"op":"add","id":"t1","title":"x"}), ApplyCtx::at(NOW));
    let keys: std::collections::BTreeSet<&str> = ok.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["attempts", "changed", "doc", "ok", "result", "rev", "warnings"].into_iter().collect());
    let err = store.apply_json(&json!({"op":"frob"}), ApplyCtx::at(NOW));
    assert_eq!(err["ok"], false);
    assert_eq!(err["error"], "invalid_op");
    let rd = store.read_json();
    assert_eq!(rd["ok"], true);
    assert_eq!(rd["warnings"], json!([]));
    assert_eq!(rd["doc"]["rev"], 1);
    // io_error carries a message
    // a regular file in the middle of the path: neither the home nor the lock can be created
    let bad = Store::new(home.join("todos.json").join("x"));
    let e = bad.apply_json(&json!({"op":"add","title":"x"}), ApplyCtx::at(NOW));
    assert_eq!(e["error"], "io_error");
    assert!(e["message"].is_string());
}

#[test]
fn invalid_now_is_rejected_without_writing() {
    let (_t, home) = setup();
    let store = Store::new(&home);
    for bad in ["yesterday", "2026-01-01", "2026-01-01T09:00:00Z", "2026-01-01T09:00:00.000+01:00", ""] {
        let e = store.apply(&json!({"op":"add","title":"x"}), ApplyCtx::at(bad)).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidOp, "now {bad:?}");
    }
    assert!(!home.join("todos.json").exists());
}

#[test]
fn a_file_with_a_lone_surrogate_escape_is_read_and_written_not_quarantined() {
    let (_t, home) = setup();
    fs::create_dir_all(&home).unwrap();
    let text = r#"{"schemaVersion":1,"rev":4,"items":[{"id":"t1","title":"half \ud83d","body":"","status":"todo","order":0,"createdAt":"2026-01-01T08:00:00.000Z","updatedAt":"2026-01-01T08:00:00.000Z"}]}"#;
    fs::write(home.join("todos.json"), text).unwrap();
    let store = Store::new(&home);
    assert_eq!(store.read().unwrap().doc.items.len(), 1);
    let r = add(&store, "t2", "x").unwrap();
    assert!(r.warnings.is_empty());
    assert_eq!(r.rev, 5);
    assert_eq!(quarantined(&home).len(), 0);
    assert_eq!(fs::read(home.join("todos.json.bak")).unwrap(), fs::read(home.join("todos.json")).unwrap(), "bak = the new commit");
}

#[test]
fn reset_corrupt_with_a_valid_bak_restores_it_like_the_ts_core() {
    let (_t, home) = setup();
    fs::create_dir_all(&home).unwrap();
    let mut bak = doc_json(6, vec![item("t1", "One", 0, "2026-01-01T08:00:00.000Z"), item("t2", "Two", 1, "2026-01-01T08:01:00.000Z")]);
    bak["meta"] = json!({"keep": true});
    write_pretty(&home.join("todos.json.bak"), &bak);
    let bak_bytes = fs::read(home.join("todos.json.bak")).unwrap();
    fs::write(home.join("todos.json"), "{\"rev\": 9, torn").unwrap();
    let store = Store::new(&home);
    let r = store.apply(&json!({"op":"reset_corrupt"}), ApplyCtx::at(NOW)).unwrap();
    assert!(r.changed);
    assert_eq!(r.rev, 10, "max(bak.rev 6, scraped 9) + 1");
    assert_eq!(r.result, json!({}));
    assert_eq!(r.warnings, vec![Warning::CorruptQuarantined, Warning::RestoredFromBak]);
    let doc = read_json(&home.join("todos.json"));
    assert_eq!(doc["items"].as_array().unwrap().len(), 2, "items restored, not emptied");
    assert_eq!(doc["meta"], json!({"keep": true}));
    assert_eq!(fs::read(home.join("todos.json.bak")).unwrap(), fs::read(home.join("todos.json")).unwrap(), "bak = the restored commit");
    assert_ne!(fs::read(home.join("todos.json.bak")).unwrap(), bak_bytes);
    assert_eq!(quarantined(&home).len(), 1);
    assert_eq!(store.apply(&json!({"op":"reset_corrupt"}), ApplyCtx::at(NOW)).unwrap_err().code, ErrorCode::NotCorrupt);
}

#[test]
fn a_leading_bom_negative_rev_and_schema_zero_are_corrupt() {
    for (name, text) in [
        ("bom", "\u{feff}{\"schemaVersion\":1,\"rev\":1,\"items\":[]}"),
        ("negative rev", r#"{"schemaVersion":1,"rev":-1,"items":[]}"#),
        ("schema 0", r#"{"schemaVersion":0,"rev":1,"items":[]}"#),
    ] {
        let (_t, home) = setup();
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("todos.json"), text).unwrap();
        assert_eq!(Store::new(&home).read().unwrap_err().code, ErrorCode::Corrupt, "{name}");
        assert_eq!(add(&Store::new(&home), "t1", "x").unwrap_err().code, ErrorCode::CorruptNoBackup, "{name}");
        assert_eq!(fs::read(home.join("todos.json")).unwrap(), text.as_bytes());
    }
}

#[test]
fn only_one_of_many_stale_breakers_wins_repeatedly() {
    // Regression for the stale-break race: a second breaker that judged the same stale owner.json
    // must not rename away the fresh lock of the first breaker's successor.
    for round in 0..15 {
        let (_t, home) = setup();
        fs::create_dir_all(&home).unwrap();
        make_lock(&home, 60_000);
        let store = Store::new(&home).with_options(fast(10_000, 5_000));
        let barrier = Arc::new(Barrier::new(6));
        let handles: Vec<_> = (0..6)
            .map(|i| {
                let (store, barrier) = (store.clone(), barrier.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    store.apply(&json!({"op":"add","title":format!("n{i}")}), ApplyCtx::at(NOW)).unwrap()
                })
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let breakers = results.iter().filter(|r| r.warnings.contains(&Warning::StaleLockBroken)).count();
        assert_eq!(breakers, 1, "round {round}");
        assert_eq!(read_json(&home.join("todos.json"))["rev"], 6, "round {round}: no lost update");
        assert_eq!(count_prefix(&home, "store.lock"), 0, "round {round}");
    }
}

/// Fails every rename of `store.lock` itself (the stale-lock break), so a stale lock can never be broken.
/// After `VALVE` calls it lets renames through so a spinning engine ends the test instead of hanging it.
struct UnbreakableLock {
    calls: AtomicU32,
}
impl UnbreakableLock {
    const VALVE: u32 = 5_000;
}
impl Renamer for UnbreakableLock {
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        if from.file_name().is_some_and(|f| f == "store.lock") && n < Self::VALVE {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "injected"));
        }
        fs::rename(from, to)
    }
}

#[test]
fn unbreakable_stale_lock_times_out_without_busy_spinning() {
    let (_t, home) = setup();
    fs::create_dir_all(&home).unwrap();
    make_lock(&home, 60_000);
    let renamer = Arc::new(UnbreakableLock { calls: AtomicU32::new(0) });
    let store = Store::new(&home).with_options(fast(300, 1_000)).with_renamer(renamer.clone());
    let started = Instant::now();
    let r = add(&store, "t1", "x");
    let elapsed = started.elapsed();
    let calls = renamer.calls.load(Ordering::SeqCst);
    assert!(calls < 200, "break attempts must back off between tries, got {calls} renames in {elapsed:?}");
    assert_eq!(r.unwrap_err().code, ErrorCode::LockTimeout);
    assert!(elapsed >= Duration::from_millis(300) && elapsed < Duration::from_millis(2_300), "elapsed {elapsed:?}");
    assert!(home.join("store.lock").exists(), "the unbreakable lock is left alone");
    assert!(!home.join("store.lock.break").exists(), "the break guard is released");
    assert_eq!(count_prefix(&home, "store.lock.stale-"), 0);
}

#[test]
fn held_break_guard_over_a_stale_lock_times_out_and_leaves_both_alone() {
    let (_t, home) = setup();
    fs::create_dir_all(home.join("store.lock.break")).unwrap();
    make_lock(&home, 60_000);
    let store = Store::new(&home).with_options(fast(300, 60_000_000));
    let started = Instant::now();
    assert_eq!(add(&store, "t1", "x").unwrap_err().code, ErrorCode::LockTimeout);
    assert!(started.elapsed() < Duration::from_millis(2_300));
    assert!(home.join("store.lock").exists() && home.join("store.lock.break").exists());
}
