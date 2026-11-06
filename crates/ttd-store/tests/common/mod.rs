#![allow(dead_code)]
//! Shared helpers for the integration tests: real temp dirs, real files.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn item(id: &str, title: &str, order: i64, created: &str) -> Value {
    json!({
        "id": id, "title": title, "body": "", "status": "todo", "order": order,
        "createdAt": created, "updatedAt": created
    })
}

pub fn doc_json(rev: u64, items: Vec<Value>) -> Value {
    json!({ "schemaVersion": 1, "rev": rev, "items": items })
}

pub fn write_pretty(path: &Path, v: &Value) {
    fs::write(path, serde_json::to_string_pretty(v).unwrap() + "\n").unwrap();
}

pub fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

pub fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = match fs::read_dir(dir) {
        Ok(rd) => rd.map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect(),
        Err(_) => vec![],
    };
    v.sort();
    v
}

pub fn count_prefix(dir: &Path, prefix: &str) -> usize {
    names(dir).iter().filter(|n| n.starts_with(prefix)).count()
}

pub fn tmp_files(dir: &Path) -> usize {
    count_prefix(dir, ".todos.json.tmp-")
}

pub fn quarantined(dir: &Path) -> Vec<PathBuf> {
    names(dir)
        .into_iter()
        .filter(|n| n.starts_with("todos.corrupt-") && n.ends_with(".json"))
        .map(|n| dir.join(n))
        .collect()
}

/// Create a pre-existing lock directory whose owner.json `ts` is `age_ms` old.
pub fn make_lock(home: &Path, age_ms: u64) {
    let lock = home.join("store.lock");
    fs::create_dir_all(&lock).unwrap();
    let owner = json!({ "token": "foreignlock1", "pid": 1, "ts": now_ms().saturating_sub(age_ms) });
    fs::write(lock.join("owner.json"), owner.to_string()).unwrap();
}
