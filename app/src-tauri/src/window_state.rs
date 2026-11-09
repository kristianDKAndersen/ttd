//! Own window memory for the main window, in LOGICAL px (macOS points), replacing tauri-plugin-window-state
//! (it stores physical px, which breaks across mixed-DPI displays). Pure logic only; lib.rs does the window I/O.

use crate::window_fit::Rect;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "window.json";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SavedMonitor {
    pub name: Option<String>,
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SavedWindow {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub monitor: Option<SavedMonitor>,
}

/// One connected monitor in logical px: `frame` is the full display, `work` excludes menu bar and Dock.
#[derive(Clone, Debug, PartialEq)]
pub struct MonitorInfo {
    pub name: Option<String>,
    pub frame: Rect,
    pub work: Rect,
}

/// `None` for anything that is not a usable window rect, so a damaged or foreign file is ignored.
pub fn parse(text: &str) -> Option<SavedWindow> {
    let s: SavedWindow = serde_json::from_str(text).ok()?;
    let finite = [s.x, s.y, s.w, s.h].iter().all(|v| v.is_finite());
    (finite && s.w > 0.0 && s.h > 0.0).then_some(s)
}

pub fn serialize(saved: &SavedWindow) -> String {
    serde_json::to_string_pretty(saved).unwrap_or_default()
}

/// Smoke runs keep the file next to their temp `TTD_HOME` (the sibling of the smoke window-state path);
/// normal runs use the app config dir.
pub fn state_path(smoke_file: Option<&str>, config_dir: Option<PathBuf>) -> Option<PathBuf> {
    match smoke_file {
        Some(f) => Some(PathBuf::from(f).with_file_name(FILE_NAME)),
        None => config_dir.map(|d| d.join(FILE_NAME)),
    }
}

/// Strict UTF-8 read: a damaged file is `None`, never partially parsed.
pub fn load(path: &Path) -> Option<SavedWindow> {
    parse(&std::fs::read_to_string(path).ok()?)
}

/// Atomic: write a sibling temp file, then rename it over the target.
pub fn save(path: &Path, saved: &SavedWindow) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serialize(saved))?;
    std::fs::rename(&tmp, path)
}

fn same_origin(m: &MonitorInfo, saved: &SavedMonitor) -> bool {
    (m.frame.x - saved.x).abs() < 1.0 && (m.frame.y - saved.y).abs() < 1.0
}

/// The connected monitor the window was saved on: by name (the one at the saved origin when several share
/// the name), else by the saved origin alone.
pub fn find_monitor(saved: &SavedMonitor, monitors: &[MonitorInfo]) -> Option<usize> {
    let named: Vec<usize> = (0..monitors.len()).filter(|&i| saved.name.is_some() && monitors[i].name == saved.name).collect();
    match named.iter().copied().find(|&i| same_origin(&monitors[i], saved)).or(named.first().copied()) {
        Some(i) => Some(i),
        None => monitors.iter().position(|m| same_origin(m, saved)),
    }
}

