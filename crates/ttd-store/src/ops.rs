//! Pure op semantics (STORE.md section 3): `apply(doc, op, now) -> { doc', changed, result } | error`.
//! No IO, no clock, no randomness (ids come from `new_id`). `rev` is never touched here.

use crate::doc::{trim_contract, valid_id, Doc, Item, Status, MAX_BODY, MAX_FILE_BYTES, MAX_ITEMS, MAX_TITLE};
use crate::error::{ErrorCode, StoreError};
use serde_json::{json, Map, Value};

#[derive(Debug, Clone)]
pub struct Applied {
    pub doc: Doc,
    pub changed: bool,
    pub result: Value,
}

fn invalid(msg: &str) -> StoreError {
    StoreError::with_message(ErrorCode::InvalidOp, msg)
}

/// Optional string field: absent is `None`, present but not a string is `invalid_op`.
fn opt_str<'a>(op: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, StoreError> {
    match op.get(key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(invalid(&format!("{key} must be a string"))),
    }
}

fn req_str<'a>(op: &'a Map<String, Value>, key: &str) -> Result<&'a str, StoreError> {
    opt_str(op, key)?.ok_or_else(|| invalid(&format!("{key} is required")))
}

fn req_id<'a>(op: &'a Map<String, Value>, key: &str) -> Result<&'a str, StoreError> {
    let id = req_str(op, key)?;
    if valid_id(id) {
        Ok(id)
    } else {
        Err(invalid(&format!("{key} must match ^[A-Za-z0-9_-]{{1,64}}$")))
    }
}

fn status_field(op: &Map<String, Value>) -> Result<Option<Status>, StoreError> {
    match opt_str(op, "status")? {
        None => Ok(None),
        Some(s) => Status::parse(s).map(Some).ok_or_else(|| invalid("status must be todo, in_progress or done")),
    }
}

/// Value checks for a title: returns the trimmed title.
fn check_title(raw: &str) -> Result<String, StoreError> {
    let t = trim_contract(raw);
    if t.is_empty() {
        return Err(StoreError::with_message(ErrorCode::InvalidTitle, "title is empty"));
    }
    if t.chars().any(|c| (c as u32) < 0x20) {
        return Err(StoreError::with_message(ErrorCode::InvalidTitle, "title contains a control character"));
    }
    if t.chars().count() > MAX_TITLE {
        return Err(StoreError::with_message(ErrorCode::TooLong, format!("title is longer than {MAX_TITLE} code points")));
    }
    Ok(t.to_string())
}

fn check_body(body: &str) -> Result<(), StoreError> {
    if body.chars().count() > MAX_BODY {
        return Err(StoreError::with_message(ErrorCode::TooLong, format!("body is longer than {MAX_BODY} code points")));
    }
    Ok(())
}

fn item_result(doc: &Doc, id: &str) -> Value {
    let it = doc.items.iter().find(|i| i.id == id).expect("item present");
    json!({ "item": it.to_value() })
}

/// Limits are checked on the post-op doc, but only when the op made the doc bigger: an already
/// oversized file must still be able to shrink.
fn check_growth_limits(before: &Doc, after: &Doc) -> Result<(), StoreError> {
    if after.items.len() > MAX_ITEMS && after.items.len() > before.items.len() {
        return Err(StoreError::with_message(ErrorCode::LimitExceeded, format!("more than {MAX_ITEMS} items")));
    }
    let after_len = after.to_json_pretty().len();
    if after_len > MAX_FILE_BYTES && after_len > before.to_json_pretty().len() {
        return Err(StoreError::with_message(ErrorCode::LimitExceeded, "file would exceed 1 MiB"));
    }
    Ok(())
}

pub fn apply_op(doc: &Doc, op: &Value, now: &str, new_id: &mut dyn FnMut() -> String) -> Result<Applied, StoreError> {
    let Some(op) = op.as_object() else { return Err(invalid("op must be a JSON object")) };
    let Some(Value::String(kind)) = op.get("op") else { return Err(invalid("op.op must be a string")) };
    let base = doc.clone().normalized();
    match kind.as_str() {
        "add" => add(base, op, now, new_id),
        "update" => update(base, op, now),
        "set_status" => set_status(base, op, now),
        "move" => move_item(base, op),
        "delete" => delete(base, op),
        "reset_corrupt" => Err(StoreError::with_message(ErrorCode::NotCorrupt, "the file is not corrupt")),
        other => Err(invalid(&format!("unknown op {other:?}"))),
    }
}

