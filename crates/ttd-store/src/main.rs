//! `ttd-store` CLI (STORE.md section 9). One JSON document per line on stdout, diagnostics on stderr.
//!
//! ```text
//! ttd-store read
//! ttd-store apply '<op json>' [--now <iso>]
//! ttd-store watch [--interval-ms 400] [--max-events N] [--timeout-ms T]
//! ```
//! Exit codes: 0 ok, 1 error envelope, 2 usage error (nothing on stdout).

use serde_json::{json, Value};
use std::io::Write;
use std::process::ExitCode;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use ttd_store::{parse_op_text, ApplyCtx, ErrorCode, Store, StoreError, WatchConfig, Watcher};

const USAGE: &str = "usage:\n  ttd-store read\n  ttd-store apply '<op json>' [--now <iso>]\n  ttd-store watch [--interval-ms 400] [--max-events N] [--timeout-ms T]\nenv: TTD_HOME, TTD_LOCK_TIMEOUT_MS, TTD_LOCK_STALE_MS";

fn usage(msg: &str) -> ExitCode {
    eprintln!("ttd-store: {msg}\n{USAGE}");
    ExitCode::from(2)
}

/// Print one envelope line; exit 0 if it is ok else 1.
fn emit(envelope: &Value) -> ExitCode {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{envelope}");
    let _ = out.flush();
    if envelope["ok"] == Value::Bool(true) {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

fn store() -> Result<Store, ExitCode> {
    Store::from_env().ok_or_else(|| {
        emit(&StoreError::with_message(ErrorCode::IoError, "cannot resolve the home directory (set TTD_HOME or HOME)").to_envelope());
        ExitCode::from(1)
    })
}

fn flag_value(args: &mut std::vec::IntoIter<String>, name: &str) -> Result<String, String> {
    args.next().ok_or_else(|| format!("{name} needs a value"))
}

fn parse_u64(name: &str, v: &str) -> Result<u64, String> {
    v.parse::<u64>().map_err(|_| format!("{name} needs a non-negative integer, got {v:?}"))
}

fn main() -> ExitCode {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        return usage("missing subcommand");
    }
    let cmd = args.remove(0);
    match cmd.as_str() {
        "read" => {
            if !args.is_empty() {
                return usage("read takes no arguments");
            }
            match store() {
                Ok(s) => emit(&s.read_json()),
                Err(c) => c,
            }
        }
        "apply" => run_apply(args),
        "watch" => run_watch(args),
        other => usage(&format!("unknown subcommand {other:?}")),
    }
}

fn run_apply(args: Vec<String>) -> ExitCode {
    let mut it = args.into_iter();
    let mut op_text: Option<String> = None;
    let mut now: Option<String> = None;
    while let Some(a) = it.next() {
        match a.as_str() {
            "--now" => match flag_value(&mut it, "--now") {
                Ok(v) => now = Some(v),
                Err(m) => return usage(&m),
            },
            f if f.starts_with("--") => return usage(&format!("unknown flag {f}")),
            _ => {
                if op_text.replace(a).is_some() {
                    return usage("apply takes exactly one op argument");
                }
            }
        }
    }
    let Some(op_text) = op_text else { return usage("apply needs an op JSON argument") };
    let store = match store() {
        Ok(s) => s,
        Err(c) => return c,
    };
    let op: Value = match parse_op_text(&op_text) {
        Ok(v) => v,
        Err(e) => return emit(&e.to_envelope()),
    };
    let ctx = ApplyCtx { now, before_commit: None };
    emit(&store.apply_json(&op, ctx))
}

fn run_watch(args: Vec<String>) -> ExitCode {
    let mut cfg = WatchConfig::default();
    let mut max_events: Option<u64> = None;
    let mut timeout: Option<Duration> = None;
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        let parsed = match a.as_str() {
            "--interval-ms" => flag_value(&mut it, &a).and_then(|v| parse_u64(&a, &v)).map(|v| cfg.interval = Duration::from_millis(v.max(1))),
            "--max-events" => flag_value(&mut it, &a).and_then(|v| parse_u64(&a, &v)).map(|v| max_events = Some(v)),
            "--timeout-ms" => flag_value(&mut it, &a).and_then(|v| parse_u64(&a, &v)).map(|v| timeout = Some(Duration::from_millis(v))),
            other => Err(format!("unknown argument {other:?}")),
        };
        if let Err(m) = parsed {
            return usage(&m);
        }
    }
    let store = match store() {
        Ok(s) => s,
        Err(c) => return c,
    };
    let deadline = timeout.map(|t| Instant::now() + t);
    let mut watcher = Watcher::new(store, cfg);
    let mut events = 0u64;
    loop {
        if let Some(envelope) = watcher.poll() {
            let at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            // An unreadable file prints {"error":code,"at":ms} instead of rev/count (shared with the TS CLI).
            let line = match envelope["doc"].as_object() {
                Some(doc) if envelope["ok"] == Value::Bool(true) => json!({ "rev": doc["rev"], "at": at, "count": doc["items"].as_array().map_or(0, Vec::len) }),
                _ => json!({ "error": envelope["error"], "at": at }),
            };
            let mut out = std::io::stdout().lock();
            if writeln!(out, "{line}").and_then(|_| out.flush()).is_err() {
                return ExitCode::SUCCESS; // reader went away
            }
            events += 1;
            if max_events.is_some_and(|n| events >= n) {
                return ExitCode::SUCCESS;
            }
        }
        let pause = match deadline {
            Some(d) => {
                let now = Instant::now();
                if now >= d {
                    return ExitCode::SUCCESS;
                }
                cfg.interval.min(d - now)
            }
            None => cfg.interval,
        };
        std::thread::sleep(pause);
    }
}
