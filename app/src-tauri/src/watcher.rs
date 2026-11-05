//! Background thread that turns `ttd_store::Watcher` polls into callbacks (the `store-changed` event).

use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use ttd_store::{Store, WatchConfig, Watcher};

/// Stops and joins the polling thread on drop.
pub struct WatcherHandle {
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl WatcherHandle {
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for WatcherHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Spawn the poller. `on_change` gets the read envelope for the initial state and every later change.
pub fn spawn(store: Store, cfg: WatchConfig, on_change: impl FnMut(Value) + Send + 'static) -> WatcherHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    let join = std::thread::Builder::new()
        .name("ttd-watcher".into())
        .spawn(move || Watcher::new(store, cfg).run(&flag, on_change))
        .expect("spawn watcher thread");
    WatcherHandle { stop, join: Some(join) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::mpsc::{channel, Receiver};
    use std::time::Duration;

    const WAIT: Duration = Duration::from_secs(10);

    fn cfg() -> WatchConfig {
        WatchConfig { interval: Duration::from_millis(20), force_read_every: Duration::from_millis(200) }
    }

    /// `target/debug/ttd-store`, built on demand (a bin of another package has no CARGO_BIN_EXE_*).
    fn store_bin() -> PathBuf {
        let exe = std::env::current_exe().unwrap();
        let debug_dir = exe.parent().and_then(Path::parent).expect("target/<profile>/deps/<test exe>").to_path_buf();
        let bin = debug_dir.join(if cfg!(windows) { "ttd-store.exe" } else { "ttd-store" });
        if !bin.exists() {
            let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
            let ok = Command::new(cargo).args(["build", "-p", "ttd-store"]).status().unwrap().success();
            assert!(ok && bin.exists(), "cannot build {}", bin.display());
        }
        bin
    }

    fn child_apply(home: &Path, op: &str) {
        let out = Command::new(store_bin()).args(["apply", op]).env("TTD_HOME", home).output().unwrap();
        assert!(out.status.success(), "apply failed: {}", String::from_utf8_lossy(&out.stdout));
    }

    fn titles(v: &Value) -> Vec<String> {
        v["doc"]["items"].as_array().map(|a| a.iter().map(|i| i["title"].as_str().unwrap().to_string()).collect()).unwrap_or_default()
    }

    /// Next message whose titles equal `want`; earlier ones are skipped.
    fn expect_titles(rx: &Receiver<Value>, want: &[&str]) -> Value {
        let deadline = std::time::Instant::now() + WAIT;
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            let v = rx.recv_timeout(left).unwrap_or_else(|_| panic!("no store-changed with titles {want:?} within {WAIT:?}"));
            if v["ok"] == true && titles(&v) == want {
                return v;
            }
        }
    }

    #[test]
    fn publishes_initial_state_then_a_change_made_by_a_child_ttd_store() {
        let tmp = tempfile::tempdir().unwrap();
        let (tx, rx) = channel();
        let _w = spawn(Store::new(tmp.path()), cfg(), move |v| {
            let _ = tx.send(v);
        });
        expect_titles(&rx, &[]);
        child_apply(tmp.path(), r#"{"op":"add","title":"from child"}"#);
        let v = expect_titles(&rx, &["from child"]);
        assert_eq!(v["doc"]["items"][0]["status"], "todo");
    }

    #[test]
    fn detects_an_atomic_rename_replace() {
        let tmp = tempfile::tempdir().unwrap();
        child_apply(tmp.path(), r#"{"op":"add","title":"old"}"#);
        let (tx, rx) = channel();
        let _w = spawn(Store::new(tmp.path()), cfg(), move |v| {
            let _ = tx.send(v);
        });
        expect_titles(&rx, &["old"]);
        let todos = tmp.path().join("todos.json");
        let swapped = std::fs::read_to_string(&todos).unwrap().replace("old", "new");
        let tmp_file = tmp.path().join("todos.json.swap");
        std::fs::write(&tmp_file, swapped).unwrap();
        std::fs::rename(&tmp_file, &todos).unwrap();
        expect_titles(&rx, &["new"]);
    }

    #[test]
    fn unchanged_file_publishes_nothing_more() {
        let tmp = tempfile::tempdir().unwrap();
        let (tx, rx) = channel();
        let _w = spawn(Store::new(tmp.path()), cfg(), move |v| {
            let _ = tx.send(v);
        });
        expect_titles(&rx, &[]);
        assert!(rx.recv_timeout(Duration::from_millis(700)).is_err(), "forced reads must not republish identical state");
    }

    #[test]
    fn dropping_the_handle_stops_the_thread() {
        let tmp = tempfile::tempdir().unwrap();
        let (tx, rx) = channel();
        let w = spawn(Store::new(tmp.path()), cfg(), move |v| {
            let _ = tx.send(v);
        });
        expect_titles(&rx, &[]);
        drop(w);
        child_apply(tmp.path(), r#"{"op":"add","title":"after stop"}"#);
        assert!(rx.recv_timeout(Duration::from_millis(500)).is_err());
    }
}