fn add(mut d: Doc, op: &Map<String, Value>, now: &str, new_id: &mut dyn FnMut() -> String) -> Result<Applied, StoreError> {
    // 1. shape
    let id = match op.get("id") {
        None => None,
        Some(Value::String(s)) if valid_id(s) => Some(s.clone()),
        Some(_) => return Err(invalid("id must match ^[A-Za-z0-9_-]{1,64}$")),
    };
    let raw_title = req_str(op, "title")?;
    let raw_body = opt_str(op, "body")?;
    let status = status_field(op)?;
    // 2. values
    let title = check_title(raw_title)?;
    let body = raw_body.unwrap_or("");
    check_body(body)?;
    // 3. lookups
    let id = match id {
        Some(id) => id,
        None => (0..8)
            .map(|_| new_id())
            .find(|cand| !d.items.iter().any(|i| i.id == *cand))
            .ok_or_else(|| StoreError::with_message(ErrorCode::IoError, "could not generate a unique id"))?,
    };
    if d.items.iter().any(|i| i.id == id) {
        let result = item_result(&d, &id);
        return Ok(Applied { doc: d, changed: false, result });
    }
    let before = d.clone();
    let mut item = Item::new(&id, &title, body, now, d.items.len() as i64);
    item.status = status.unwrap_or(Status::Todo);
    d.items.push(item);
    check_growth_limits(&before, &d)?;
    let result = item_result(&d, &id);
    Ok(Applied { doc: d, changed: true, result })
}

fn update(mut d: Doc, op: &Map<String, Value>, now: &str) -> Result<Applied, StoreError> {
    let id = req_id(op, "id")?;
    let title = opt_str(op, "title")?;
    let body = opt_str(op, "body")?;
    if title.is_none() && body.is_none() {
        return Err(invalid("update needs title and/or body"));
    }
    let title = title.map(check_title).transpose()?;
    if let Some(b) = body {
        check_body(b)?;
    }
    let Some(idx) = d.items.iter().position(|i| i.id == id) else { return Err(not_found(id)) };
    let before = d.clone();
    let it = &mut d.items[idx];
    let mut changed = false;
    if let Some(t) = title {
        if it.title != t {
            it.title = t;
            changed = true;
        }
    }
    if let Some(b) = body {
        if it.body != b {
            it.body = b.to_string();
            changed = true;
        }
    }
    if changed {
        it.updated_at = now.to_string();
        check_growth_limits(&before, &d)?;
    }
    let result = item_result(&d, id);
    Ok(Applied { doc: d, changed, result })
}

fn set_status(mut d: Doc, op: &Map<String, Value>, now: &str) -> Result<Applied, StoreError> {
    let id = req_id(op, "id")?;
    let status = status_field(op)?.ok_or_else(|| invalid("status is required"))?;
    let Some(it) = d.items.iter_mut().find(|i| i.id == id) else { return Err(not_found(id)) };
    let changed = it.status != status;
    if changed {
        it.status = status;
        it.updated_at = now.to_string();
    }
    let result = item_result(&d, id);
    Ok(Applied { doc: d, changed, result })
}

fn move_item(mut d: Doc, op: &Map<String, Value>) -> Result<Applied, StoreError> {
    let id = req_id(op, "id")?;
    let after: Option<&str> = match op.get("after") {
        None => return Err(invalid("after is required (an item id or null)")),
        Some(Value::Null) => None,
        Some(Value::String(s)) if valid_id(s) => Some(s),
        Some(_) => return Err(invalid("after must be an item id or null")),
    };
    if after == Some(id) {
        return Err(invalid("an item cannot be moved after itself"));
    }
    let Some(from) = d.items.iter().position(|i| i.id == id) else { return Err(not_found(id)) };
    if let Some(a) = after {
        if !d.items.iter().any(|i| i.id == a) {
            return Err(not_found(a));
        }
    }
    let item = d.items.remove(from);
    let to = match after {
        None => 0,
        Some(a) => d.items.iter().position(|i| i.id == a).expect("checked above") + 1,
    };
    d.items.insert(to, item);
    d.renumber();
    let result = item_result(&d, id);
    Ok(Applied { doc: d, changed: to != from, result })
}

fn delete(mut d: Doc, op: &Map<String, Value>) -> Result<Applied, StoreError> {
    let id = req_id(op, "id")?;
    let before = d.items.len();
    d.items.retain(|i| i.id != id);
    let changed = d.items.len() != before;
    d.renumber();
    Ok(Applied { doc: d, changed, result: json!({ "id": id }) })
}

fn not_found(id: &str) -> StoreError {
    StoreError::with_message(ErrorCode::NotFound, format!("no item {id:?}"))
}