/// The rect to open at, before `window_fit::fit`: the saved rect when its monitor is still connected
/// (shifted with the monitor if it was rearranged), else the saved or default size centered on the monitor
/// under `cursor` (logical px), else on the primary, else the first. `None` when there are no monitors.
pub fn resolve_target(saved: Option<&SavedWindow>, monitors: &[MonitorInfo], cursor: Option<(f64, f64)>, primary: Option<usize>, default_size: (f64, f64)) -> Option<Rect> {
    if let Some((s, i)) = saved.and_then(|s| Some((s, find_monitor(s.monitor.as_ref()?, monitors)?))) {
        let (m, f) = (s.monitor.as_ref()?, &monitors[i].frame);
        return Some(Rect { x: s.x + f.x - m.x, y: s.y + f.y - m.y, w: s.w, h: s.h });
    }
    let under_cursor = cursor.and_then(|(cx, cy)| monitors.iter().position(|m| cx >= m.frame.x && cx < m.frame.x + m.frame.w && cy >= m.frame.y && cy < m.frame.y + m.frame.h));
    let work = monitors.get(under_cursor.or(primary.filter(|&p| p < monitors.len())).unwrap_or(0))?.work;
    let (w, h) = saved.map_or(default_size, |s| (s.w, s.h));
    let (w, h) = (w.min(work.w), h.min(work.h));
    Some(Rect { x: work.x + (work.w - w) / 2.0, y: work.y + (work.h - h) / 2.0, w, h })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, w, h }
    }
    fn mon(name: &str, frame: Rect, work: Rect) -> MonitorInfo {
        MonitorInfo { name: Some(name.into()), frame, work }
    }
    fn main_mon() -> MonitorInfo {
        mon("Built-in", r(0.0, 0.0, 2056.0, 1329.0), r(0.0, 38.0, 2056.0, 1291.0))
    }
    fn ext_mon() -> MonitorInfo {
        mon("DELL", r(-5120.0, -407.0, 5120.0, 1440.0), r(-5120.0, -407.0, 5120.0, 1440.0))
    }
    fn sm(name: &str, x: f64, y: f64) -> SavedMonitor {
        SavedMonitor { name: Some(name.into()), x, y }
    }
    fn saved(x: f64, y: f64, w: f64, h: f64, m: Option<SavedMonitor>) -> SavedWindow {
        SavedWindow { x, y, w, h, monitor: m }
    }

    #[test]
    fn serialize_then_parse_round_trips() {
        let s = saved(-2720.5, 73.0, 320.0, 480.0, Some(sm("DELL", -5120.0, -407.0)));
        assert_eq!(parse(&serialize(&s)), Some(s));
        let bare = saved(1.0, 2.0, 300.0, 400.0, None);
        assert_eq!(parse(&serialize(&bare)), Some(bare));
    }

    #[test]
    fn parse_rejects_garbage_nonfinite_and_empty_sizes() {
        assert_eq!(parse(""), None);
        assert_eq!(parse("not json"), None);
        assert_eq!(parse(r#"{"x":1,"y":2,"w":0,"h":400,"monitor":null}"#), None);
        assert_eq!(parse(r#"{"x":1,"y":2,"w":300,"h":-5,"monitor":null}"#), None);
        assert_eq!(parse(r#"{"x":1e999,"y":2,"w":300,"h":400,"monitor":null}"#), None);
    }

    #[test]
    fn the_legacy_plugin_file_is_ignored() {
        assert_eq!(parse(r#"{"main":{"width":1040,"height":1252,"x":5872,"y":132,"maximized":false}}"#), None);
    }

    #[test]
    fn state_path_prefers_the_smoke_home_and_names_the_file_window_json() {
        let smoke = "/tmp/h/.window-state.json";
        assert_eq!(state_path(Some(smoke), Some(PathBuf::from("/cfg"))), Some(PathBuf::from("/tmp/h/window.json")));
        assert_eq!(state_path(None, Some(PathBuf::from("/cfg"))), Some(PathBuf::from("/cfg/window.json")));
        assert_eq!(state_path(None, None), None);
    }

    #[test]
    fn save_creates_the_directory_and_load_reads_it_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join(FILE_NAME);
        let s = saved(10.0, 20.0, 320.0, 480.0, Some(sm("DELL", 0.0, 0.0)));
        save(&path, &s).unwrap();
        assert_eq!(load(&path), Some(s));
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(leftovers, vec![std::ffi::OsString::from(FILE_NAME)]);
    }

    #[test]
    fn load_of_a_missing_or_non_utf8_file_is_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(&dir.path().join("nope.json")), None);
        let bad = dir.path().join("bad.json");
        std::fs::write(&bad, [0xff, 0xfe, 0x7b]).unwrap();
        assert_eq!(load(&bad), None);
    }

    #[test]
    fn find_monitor_matches_by_name_then_by_position() {
        let ms = [main_mon(), ext_mon()];
        assert_eq!(find_monitor(&sm("DELL", -5120.0, -407.0), &ms), Some(1));
        // Name still connected but rearranged: still that monitor.
        assert_eq!(find_monitor(&sm("DELL", 2056.0, 0.0), &ms), Some(1));
        // Name unknown (renamed/driver change) but the origin is the same display.
        assert_eq!(find_monitor(&sm("Renamed", 0.0, 0.0), &ms), Some(0));
        assert_eq!(find_monitor(&sm("Gone", 9000.0, 9000.0), &ms), None);
        let no_name = SavedMonitor { name: None, x: -5120.0, y: -407.0 };
        assert_eq!(find_monitor(&no_name, &ms), Some(1));
    }

    #[test]
    fn find_monitor_breaks_a_name_tie_by_position() {
        let a = mon("Same", r(0.0, 0.0, 1000.0, 800.0), r(0.0, 0.0, 1000.0, 800.0));
        let b = mon("Same", r(1000.0, 0.0, 1000.0, 800.0), r(1000.0, 0.0, 1000.0, 800.0));
        assert_eq!(find_monitor(&sm("Same", 1000.0, 0.0), &[a, b]), Some(1));
    }

    #[test]
    fn a_saved_rect_on_a_connected_monitor_is_returned_as_is() {
        let s = saved(-2000.0, 100.0, 320.0, 480.0, Some(sm("DELL", -5120.0, -407.0)));
        let got = resolve_target(Some(&s), &[main_mon(), ext_mon()], Some((10.0, 10.0)), Some(0), (320.0, 480.0));
        assert_eq!(got, Some(r(-2000.0, 100.0, 320.0, 480.0)));
    }

    #[test]
    fn a_rearranged_monitor_carries_the_window_with_it() {
        let s = saved(-2000.0, 100.0, 320.0, 480.0, Some(sm("DELL", -5120.0, -407.0)));
        let moved = mon("DELL", r(-5000.0, -300.0, 5120.0, 1440.0), r(-5000.0, -300.0, 5120.0, 1440.0));
        let got = resolve_target(Some(&s), &[main_mon(), moved], None, Some(0), (320.0, 480.0));
        assert_eq!(got, Some(r(-1880.0, 207.0, 320.0, 480.0)));
    }

    #[test]
    fn a_disconnected_monitor_centers_the_saved_size_on_the_cursor_monitor() {
        let s = saved(-2000.0, 100.0, 520.0, 626.0, Some(sm("Unplugged", -9000.0, 0.0)));
        let got = resolve_target(Some(&s), &[main_mon(), ext_mon()], Some((-3000.0, 200.0)), Some(0), (320.0, 480.0));
        assert_eq!(got, Some(r(-2820.0, 0.0, 520.0, 626.0)));
    }

    #[test]
    fn a_cursor_outside_every_monitor_falls_back_to_the_primary() {
        let s = saved(0.0, 0.0, 320.0, 480.0, Some(sm("Unplugged", -9000.0, 0.0)));
        let got = resolve_target(Some(&s), &[ext_mon(), main_mon()], Some((99999.0, 0.0)), Some(1), (320.0, 480.0));
        assert_eq!(got, Some(r(868.0, 443.5, 320.0, 480.0)));
        let no_cursor = resolve_target(Some(&s), &[ext_mon(), main_mon()], None, None, (320.0, 480.0));
        assert_eq!(no_cursor, Some(r(-2720.0, 73.0, 320.0, 480.0)));
    }

    #[test]
    fn no_saved_state_uses_the_default_size_on_the_cursor_monitor() {
        let got = resolve_target(None, &[main_mon(), ext_mon()], Some((-3000.0, 200.0)), Some(0), (320.0, 480.0));
        assert_eq!(got, Some(r(-2720.0, 73.0, 320.0, 480.0)));
    }

    #[test]
    fn a_saved_size_larger_than_the_work_area_is_clamped_when_centering() {
        let s = saved(0.0, 0.0, 9000.0, 9000.0, None);
        let got = resolve_target(Some(&s), &[main_mon()], None, Some(0), (320.0, 480.0));
        assert_eq!(got, Some(r(0.0, 38.0, 2056.0, 1291.0)));
    }

    #[test]
    fn no_monitors_means_no_target() {
        assert_eq!(resolve_target(None, &[], None, None, (320.0, 480.0)), None);
    }
}
