//! CLI contract (STORE.md section 9) against the real binary, plus real multi-process concurrency.

mod common;

use common::*;
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ttd-store");
const NOW: &str = "2026-01-01T09:00:00.000Z";

struct Out {
    code: i32,
    stdout: String,
    stderr: String,
}

impl Out {
    fn json(&self) -> Value {
        let lines: Vec<&str> = self.stdout.lines().collect();
        assert_eq!(lines.len(), 1, "exactly one JSON document per line, got {:?}", self.stdout);
        serde_json::from_str(lines[0]).unwrap_or_else(|e| panic!("stdout is not JSON ({e}): {:?}", self.stdout))
    }
}

fn cmd(home: &Path, args: &[&str]) -> Command {
    let mut c = Command::new(BIN);
    c.args(args)
        .env("TTD_HOME", home)
        .env_remove("TTD_LOCK_TIMEOUT_MS")
        .env_remove("TTD_LOCK_STALE_MS")
        .stdin(Stdio::null());
    c
}

fn run(home: &Path, args: &[&str]) -> Out {
    run_env(home, args, &[])
}

fn run_env(home: &Path, args: &[&str], env: &[(&str, &str)]) -> Out {
    let mut c = cmd(home, args);
    for (k, v) in env {
        c.env(k, v);
    }
    let o = c.output().expect("spawn ttd-store");
    Out { code: o.status.code().unwrap_or(-1), stdout: String::from_utf8(o.stdout).unwrap(), stderr: String::from_utf8(o.stderr).unwrap() }
}

fn home() -> (tempfile::TempDir, std::path::PathBuf) {
    let t = tempfile::tempdir().unwrap();
    let h = t.path().join("home");
    (t, h)
}

#[test]
fn read_of_an_absent_file_is_the_empty_doc_and_creates_nothing() {
    let (_t, h) = home();
    let o = run(&h, &["read"]);
    assert_eq!(o.code, 0, "stderr: {}", o.stderr);
    assert_eq!(o.json(), json!({"ok":true,"doc":{"schemaVersion":1,"rev":0,"items":[]},"warnings":[]}));
    assert!(!h.exists());
}

