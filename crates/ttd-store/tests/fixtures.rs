//! Shared contract harness (STORE.md section 11): every docs/contract/fixtures/*.json against the
//! real engine in a fresh temp TTD_HOME.

mod common;

use common::*;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use ttd_store::{ApplyCtx, Options, Store};

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/contract/fixtures")
}

fn load(prefix: &str) -> (String, Value) {
    let dir = fixtures_dir();
    let mut found: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()))
        .map(|e| e.unwrap().path())
        .filter(|p| {
            let n = p.file_name().unwrap().to_string_lossy().into_owned();
            n.starts_with(&format!("{prefix}-")) && n.ends_with(".json")
        })
        .collect();
    assert_eq!(found.len(), 1, "exactly one fixture {prefix}-*.json expected");
    let p = found.remove(0);
    let v: Value = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
    (p.file_name().unwrap().to_string_lossy().into_owned(), v)
}

fn is_raw(v: &Value) -> Option<&str> {
    let o = v.as_object()?;
    if o.len() == 1 {
        o.get("raw")?.as_str()
    } else {
        None
    }
}

fn materialise(path: &Path, v: &Value) {
    if v.is_null() {
        return;
    }
    if let Some(raw) = is_raw(v) {
        fs::write(path, raw).unwrap();
    } else {
        write_pretty(path, v);
    }
}

/// (inode, mtime, bytes) of todos.json, or None when absent.
fn snapshot(path: &Path) -> Option<(u64, std::time::SystemTime, Vec<u8>)> {
    let md = fs::metadata(path).ok()?;
    #[cfg(unix)]
    let ino = std::os::unix::fs::MetadataExt::ino(&md);
    #[cfg(not(unix))]
    let ino = 0;
    Some((ino, md.modified().unwrap(), fs::read(path).unwrap()))
}

fn run(prefix: &str) {
    let (file_name, fx) = load(prefix);
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("ttd-home");
    fs::create_dir_all(&home).unwrap();
    let todos = home.join("todos.json");
    let bak = home.join("todos.json.bak");

    let setup = &fx["setup"];
    materialise(&todos, &setup["file"]);
    materialise(&bak, &setup["bak"]);
    if let Some(age) = setup["lock"]["ownerAgeMs"].as_u64() {
        make_lock(&home, age);
    }

    let mut opts = Options::default();
    if let Some(o) = fx.get("options") {
        if let Some(ms) = o.get("lockTimeoutMs").and_then(Value::as_u64) {
            opts.lock_timeout = Duration::from_millis(ms);
        }
        if let Some(ms) = o.get("lockStaleMs").and_then(Value::as_u64) {
            opts.lock_stale = Duration::from_millis(ms);
        }
    }
    let store = Store::new(&home).with_options(opts);

    for (i, step) in fx["steps"].as_array().unwrap().iter().enumerate() {
        let label = format!("{file_name} step {}", i + 1);
        let before = snapshot(&todos);
        let envelope = if step.get("read").and_then(Value::as_bool) == Some(true) {
            store.read_json()
        } else {
            let mut ctx = ApplyCtx::at(step["now"].as_str().unwrap());
            if let Some(replace) = step.get("seam").and_then(|s| s.get("beforeCommit")).and_then(|b| b.get("replaceFile")) {
                let replace = replace.clone();
                let path = todos.clone();
                let mut fired = false;
                ctx.before_commit = Some(Box::new(move || {
                    if !fired {
                        fired = true;
                        write_pretty(&path, &replace);
                    }
                }));
            }
            store.apply_json(&step["op"], ctx)
        };

        let expect = step["expect"].as_object().unwrap();
        let ok = expect["ok"].as_bool().unwrap();
        assert_eq!(envelope["ok"], Value::Bool(ok), "{label}: ok; envelope = {envelope}");
        if ok {
            for key in ["changed", "rev", "result", "attempts", "doc"] {
                if let Some(want) = expect.get(key) {
                    assert_eq!(&envelope[key], want, "{label}: {key}; envelope = {envelope}");
                }
            }
            let want_warnings = expect.get("warnings").cloned().unwrap_or(Value::Array(vec![]));
            assert_eq!(envelope["warnings"], want_warnings, "{label}: warnings");
            if expect.get("changed") == Some(&Value::Bool(false)) {
                assert_eq!(snapshot(&todos), before, "{label}: changed:false must not touch todos.json");
            }
        } else {
            assert_eq!(&envelope["error"], &expect["error"], "{label}: error; envelope = {envelope}");
            // Every error except the corrupt-handling ops must leave todos.json exactly as found.
            let op_name = step["op"]["op"].as_str().unwrap_or("");
            if op_name != "reset_corrupt" {
                assert_eq!(snapshot(&todos), before, "{label}: error must not touch todos.json");
            }
        }
    }

    let fin = &fx["final"];
    match &fin["file"] {
        Value::String(s) if s == "absent" => assert!(!todos.exists(), "{file_name}: todos.json must be absent"),
        v => match is_raw(v) {
            Some(raw) => assert_eq!(fs::read_to_string(&todos).unwrap(), raw, "{file_name}: final raw"),
            None => assert_eq!(&read_json(&todos), v, "{file_name}: final file"),
        },
    }
    if let Some(b) = fin.get("bakExists").and_then(Value::as_bool) {
        assert_eq!(bak.exists(), b, "{file_name}: bakExists");
    }
    let q = quarantined(&home);
    assert_eq!(q.len() as u64, fin["quarantined"].as_u64().unwrap(), "{file_name}: quarantined count");
    if let Some(raws) = fin.get("quarantinedRaw").and_then(Value::as_array) {
        let mut got: Vec<String> = q.iter().map(|p| fs::read_to_string(p).unwrap()).collect();
        let mut want: Vec<String> = raws.iter().map(|r| r.as_str().unwrap().to_string()).collect();
        got.sort();
        want.sort();
        assert_eq!(got, want, "{file_name}: quarantined bytes");
    }
    assert_eq!(home.join("store.lock").exists(), fin["lockDir"].as_bool().unwrap(), "{file_name}: lockDir");
    assert_eq!(tmp_files(&home) as u64, fin["tmpFiles"].as_u64().unwrap(), "{file_name}: tmpFiles");
    assert_eq!(count_prefix(&home, "store.lock.stale-"), 0, "{file_name}: stale lock dirs must be removed");
}

macro_rules! fixture_tests {
    ($($name:ident => $prefix:literal),* $(,)?) => { $( #[test] fn $name() { run($prefix); } )* };
}

fixture_tests! {
    fixture_01_add_status_update_delete => "01",
    fixture_02_move_relative => "02",
    fixture_03_idempotent_and_not_found => "03",
    fixture_04_validation_limits => "04",
    fixture_05_conflict_lost_update => "05",
    fixture_06_corrupt_restore_from_bak => "06",
    fixture_07_corrupt_no_backup_refuse_then_reset => "07",
    fixture_08_unsupported_schema_version => "08",
    fixture_09_unknown_fields_preserved => "09",
    fixture_10_stale_lock_broken => "10",
    fixture_11_fresh_lock_times_out => "11",
    fixture_12_read_normalises_order => "12",
    fixture_13_read_absent_file => "13",
}

#[test]
fn all_thirteen_fixtures_are_wired() {
    let n = fs::read_dir(fixtures_dir())
        .unwrap()
        .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".json"))
        .count();
    assert_eq!(n, 13, "a fixture was added: wire it into fixture_tests!");
}
