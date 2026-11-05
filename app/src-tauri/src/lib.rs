//! TTD window: a Tauri v2 shell around the `ttd-store` crate. The webview only calls
//! `store_read` / `store_apply(op)` and listens for `store-changed`; all file I/O is Rust (D4).

pub mod breadcrumb;
mod smoke;
pub mod watcher;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_window_state::StateFlags;
use ttd_store::{parse_op_text, ApplyCtx, ErrorCode, Store, StoreError, WatchConfig};

/// Managed state: `None` when no home directory can be resolved (neither `TTD_HOME` nor `HOME`).
struct AppStore(Option<Store>);

fn io_envelope(message: impl Into<String>) -> Value {
    StoreError::with_message(ErrorCode::IoError, message).to_envelope()
}

/// Run blocking store work off the main thread: the lock can wait up to 5 s (STORE.md section 5).
async fn with_store(app: AppHandle, work: impl FnOnce(&Store) -> Value + Send + 'static) -> Value {
    let Some(store) = app.state::<AppStore>().0.clone() else {
        return io_envelope("cannot resolve the home directory (set TTD_HOME or HOME)");
    };
    tauri::async_runtime::spawn_blocking(move || work(&store)).await.unwrap_or_else(|e| io_envelope(format!("store task failed: {e}")))
}

#[tauri::command]
async fn store_read(app: AppHandle) -> Value {
    with_store(app, |s| s.read_json()).await
}

/// `op` is the op object; a JSON string is accepted too and goes through the contract's text parser.
#[tauri::command]
async fn store_apply(app: AppHandle, op: Value) -> Value {
    let op = match op {
        Value::String(text) => match parse_op_text(&text) {
            Ok(v) => v,
            Err(e) => return e.to_envelope(),
        },
        other => other,
    };
    with_store(app, move |s| s.apply_json(&op, ApplyCtx::default())).await
}

#[tauri::command]
fn is_smoke() -> bool {
    smoke::enabled()
}

/// The frontend reports its rendered row count; only does anything under `TTD_SMOKE=1`.
#[tauri::command]
fn smoke_report(window: WebviewWindow, count: usize) {
    if smoke::enabled() {
        smoke::print_report("render", &window, Some(count));
    }
}

fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn run() {
    let state_flags = StateFlags::SIZE | StateFlags::POSITION;
    let mut window_state = tauri_plugin_window_state::Builder::new().with_state_flags(state_flags);
    if let Some(file) = smoke::state_file() {
        // Smoke runs keep their window state next to their temp TTD_HOME, never in the real config dir.
        window_state = window_state.with_filename(file);
    }

    tauri::Builder::default()
        // Registered first (plugin requirement): a second launch focuses the existing window and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| focus_main(app)))
        .plugin(window_state.build())
        .manage(AppStore(Store::from_env()))
        .invoke_handler(tauri::generate_handler![store_read, store_apply, is_smoke, smoke_report])
        .setup(|app| {
            if let Some(store) = app.state::<AppStore>().0.clone() {
                let exe = breadcrumb::exe_path(|k| std::env::var(k).ok(), std::env::current_exe);
                match exe.and_then(|exe| breadcrumb::write(store.home(), &exe, &app.package_info().version.to_string(), &breadcrumb::now_iso())) {
                    Ok(()) => {}
                    Err(e) => eprintln!("ttd: cannot write {}: {e}", store.home().join(breadcrumb::FILE_NAME).display()),
                }
                let handle = app.handle().clone();
                let poller = watcher::spawn(store, WatchConfig::default(), move |envelope| {
                    let _ = handle.emit("store-changed", envelope);
                });
                // Lives as long as the process; the thread dies with it.
                std::mem::forget(poller);
            }
            if smoke::enabled() {
                if let Some(window) = app.get_webview_window("main") {
                    smoke::start_control(window);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running TTD");
}
