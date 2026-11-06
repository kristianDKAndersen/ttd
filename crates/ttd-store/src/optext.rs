//! Parsing an op from JSON text (CLI argument, Tauri/HTTP body) with the contract's lone-surrogate
//! rule: JS accepts `"\ud83d"` in JSON text, Rust cannot hold it in a string, and the TS core
//! refuses it as `invalid_title` (title) or `invalid_op` (any other field).

use crate::doc::sanitize_lone_surrogates;
use crate::error::{ErrorCode, StoreError};
use serde_json::Value;

/// Noncharacters used as a stand-in for a lone surrogate while parsing (first one not in the text).
const SENTINELS: std::ops::RangeInclusive<u32> = 0xFDD0..=0xFDEF;
const KNOWN_FIELDS: [&str; 6] = ["op", "id", "title", "body", "status", "after"];

pub fn parse_op_text(text: &str) -> Result<Value, StoreError> {
    let first = match serde_json::from_str::<Value>(text) {
        Ok(v) => return Ok(v),
        Err(e) => e,
    };
    let lower = text.to_ascii_lowercase();
    let sentinel = SENTINELS.filter_map(char::from_u32).find(|c| !text.contains(*c) && !lower.contains(&format!("\\u{:04x}", *c as u32)));
    let not_json = || StoreError::with_message(ErrorCode::InvalidOp, format!("op is not valid JSON: {first}"));
    let Some(sentinel) = sentinel else { return Err(not_json()) };
    let Some(fixed) = sanitize_lone_surrogates(text, &format!("\\u{:04X}", sentinel as u32)) else { return Err(not_json()) };
    let Ok(v) = serde_json::from_str::<Value>(&fixed) else { return Err(not_json()) };
    let has = |v: &Value| match v {
        Value::String(s) => s.contains(sentinel),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
        other => other.to_string().contains(sentinel),
    };
    if let Some(o) = v.as_object() {
        let bad = |k: &str| o.get(k).is_some_and(has);
        if KNOWN_FIELDS.iter().filter(|k| **k != "title").any(|k| bad(k)) {
            return Err(StoreError::with_message(ErrorCode::InvalidOp, "an unpaired surrogate is not allowed"));
        }
        if bad("title") {
            return Err(StoreError::new(ErrorCode::InvalidTitle));
        }
    }
    Ok(v)
}