#[test]
fn apply_add_with_now_prints_the_envelope_and_exits_zero() {
    let (_t, h) = home();
    let o = run(&h, &["apply", r#"{"op":"add","id":"t1","title":"  Write plan  ","body":"b"}"#, "--now", NOW]);
    assert_eq!(o.code, 0, "stderr: {}", o.stderr);
    let v = o.json();
    assert_eq!(v["ok"], true);
    assert_eq!(v["changed"], true);
    assert_eq!(v["rev"], 1);
    assert_eq!(v["attempts"], 1);
    assert_eq!(v["warnings"], json!([]));
    assert_eq!(v["result"]["item"], json!({"id":"t1","title":"Write plan","body":"b","status":"todo","order":0,"createdAt":NOW,"updatedAt":NOW}));
    assert_eq!(v["doc"], read_json(&h.join("todos.json")));
    // read sees it
    let r = run(&h, &["read"]).json();
    assert_eq!(r["doc"]["items"][0]["id"], "t1");
}

#[test]
fn now_flag_may_come_first_and_default_is_the_wall_clock() {
    let (_t, h) = home();
    let o = run(&h, &["apply", "--now", NOW, r#"{"op":"add","id":"t1","title":"x"}"#]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert_eq!(o.json()["result"]["item"]["createdAt"], NOW);
    let o = run(&h, &["apply", r#"{"op":"add","id":"t2","title":"y"}"#]);
    let created = o.json()["result"]["item"]["createdAt"].as_str().unwrap().to_string();
    assert!(created.len() == 24 && created.ends_with('Z') && created.as_bytes()[10] == b'T', "{created}");
    assert!(created.as_str() > "2026-01-01T00:00:00.000Z");
}

#[test]
fn error_envelopes_exit_one_with_the_json_on_stdout() {
    let (_t, h) = home();
    let o = run(&h, &["apply", r#"{"op":"add","title":""}"#, "--now", NOW]);
    assert_eq!(o.code, 1);
    assert_eq!(o.json()["ok"], false);
    assert_eq!(o.json()["error"], "invalid_title");

    let o = run(&h, &["apply", "{not json", "--now", NOW]);
    assert_eq!(o.code, 1);
    assert_eq!(o.json()["error"], "invalid_op");

    let o = run(&h, &["apply", r#"{"op":"move","id":"zz","after":null}"#, "--now", NOW]);
    assert_eq!(o.code, 1);
    assert_eq!(o.json()["error"], "not_found");
    assert!(!h.join("todos.json").exists(), "errors never write");
}

#[test]
fn read_of_a_corrupt_or_unsupported_file_exits_one() {
    let (_t, h) = home();
    fs::create_dir_all(&h).unwrap();
    fs::write(h.join("todos.json"), "{x").unwrap();
    let o = run(&h, &["read"]);
    assert_eq!(o.code, 1);
    assert_eq!(o.json(), json!({"ok":false,"error":"corrupt"}));
    assert_eq!(fs::read(h.join("todos.json")).unwrap(), b"{x", "read never modifies");
    fs::write(h.join("todos.json"), r#"{"schemaVersion":2,"rev":1,"items":[]}"#).unwrap();
    let o = run(&h, &["read"]);
    assert_eq!(o.code, 1);
    assert_eq!(o.json()["error"], "unsupported_version");
}

#[test]
fn reset_corrupt_through_the_cli() {
    let (_t, h) = home();
    fs::create_dir_all(&h).unwrap();
    fs::write(h.join("todos.json"), "{\"rev\":4,oops").unwrap();
    let o = run(&h, &["apply", r#"{"op":"add","title":"x"}"#]);
    assert_eq!(o.code, 1);
    assert_eq!(o.json()["error"], "corrupt_no_backup");
    let o = run(&h, &["apply", r#"{"op":"reset_corrupt"}"#]);
    assert_eq!(o.code, 0);
    let v = o.json();
    assert_eq!(v["rev"], 5);
    assert_eq!(v["warnings"], json!(["corrupt_quarantined"]));
    assert_eq!(v["result"], json!({}));
    assert_eq!(quarantined(&h).len(), 1);
}

#[test]
fn usage_errors_exit_two_with_stdout_clean() {
    let (_t, h) = home();
    for args in [vec![], vec!["frobnicate"], vec!["apply"], vec!["apply", "{}", "--now"], vec!["apply", "{}", "--bogus", "1"], vec!["read", "extra"], vec!["watch", "--interval-ms", "abc"], vec!["watch", "--max-events"]] {
        let o = run(&h, &args);
        assert_eq!(o.code, 2, "args {args:?}: stdout={:?} stderr={:?}", o.stdout, o.stderr);
        assert_eq!(o.stdout, "", "args {args:?}");
        assert!(!o.stderr.is_empty(), "usage goes to stderr for {args:?}");
    }
    assert!(!h.exists());
}

#[test]
fn invalid_now_flag_is_an_invalid_op_envelope() {
    let (_t, h) = home();
    let o = run(&h, &["apply", r#"{"op":"add","title":"x"}"#, "--now", "tomorrow"]);
    assert_eq!(o.code, 1);
    assert_eq!(o.json()["error"], "invalid_op");
    assert!(!h.exists());
}

#[test]
fn ttd_home_unset_falls_back_to_home_dot_ttd() {
    let t = tempfile::tempdir().unwrap();
    let o = Command::new(BIN)
        .args(["apply", r#"{"op":"add","id":"t1","title":"x"}"#])
        .env_remove("TTD_HOME")
        .env_remove("USERPROFILE")
        .env("HOME", t.path())
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(0), "{}", String::from_utf8_lossy(&o.stderr));
    assert_eq!(read_json(&t.path().join(".ttd/todos.json"))["rev"], 1);
}

#[test]
fn lock_env_overrides() {
    let (_t, h) = home();
    fs::create_dir_all(&h).unwrap();
    // A crashed writer's lock, 2 s old.
    make_lock(&h, 2_000);
    // Default stale (15 s): not stale, so a short timeout expires and the lock stays.
    let o = run_env(&h, &["apply", r#"{"op":"add","id":"t1","title":"x"}"#], &[("TTD_LOCK_TIMEOUT_MS", "300")]);
    assert_eq!(o.code, 1);
    assert_eq!(o.json()["error"], "lock_timeout");
    assert!(h.join("store.lock").exists());
    // TTD_LOCK_STALE_MS=500: the same lock is now stale and gets broken.
    let o = run_env(&h, &["apply", r#"{"op":"add","id":"t1","title":"x"}"#], &[("TTD_LOCK_STALE_MS", "500")]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert_eq!(o.json()["warnings"], json!(["stale_lock_broken"]));
    assert!(!h.join("store.lock").exists());
}

fn read_lines(child: &mut std::process::Child) -> BufReader<std::process::ChildStdout> {
    BufReader::new(child.stdout.take().unwrap())
}

fn next_line(r: &mut BufReader<std::process::ChildStdout>) -> Value {
    let mut s = String::new();
    let n = r.read_line(&mut s).unwrap();
    assert!(n > 0, "watch closed stdout early");
    serde_json::from_str(s.trim()).unwrap_or_else(|e| panic!("bad watch line {s:?}: {e}"))
}

#[test]
fn watch_max_events_two_while_another_process_applies() {
    let (_t, h) = home();
    let mut w = cmd(&h, &["watch", "--interval-ms", "50", "--max-events", "2", "--timeout-ms", "15000"]).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut out = read_lines(&mut w);
    let first = next_line(&mut out);
    assert_eq!(first["rev"], 0);
    assert_eq!(first["count"], 0);
    assert!(first["at"].as_u64().unwrap().abs_diff(now_ms()) < 10_000, "at = epoch ms");
    assert_eq!(first.as_object().unwrap().len(), 3, "exactly rev, at, count");

    let a = run(&h, &["apply", r#"{"op":"add","id":"t1","title":"x"}"#, "--now", NOW]);
    assert_eq!(a.code, 0, "{}", a.stderr);
    let second = next_line(&mut out);
    assert_eq!(second["rev"], 1);
    assert_eq!(second["count"], 1);
    let status = w.wait().unwrap();
    assert_eq!(status.code(), Some(0), "exit 0 after N events");
}

#[test]
fn watch_timeout_exits_zero_after_the_initial_event_only() {
    let (_t, h) = home();
    let started = Instant::now();
    let o = run(&h, &["watch", "--interval-ms", "50", "--timeout-ms", "400"]);
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert_eq!(o.stdout.lines().count(), 1, "{:?}", o.stdout);
    assert_eq!(o.json()["rev"], 0);
    let el = started.elapsed();
    assert!(el >= Duration::from_millis(380) && el < Duration::from_secs(5), "{el:?}");
}

#[test]
fn watch_reports_existing_state_first() {
    let (_t, h) = home();
    run(&h, &["apply", r#"{"op":"add","id":"a","title":"a"}"#]);
    run(&h, &["apply", r#"{"op":"add","id":"b","title":"b"}"#]);
    let o = run(&h, &["watch", "--max-events", "1", "--timeout-ms", "5000"]);
    assert_eq!(o.code, 0);
    let v = o.json();
    assert_eq!((v["rev"].as_u64(), v["count"].as_u64()), (Some(2), Some(2)));
}

#[test]
fn watch_prints_an_error_line_for_a_corrupt_or_unsupported_file() {
    let (_t, h) = home();
    fs::create_dir_all(&h).unwrap();
    fs::write(h.join("todos.json"), "{broken").unwrap();
    let o = run(&h, &["watch", "--interval-ms", "50", "--max-events", "1", "--timeout-ms", "3000"]);
    assert_eq!(o.code, 0);
    let v = o.json();
    assert_eq!(v["error"], "corrupt");
    assert!(v["at"].as_u64().unwrap().abs_diff(now_ms()) < 10_000);
    assert_eq!(v.as_object().unwrap().len(), 2, "exactly error and at");

    fs::write(h.join("todos.json"), r#"{"schemaVersion":2,"rev":1,"items":[]}"#).unwrap();
    let o = run(&h, &["watch", "--max-events", "1", "--timeout-ms", "3000"]);
    assert_eq!(o.json()["error"], "unsupported_version");
}

#[test]
fn lone_surrogates_in_op_text_are_refused_like_the_ts_core() {
    let (_t, h) = home();
    let title = run(&h, &["apply", r#"{"op":"add","title":"half \ud83d"}"#, "--now", NOW]);
    assert_eq!(title.code, 1);
    assert_eq!(title.json()["error"], "invalid_title");
    let body = run(&h, &["apply", r#"{"op":"add","title":"ok","body":"x\ude00"}"#, "--now", NOW]);
    assert_eq!(body.json()["error"], "invalid_op");
    let id = run(&h, &["apply", r#"{"op":"delete","id":"a\ud800"}"#, "--now", NOW]);
    assert_eq!(id.json()["error"], "invalid_op");
    // a well-formed pair is fine, and so is a lone surrogate in an ignored unknown field
    let ok = run(&h, &["apply", r#"{"op":"add","id":"t1","title":"smile \ud83d\ude00","junk":"\ud83d"}"#, "--now", NOW]);
    assert_eq!(ok.code, 0, "{}", ok.stdout);
    assert_eq!(ok.json()["result"]["item"]["title"], "smile \u{1f600}");
    assert_eq!(std::fs::read(h.join("todos.json.bak")).unwrap(), std::fs::read(h.join("todos.json")).unwrap(), "bak = the latest commit");
    // garbage is still invalid_op with a message
    let junk = run(&h, &["apply", "{nope", "--now", NOW]);
    assert_eq!(junk.json()["error"], "invalid_op");
    assert!(junk.json()["message"].is_string());
}

#[test]
fn message_is_present_only_on_io_error_and_invalid_op() {
    let (_t, h) = home();
    for (op, code, has_message) in [
        (r#"{"op":"frob"}"#, "invalid_op", true),
        (r#"{"op":"add","title":""}"#, "invalid_title", false),
        (r#"{"op":"add","title":"x","body":"BODY"}"#, "too_long", false),
        (r#"{"op":"delete","id":"a b"}"#, "invalid_op", true),
        (r#"{"op":"update","id":"nope","title":"x"}"#, "not_found", false),
        (r#"{"op":"reset_corrupt"}"#, "not_corrupt", false),
    ] {
        let op = op.replace("BODY", &"y".repeat(10_001));
        let o = run(&h, &["apply", &op, "--now", NOW]);
        let v = o.json();
        assert_eq!(v["error"], code, "{op:.60}");
        assert_eq!(v.get("message").is_some(), has_message, "{code}: {v}");
    }
}

#[test]
fn four_processes_times_25_adds_lose_nothing() {
    let (_t, h) = home();
    let handles: Vec<_> = (0..4)
        .map(|p| {
            let h = h.clone();
            std::thread::spawn(move || {
                for n in 0..25 {
                    let op = json!({"op":"add","title":format!("p{p}-n{n}")}).to_string();
                    let o = run_env(&h, &["apply", &op], &[("TTD_LOCK_TIMEOUT_MS", "20000")]);
                    assert_eq!(o.code, 0, "p{p} n{n}: {} / {}", o.stdout, o.stderr);
                }
            })
        })
        .collect();
    for t in handles {
        t.join().unwrap();
    }
    let doc = read_json(&h.join("todos.json"));
    assert_eq!(doc["rev"], 100);
    let items = doc["items"].as_array().unwrap();
    assert_eq!(items.len(), 100);
    let titles: std::collections::HashSet<&str> = items.iter().map(|i| i["title"].as_str().unwrap()).collect();
    assert_eq!(titles.len(), 100, "100 distinct titles");
    let orders: Vec<i64> = items.iter().map(|i| i["order"].as_i64().unwrap()).collect();
    assert_eq!(orders, (0..100).collect::<Vec<i64>>());
    // per-process order is preserved (each process appended sequentially)
    for p in 0..4 {
        let pos: Vec<usize> = (0..25).map(|n| items.iter().position(|i| i["title"] == format!("p{p}-n{n}").as_str()).unwrap()).collect();
        assert!(pos.windows(2).all(|w| w[0] < w[1]), "p{p} order");
    }
    let r = run(&h, &["read"]);
    assert_eq!(r.code, 0);
    assert!(!h.join("store.lock").exists());
    assert_eq!(tmp_files(&h), 0);
    assert_eq!(quarantined(&h).len(), 0);
    assert_eq!(count_prefix(&h, "store.lock"), 0);
}

#[test]
fn concurrent_readers_never_see_a_torn_file_while_writers_run() {
    let (_t, h) = home();
    fs::create_dir_all(&h).unwrap();
    let hw = h.clone();
    let writer = std::thread::spawn(move || {
        for n in 0..30 {
            let op = json!({"op":"add","title":format!("w{n}")}).to_string();
            assert_eq!(run(&hw, &["apply", &op]).code, 0);
        }
    });
    let mut last = 0;
    while !writer.is_finished() {
        let o = run(&h, &["read"]);
        assert_eq!(o.code, 0, "reader saw a bad file: {}", o.stdout);
        let rev = o.json()["doc"]["rev"].as_u64().unwrap();
        assert!(rev >= last, "rev never goes backwards");
        last = rev;
    }
    writer.join().unwrap();
}
