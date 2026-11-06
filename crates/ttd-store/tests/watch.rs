//! Change detection (STORE.md section 7): stat poll, forced read every 2 s, publish only when the
//! normalised JSON differs.

mod common;

use common::*;
use serde_json::{json, Value};
use std::fs;
use std::time::{Duration, Instant, SystemTime};
use ttd_store::{ApplyCtx, Store, WatchConfig, Watcher};

fn poll_for(w: &mut Watcher, max: Duration) -> Option<Value> {
    let end = Instant::now() + max;
    loop {
        if let Some(v) = w.poll() {
            return Some(v);
        }
        if Instant::now() >= end {
            return None;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
}

fn fresh() -> (tempfile::TempDir, std::path::PathBuf, Watcher) {
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let w = Watcher::new(Store::new(&home), WatchConfig::default());
    (t, home, w)
}

#[test]
fn defaults_match_the_contract() {
    let c = WatchConfig::default();
    assert_eq!(c.interval, Duration::from_millis(400));
    assert_eq!(c.force_read_every, Duration::from_secs(2));
}

#[test]
fn first_poll_publishes_the_initial_state_then_quiet() {
    let (_t, _home, mut w) = fresh();
    let first = w.poll().expect("initial state is published");
    assert_eq!(first["ok"], true);
    assert_eq!(first["doc"]["rev"], 0);
    assert!(w.poll().is_none());
    assert!(poll_for(&mut w, Duration::from_millis(200)).is_none(), "no change, no event");
}

#[test]
fn detects_in_place_write() {
    let (_t, home, mut w) = fresh();
    write_pretty(&home.join("todos.json"), &doc_json(1, vec![item("a", "A", 0, "2026-01-01T08:00:00.000Z")]));
    w.poll().unwrap();
    // truncate-and-write in place: same inode, different size
    write_pretty(&home.join("todos.json"), &doc_json(2, vec![item("a", "A", 0, "2026-01-01T08:00:00.000Z"), item("b", "B", 1, "2026-01-01T08:01:00.000Z")]));
    let v = poll_for(&mut w, Duration::from_secs(1)).expect("in-place write detected");
    assert_eq!(v["doc"]["rev"], 2);
}

#[test]
fn detects_rename_replace() {
    let (_t, home, mut w) = fresh();
    write_pretty(&home.join("todos.json"), &doc_json(1, vec![]));
    w.poll().unwrap();
    write_pretty(&home.join(".stage"), &doc_json(2, vec![item("a", "A", 0, "2026-01-01T08:00:00.000Z")]));
    fs::rename(home.join(".stage"), home.join("todos.json")).unwrap();
    let v = poll_for(&mut w, Duration::from_secs(1)).expect("rename-replace detected");
    assert_eq!(v["doc"]["rev"], 2);
}

#[test]
fn detects_delete_and_recreate() {
    let (_t, home, mut w) = fresh();
    let doc = doc_json(5, vec![item("a", "A", 0, "2026-01-01T08:00:00.000Z")]);
    write_pretty(&home.join("todos.json"), &doc);
    w.poll().unwrap();
    fs::remove_file(home.join("todos.json")).unwrap();
    let gone = poll_for(&mut w, Duration::from_secs(1)).expect("deletion detected");
    assert_eq!(gone["doc"]["rev"], 0, "absent file reads as the empty doc");
    assert_eq!(gone["doc"]["items"], json!([]));
    write_pretty(&home.join("todos.json"), &doc);
    let back = poll_for(&mut w, Duration::from_secs(1)).expect("recreation detected");
    assert_eq!(back["doc"]["rev"], 5);
}

#[test]
fn forced_read_every_two_seconds_catches_a_change_the_stat_cannot_see() {
    let (_t, home, mut w) = fresh();
    let path = home.join("todos.json");
    write_pretty(&path, &doc_json(1, vec![item("a", "AAA", 0, "2026-01-01T08:00:00.000Z")]));
    let mtime: SystemTime = fs::metadata(&path).unwrap().modified().unwrap();
    w.poll().unwrap();
    // Same size, same mtime, different bytes.
    write_pretty(&path, &doc_json(1, vec![item("a", "BBB", 0, "2026-01-01T08:00:00.000Z")]));
    let f = fs::OpenOptions::new().write(true).open(&path).unwrap();
    f.set_modified(mtime).unwrap();
    drop(f);
    assert!(poll_for(&mut w, Duration::from_millis(1000)).is_none(), "stat is unchanged, so no read yet");
    let v = poll_for(&mut w, Duration::from_millis(2500)).expect("forced read within ~2 s");
    assert_eq!(v["doc"]["items"][0]["title"], "BBB");
}

#[test]
fn publishes_only_when_the_normalised_json_differs() {
    let (_t, home, mut w) = fresh();
    let path = home.join("todos.json");
    write_pretty(&path, &doc_json(3, vec![item("b", "B", 1, "2026-01-01T08:01:00.000Z"), item("a", "A", 0, "2026-01-01T08:00:00.000Z")]));
    w.poll().unwrap();
    // Different bytes (compact, reordered, renumbered) but the same normalised view.
    let same = doc_json(3, vec![item("a", "A", 7, "2026-01-01T08:00:00.000Z"), item("b", "B", 9, "2026-01-01T08:01:00.000Z")]);
    fs::write(&path, serde_json::to_string(&same).unwrap()).unwrap();
    assert!(poll_for(&mut w, Duration::from_millis(300)).is_none());
}

#[test]
fn own_writes_are_published_like_any_other() {
    let (_t, home, mut w) = fresh();
    w.poll().unwrap();
    Store::new(&home).apply(&json!({"op":"add","id":"x","title":"mine"}), ApplyCtx::at("2026-01-01T09:00:00.000Z")).unwrap();
    let v = poll_for(&mut w, Duration::from_secs(1)).unwrap();
    assert_eq!(v["doc"]["rev"], 1);
    assert_eq!(v["doc"]["items"][0]["title"], "mine");
}

#[test]
fn corrupt_state_is_published_once_as_an_error_envelope() {
    let (_t, home, mut w) = fresh();
    w.poll().unwrap();
    fs::write(home.join("todos.json"), "{broken").unwrap();
    let v = poll_for(&mut w, Duration::from_secs(2)).expect("corrupt reported");
    assert_eq!(v, json!({"ok":false,"error":"corrupt"}));
    assert!(poll_for(&mut w, Duration::from_millis(300)).is_none(), "not republished while unchanged");
}
