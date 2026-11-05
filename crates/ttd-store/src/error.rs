use serde_json::{json, Value};
use std::fmt;

/// Error codes of STORE.md section 3.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    InvalidOp,
    InvalidTitle,
    TooLong,
    LimitExceeded,
    NotFound,
    NotCorrupt,
    Corrupt,
    CorruptNoBackup,
    UnsupportedVersion,
    LockTimeout,
    ConflictExhausted,
    IoError,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::InvalidOp => "invalid_op",
            ErrorCode::InvalidTitle => "invalid_title",
            ErrorCode::TooLong => "too_long",
            ErrorCode::LimitExceeded => "limit_exceeded",
            ErrorCode::NotFound => "not_found",
            ErrorCode::NotCorrupt => "not_corrupt",
            ErrorCode::Corrupt => "corrupt",
            ErrorCode::CorruptNoBackup => "corrupt_no_backup",
            ErrorCode::UnsupportedVersion => "unsupported_version",
            ErrorCode::LockTimeout => "lock_timeout",
            ErrorCode::ConflictExhausted => "conflict_exhausted",
            ErrorCode::IoError => "io_error",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Warning codes of STORE.md section 3.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Warning {
    CorruptQuarantined,
    RestoredFromBak,
    StaleLockBroken,
}

impl Warning {
    pub fn as_str(self) -> &'static str {
        match self {
            Warning::CorruptQuarantined => "corrupt_quarantined",
            Warning::RestoredFromBak => "restored_from_bak",
            Warning::StaleLockBroken => "stale_lock_broken",
        }
    }
}

impl fmt::Display for Warning {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The failure side of the envelope: `{ ok: false, error, message? }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreError {
    pub code: ErrorCode,
    pub message: Option<String>,
}

impl StoreError {
    pub fn new(code: ErrorCode) -> Self {
        StoreError { code, message: None }
    }

    pub fn with_message(code: ErrorCode, message: impl Into<String>) -> Self {
        StoreError { code, message: Some(message.into()) }
    }

    pub fn io(context: &str, e: &std::io::Error) -> Self {
        StoreError::with_message(ErrorCode::IoError, format!("{context}: {e}"))
    }

    pub fn to_envelope(&self) -> Value {
        let mut v = json!({ "ok": false, "error": self.code.as_str() });
        // Contract (shared with the TS core): `message` only on io_error and invalid_op.
        if let (Some(m), ErrorCode::IoError | ErrorCode::InvalidOp) = (&self.message, self.code) {
            v["message"] = Value::String(m.clone());
        }
        v
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.message {
            Some(m) => write!(f, "{}: {m}", self.code),
            None => write!(f, "{}", self.code),
        }
    }
}

impl std::error::Error for StoreError {}

impl serde::Serialize for StoreError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.to_envelope().serialize(s)
    }
}
