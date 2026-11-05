//! Document model (STORE.md section 2): parsing with the contract's corruption rules, normalisation,
//! serialisation. Unknown top-level and per-item fields are carried in `extra`.

use serde_json::{Map, Value};
use std::cmp::Ordering;

pub const SCHEMA_VERSION: u64 = 1;
pub const MAX_ITEMS: usize = 1000;
pub const MAX_FILE_BYTES: usize = 1024 * 1024;
pub const MAX_TITLE: usize = 200;
pub const MAX_BODY: usize = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Todo,
    InProgress,
    Done,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Todo => "todo",
            Status::InProgress => "in_progress",
            Status::Done => "done",
        }
    }

    pub fn parse(s: &str) -> Option<Status> {
        match s {
            "todo" => Some(Status::Todo),
            "in_progress" => Some(Status::InProgress),
            "done" => Some(Status::Done),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub id: String,
    pub title: String,
    pub body: String,
    pub status: Status,
    pub order: i64,
    pub created_at: String,
    pub updated_at: String,
    /// Unknown per-item fields, preserved verbatim.
    pub extra: Map<String, Value>,
}

impl Item {
    /// A fresh `todo` item with `created_at == updated_at == now`.
    pub fn new(id: &str, title: &str, body: &str, now: &str, order: i64) -> Item {
        Item {
            id: id.to_string(),
            title: title.to_string(),
            body: body.to_string(),
            status: Status::Todo,
            order,
            created_at: now.to_string(),
            updated_at: now.to_string(),
            extra: Map::new(),
        }
    }

    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("id".into(), Value::String(self.id.clone()));
        m.insert("title".into(), Value::String(self.title.clone()));
        m.insert("body".into(), Value::String(self.body.clone()));
        m.insert("status".into(), Value::String(self.status.as_str().into()));
        m.insert("order".into(), Value::from(self.order));
        m.insert("createdAt".into(), Value::String(self.created_at.clone()));
        m.insert("updatedAt".into(), Value::String(self.updated_at.clone()));
        for (k, v) in &self.extra {
            m.insert(k.clone(), v.clone());
        }
        Value::Object(m)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Doc {
    pub schema_version: u64,
    pub rev: u64,
    pub items: Vec<Item>,
    /// Unknown top-level fields, preserved verbatim.
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseError {
    /// Not a valid document (section 8 "corrupt").
    Corrupt,
    /// `schemaVersion` is higher than this implementation supports.
    Unsupported,
}

/// `trim` of STORE.md section 2: only U+0009-U+000D, U+0020, U+00A0, U+2028, U+2029, U+FEFF.
pub fn trim_contract(s: &str) -> &str {
    s.trim_matches(|c| matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{2028}' | '\u{2029}' | '\u{feff}'))
}

pub(crate) fn valid_id(id: &str) -> bool {
    let n = id.len();
    (1..=64).contains(&n) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// JSON number -> integer, the way JS sees it (`3.0` is an integer).
fn as_int(v: &Value) -> Option<i64> {
    if let Some(i) = v.as_i64() {
        return Some(i);
    }
    if let Some(u) = v.as_u64() {
        return i64::try_from(u).ok();
    }
    let f = v.as_f64()?;
    if f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_992.0 {
        Some(f as i64)
    } else {
        None
    }
}

impl Doc {
    pub fn empty() -> Doc {
        Doc { schema_version: SCHEMA_VERSION, rev: 0, items: Vec::new(), extra: Map::new() }
    }

    /// Parse and validate file text. A higher `schemaVersion` wins over every other defect.
    pub fn parse(text: &str) -> Result<Doc, ParseError> {
        match serde_json::from_str::<Value>(text) {
            Ok(v) => Doc::from_value(v),
            Err(_) => {
                // serde_json rejects an unpaired surrogate escape that JS writes happily
                // (`"\ud83d"`). Such a file is valid for the TS implementation, so do not call it
                // corrupt: read it with U+FFFD in place of the lone surrogate.
                match sanitize_lone_surrogates(text, "\\uFFFD") {
                    Some(fixed) => serde_json::from_str::<Value>(&fixed).map_err(|_| ParseError::Corrupt).and_then(Doc::from_value),
                    None => Err(ParseError::Corrupt),
                }
            }
        }
    }

    pub fn from_value(v: Value) -> Result<Doc, ParseError> {
        let Value::Object(mut obj) = v else { return Err(ParseError::Corrupt) };
        let sv = obj.get("schemaVersion").and_then(as_int).ok_or(ParseError::Corrupt)?;
        if sv > SCHEMA_VERSION as i64 {
            return Err(ParseError::Unsupported);
        }
        if sv < 1 {
            return Err(ParseError::Corrupt);
        }
        let rev = obj.get("rev").and_then(as_int).filter(|r| *r >= 0).ok_or(ParseError::Corrupt)? as u64;
        let Some(Value::Array(raw_items)) = obj.remove("items") else { return Err(ParseError::Corrupt) };
        obj.remove("schemaVersion");
        obj.remove("rev");
        let mut items = Vec::with_capacity(raw_items.len());
        let mut seen = std::collections::HashSet::new();
        for raw in raw_items {
            let item = item_from_value(raw)?;
            if !seen.insert(item.id.clone()) {
                return Err(ParseError::Corrupt);
            }
            items.push(item);
        }
        Ok(Doc { schema_version: SCHEMA_VERSION, rev, items, extra: obj })
    }

    /// Items ordered by `(order, createdAt, id)`, `order` renumbered `0..n-1`.
    pub fn normalized(mut self) -> Doc {
        self.items.sort_by(|a, b| -> Ordering {
            a.order
                .cmp(&b.order)
                .then_with(|| a.created_at.as_bytes().cmp(b.created_at.as_bytes()))
                .then_with(|| a.id.as_bytes().cmp(b.id.as_bytes()))
        });
        self.renumber();
        self
    }

    pub(crate) fn renumber(&mut self) {
        for (i, it) in self.items.iter_mut().enumerate() {
            it.order = i as i64;
        }
    }

    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("schemaVersion".into(), Value::from(self.schema_version));
        m.insert("rev".into(), Value::from(self.rev));
        m.insert("items".into(), Value::Array(self.items.iter().map(Item::to_value).collect()));
        for (k, v) in &self.extra {
            m.insert(k.clone(), v.clone());
        }
        Value::Object(m)
    }

    /// `JSON.stringify(doc, null, 2) + "\n"` style.
    pub fn to_json_pretty(&self) -> String {
        let mut s = serde_json::to_string_pretty(&self.to_value()).expect("a Value always serialises");
        s.push('\n');
        s
    }
}

impl serde::Serialize for Doc {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.to_value().serialize(s)
    }
}

fn item_from_value(v: Value) -> Result<Item, ParseError> {
    let Value::Object(mut o) = v else { return Err(ParseError::Corrupt) };
    let mut take_str = |k: &str| -> Result<String, ParseError> {
        match o.remove(k) {
            Some(Value::String(s)) => Ok(s),
            _ => Err(ParseError::Corrupt),
        }
    };
    let id = take_str("id")?;
    if !valid_id(&id) {
        return Err(ParseError::Corrupt);
    }
    let title = take_str("title")?;
    let body = take_str("body")?;
    let status = Status::parse(&take_str("status")?).ok_or(ParseError::Corrupt)?;
    let created_at = take_str("createdAt")?;
    let updated_at = take_str("updatedAt")?;
    let order = o.remove("order").as_ref().and_then(as_int).ok_or(ParseError::Corrupt)?;
    Ok(Item { id, title, body, status, order, created_at, updated_at, extra: o })
}

/// Replace unpaired `\uD800`-`\uDFFF` escapes by `�`. `None` when there is nothing to replace.
pub(crate) fn sanitize_lone_surrogates(text: &str, replacement: &str) -> Option<String> {
    let b = text.as_bytes();
    let hex4 = |i: usize| -> Option<u32> {
        let s = text.get(i..i + 4)?;
        if s.bytes().all(|c| c.is_ascii_hexdigit()) {
            u32::from_str_radix(s, 16).ok()
        } else {
            None
        }
    };
    let mut out = String::with_capacity(text.len());
    let mut changed = false;
    let mut i = 0;
    let mut copied = 0;
    while i < b.len() {
        if b[i] != b'\\' {
            i += 1;
            continue;
        }
        // b[i] is a backslash: it escapes the next byte, so `\\u` is never a unicode escape.
        if i + 1 < b.len() && b[i + 1] == b'u' {
            if let Some(cp) = hex4(i + 2) {
                if (0xD800..0xDC00).contains(&cp) {
                    let paired = b.get(i + 6) == Some(&b'\\') && b.get(i + 7) == Some(&b'u') && hex4(i + 8).is_some_and(|lo| (0xDC00..0xE000).contains(&lo));
                    if paired {
                        i += 12;
                    } else {
                        out.push_str(&text[copied..i]);
                        out.push_str(replacement);
                        changed = true;
                        i += 6;
                        copied = i;
                    }
                    continue;
                }
                if (0xDC00..0xE000).contains(&cp) {
                    out.push_str(&text[copied..i]);
                    out.push_str(replacement);
                    changed = true;
                    i += 6;
                    copied = i;
                    continue;
                }
                i += 6;
                continue;
            }
        }
        i += 2;
    }
    if !changed {
        return None;
    }
    out.push_str(&text[copied..]);
    Some(out)
}
