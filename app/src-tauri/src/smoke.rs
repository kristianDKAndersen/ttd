//! Test hooks for `app/scripts/smoke.ts`, all inert unless `TTD_SMOKE=1`: one JSON line per frontend
//! report on stdout, plus a tiny stdin control channel (`report`, `geometry X Y W H`, `close`) so the
//! script can move/resize/close the real window without OS-level automation.

use serde_json::json;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use tauri::WebviewWindow;

pub fn enabled() -> bool {
    std::env::var("TTD_SMOKE").is_ok_and(|v| v == "1")
}

/// Window-state file for smoke runs: absolute, inside `TTD_HOME` (which smoke sets to a temp dir).
pub fn state_file() -> Option<String> {
    if !enabled() {
        return None;
    }
    let home = std::env::var("TTD_HOME").ok().filter(|h| !h.is_empty())?;
    PathBuf::from(home).join(".window-state.json").to_str().map(str::to_owned)
}

pub fn print_report(kind: &str, window: &WebviewWindow, count: Option<usize>) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window.inner_size().map(|s| s.to_logical::<f64>(scale)).ok();
    let pos = window.outer_position().map(|p| p.to_logical::<f64>(scale)).ok();
    let line = json!({
        "type": kind,
        "count": count,
        "alwaysOnTop": window.is_always_on_top().unwrap_or(false),
        "width": size.map(|s| s.width),
        "height": size.map(|s| s.height),
        "x": pos.map(|p| p.x),
        "y": pos.map(|p| p.y),
    });
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

pub fn start_control(window: WebviewWindow) {
    std::thread::Builder::new()
        .name("ttd-smoke-control".into())
        .spawn(move || {
            for line in std::io::stdin().lock().lines().map_while(Result::ok) {
                let parts: Vec<&str> = line.split_whitespace().collect();
                match parts.as_slice() {
                    ["report"] => print_report("window", &window, None),
                    ["close"] => {
                        let _ = window.close();
                    }
                    ["geometry", x, y, w, h] => {
                        if let (Ok(x), Ok(y), Ok(w), Ok(h)) = (x.parse::<f64>(), y.parse::<f64>(), w.parse::<f64>(), h.parse::<f64>()) {
                            let _ = window.set_size(tauri::LogicalSize::new(w, h));
                            let _ = window.set_position(tauri::LogicalPosition::new(x, y));
                        }
                    }
                    _ => {}
                }
            }
        })
        .expect("spawn smoke control thread");
}
