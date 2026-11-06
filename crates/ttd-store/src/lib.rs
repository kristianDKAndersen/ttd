//! TTD todo store: the Rust implementation of `docs/contract/STORE.md`.
//!
//! * [`apply_op`] is the pure op semantics (section 3).
//! * [`Store`] wraps it in the lock + CAS + atomic-write protocol (sections 4-8): [`Store::read`],
//!   [`Store::apply`] and their JSON-envelope twins [`Store::read_json`], [`Store::apply_json`].
//! * [`Watcher`] is the change detector of section 7 (used by the CLI and the Tauri shell).

mod doc;
mod engine;
mod error;
mod ops;
mod optext;
mod watch;

pub use doc::{trim_contract, Doc, Item, ParseError, Status, MAX_BODY, MAX_FILE_BYTES, MAX_ITEMS, MAX_TITLE, SCHEMA_VERSION};
pub use engine::{home_dir_from, ApplyCtx, ApplyOk, Options, ReadOk, Renamer, StdRenamer, Store};
pub use error::{ErrorCode, StoreError, Warning};
pub use ops::{apply_op, Applied};
pub use optext::parse_op_text;
pub use watch::{WatchConfig, Watcher};
