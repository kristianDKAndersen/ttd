//! TTD window: a Tauri v2 shell around the `ttd-store` crate. The webview only calls
//! `store_read` / `store_apply(op)` and listens for `store-changed`; all file I/O is Rust (D4).

pub mod breadcrumb;
mod smoke;
pub mod watcher;
mod window_fit;
mod window_state;

use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Monitor, WebviewWindow, Window, WindowEvent};
use window_fit::Rect;
use window_state::{MonitorInfo, SavedMonitor, SavedWindow};
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

/// Main-window memory: where the state file lives, a debounce generation, and a gate that keeps the
/// placement done in setup from being saved before the window is shown.
struct WinState {
    path: Option<PathBuf>,
    generation: AtomicU64,
    shown: AtomicBool,
}

const SAVE_DEBOUNCE: Duration = Duration::from_millis(500);

fn rect_of(x: i32, y: i32, w: u32, h: u32, scale: f64) -> Rect {
    Rect { x: f64::from(x) / scale, y: f64::from(y) / scale, w: f64::from(w) / scale, h: f64::from(h) / scale }
}

/// A monitor in logical px: each monitor's physical values are divided by its OWN scale factor.
fn monitor_info(m: &Monitor) -> MonitorInfo {
    let (s, p, z, a) = (m.scale_factor(), m.position(), m.size(), m.work_area());
    MonitorInfo { name: m.name().cloned(), frame: rect_of(p.x, p.y, z.width, z.height, s), work: rect_of(a.position.x, a.position.y, a.size.width, a.size.height, s) }
}

struct Screens {
    infos: Vec<MonitorInfo>,
    primary: Option<usize>,
    primary_scale: f64,
}

fn screens(window: &WebviewWindow) -> Option<Screens> {
    let monitors = window.available_monitors().ok()?;
    let primary = window.primary_monitor().ok().flatten();
    let index = primary.as_ref().and_then(|p| monitors.iter().position(|m| m.position() == p.position()));
    Some(Screens { infos: monitors.iter().map(monitor_info).collect(), primary: index, primary_scale: primary.map_or(1.0, |p| p.scale_factor()) })
}

fn apply(window: &WebviewWindow, r: Rect) {
    let _ = window.set_size(tauri::LogicalSize::new(r.w, r.h));
    let _ = window.set_position(tauri::LogicalPosition::new(r.x, r.y));
}

fn fit_to(screens: &Screens, target: Rect) -> Rect {
    let areas: Vec<Rect> = screens.infos.iter().map(|m| m.work).collect();
    window_fit::fit(target, &areas, screens.primary)
}

/// Sizes and positions the still-hidden main window; `saved` is the remembered rect, if any.
fn place(window: &WebviewWindow, saved: Option<&SavedWindow>) -> Option<()> {
    let sc = screens(window)?;
    // tao reports the cursor as logical points scaled by the PRIMARY monitor's factor; monitor frames are logical.
    let cursor = window.cursor_position().ok().map(|c| (c.x / sc.primary_scale, c.y / sc.primary_scale));
    let size = window.inner_size().ok()?.to_logical::<f64>(window.scale_factor().ok()?);
    let target = window_state::resolve_target(saved, &sc.infos, cursor, sc.primary, (size.width, size.height))?;
    apply(window, fit_to(&sc, target));
    Some(())
}

/// Moves a visible window back inside a monitor (second launch, or a monitor that went away).
fn fit_current(window: &WebviewWindow) -> Option<()> {
    let sc = screens(window)?;
    let scale = window.scale_factor().ok()?;
    let (p, z) = (window.outer_position().ok()?, window.outer_size().ok()?);
    let now = rect_of(p.x, p.y, z.width, z.height, scale);
    let fitted = fit_to(&sc, now);
    if fitted != now {
        apply(window, fitted);
    }
    Some(())
}

fn show_main(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = fit_current(&w);
        show_main(&w);
    }
}

fn snapshot(window: &Window) -> Option<SavedWindow> {
    if window.is_minimized().unwrap_or(false) {
        return None;
    }
    let scale = window.scale_factor().ok()?;
    let pos = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    let monitor = window.current_monitor().ok().flatten().map(|m| {
        let i = monitor_info(&m);
        SavedMonitor { name: i.name, x: i.frame.x, y: i.frame.y }
    });
    Some(SavedWindow { x: pos.x, y: pos.y, w: size.width, h: size.height, monitor })
}

fn save_now(window: &Window) {
    let Some(st) = window.try_state::<WinState>() else { return };
    let Some(path) = st.path.as_ref().filter(|_| st.shown.load(Ordering::SeqCst)) else { return };
    if let Some(saved) = snapshot(window) {
        if let Err(e) = window_state::save(path, &saved) {
            eprintln!("ttd: cannot write {}: {e}", path.display());
        }
    }
}

/// Moved/Resized fire continuously while dragging: save once the window has been still for `SAVE_DEBOUNCE`.
fn schedule_save(window: &Window) {
    let Some(st) = window.try_state::<WinState>() else { return };
    let generation = st.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let w = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SAVE_DEBOUNCE);
        if w.try_state::<WinState>().is_some_and(|st| st.generation.load(Ordering::SeqCst) == generation) {
            save_now(&w);
        }
    });
}

pub fn run() {
    tauri::Builder::default()
        // Registered first (plugin requirement): a second launch focuses the existing window and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| focus_main(app)))
        .manage(AppStore(Store::from_env()))
        .invoke_handler(tauri::generate_handler![store_read, store_apply, is_smoke, smoke_report])
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                WindowEvent::CloseRequested { .. } => save_now(window),
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => schedule_save(window),
                _ => {}
            }
        })
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
            // The window starts hidden (tauri.conf.json): place it in logical px, then show it.
            let path = window_state::state_path(smoke::state_file().as_deref(), app.path().app_config_dir().ok());
            app.manage(WinState { path: path.clone(), generation: AtomicU64::new(0), shown: AtomicBool::new(false) });
            if let Some(window) = app.get_webview_window("main") {
                let saved = path.as_deref().and_then(window_state::load);
                let _ = place(&window, saved.as_ref());
                show_main(&window);
                if smoke::enabled() {
                    smoke::start_control(window);
                }
            }
            app.state::<WinState>().shown.store(true, Ordering::SeqCst);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running TTD");
}
