//! Change detection (STORE.md section 7): poll `stat(todos.json)`; when `(mtime, size)` differs from
//! the last poll, or at least every `force_read_every`, read and publish if the normalised JSON
//! differs from the last published one.

use crate::engine::Store;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WatchConfig {
    /// Stat poll period (400 ms).
    pub interval: Duration,
    /// Read at least this often regardless of stat (2 s).
    pub force_read_every: Duration,
}

impl Default for WatchConfig {
    fn default() -> Self {
        WatchConfig { interval: Duration::from_millis(400), force_read_every: Duration::from_secs(2) }
    }
}

type Stat = Option<(u128, u64)>;

pub struct Watcher {
    store: Store,
    cfg: WatchConfig,
    last_stat: Option<Stat>,
    last_read: Option<Instant>,
    last_published: Option<String>,
}

impl Watcher {
    pub fn new(store: Store, cfg: WatchConfig) -> Watcher {
        Watcher { store, cfg, last_stat: None, last_published: None, last_read: None }
    }

    pub fn config(&self) -> WatchConfig {
        self.cfg
    }

    fn stat(&self) -> Stat {
        let md = std::fs::metadata(self.store.todos_path()).ok()?;
        let nanos = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
        Some((nanos, md.len()))
    }

    /// One tick, never sleeps: stat, and read when the stat changed or a forced read is due.
    /// Returns the read envelope (`{ok:true,doc,warnings}` or `{ok:false,error}`) when it differs
    /// from the last published one; the first tick always publishes the initial state.
    pub fn poll(&mut self) -> Option<Value> {
        let stat = self.stat();
        let due = self.last_read.is_none_or(|t| t.elapsed() >= self.cfg.force_read_every);
        if self.last_stat.as_ref() == Some(&stat) && !due {
            return None;
        }
        // Stat first, read second: a change landing in between shows up as a stat difference next tick.
        self.last_stat = Some(stat);
        self.last_read = Some(Instant::now());
        let envelope = self.store.read_json();
        let key = envelope.to_string();
        if self.last_published.as_deref() == Some(key.as_str()) {
            return None;
        }
        self.last_published = Some(key);
        Some(envelope)
    }

    /// Poll every `interval` until `stop` is set, handing each published envelope to `on_change`.
    pub fn run(&mut self, stop: &AtomicBool, mut on_change: impl FnMut(Value)) {
        while !stop.load(Ordering::Relaxed) {
            if let Some(v) = self.poll() {
                on_change(v);
            }
            let mut slept = Duration::ZERO;
            while slept < self.cfg.interval && !stop.load(Ordering::Relaxed) {
                let step = Duration::from_millis(25).min(self.cfg.interval - slept);
                std::thread::sleep(step);
                slept += step;
            }
        }
    }
}
