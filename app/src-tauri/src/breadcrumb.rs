//! `app.json` breadcrumb (STORE.md section 1): `{"path": <abs exe path>, "version", "writtenAt"}`,
//! written at start so the Claude Code mod's launcher can find this binary.

use std::io;
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "app.json";

/// The path to advertise: `$APPIMAGE` when set and non-empty (the exe of an AppImage lives in a
/// temporary mount), else the current executable.
pub fn exe_path(get_env: impl Fn(&str) -> Option<String>, current_exe: impl FnOnce() -> io::Result<PathBuf>) -> io::Result<PathBuf> {
    match get_env("APPIMAGE").filter(|v| !v.is_empty()) {
        Some(appimage) => Ok(PathBuf::from(appimage)),
        None => current_exe(),
    }
}

/// Atomic write: temp file in `home`, then rename over `app.json`. Creates `home` if needed.
pub fn write(home: &Path, exe: &Path, version: &str, written_at: &str) -> io::Result<()> {
    std::fs::create_dir_all(home)?;
    let body = serde_json::json!({ "path": exe.to_string_lossy(), "version": version, "writtenAt": written_at });
    let tmp = home.join(format!("{FILE_NAME}.tmp-{}", std::process::id()));
    let result = std::fs::write(&tmp, format!("{body}\n")).and_then(|()| std::fs::rename(&tmp, home.join(FILE_NAME)));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// RFC 3339 UTC timestamp for `writtenAt`.
pub fn now_iso() -> String {
    time::OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| m.get(k).cloned()
    }

    fn read_json(p: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap()
    }

    #[test]
    fn appimage_takes_precedence_over_current_exe() {
        let got = exe_path(env(&[("APPIMAGE", "/home/u/TTD.AppImage")]), || Ok(PathBuf::from("/tmp/.mount_x/usr/bin/ttd"))).unwrap();
        assert_eq!(got, PathBuf::from("/home/u/TTD.AppImage"));
    }

    #[test]
    fn empty_appimage_falls_back_to_current_exe() {
        let got = exe_path(env(&[("APPIMAGE", "")]), || Ok(PathBuf::from("/opt/ttd"))).unwrap();
        assert_eq!(got, PathBuf::from("/opt/ttd"));
        let got = exe_path(env(&[]), || Ok(PathBuf::from("/opt/ttd"))).unwrap();
        assert_eq!(got, PathBuf::from("/opt/ttd"));
    }

    #[test]
    fn current_exe_error_propagates_when_no_appimage() {
        assert!(exe_path(env(&[]), || Err(io::Error::other("nope"))).is_err());
    }

    #[test]
    fn writes_the_documented_shape_and_creates_home() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("nested").join(".ttd");
        write(&home, Path::new("/Applications/TTD.app/Contents/MacOS/ttd"), "0.1.0", "2026-11-06T01:02:03Z").unwrap();
        let v = read_json(&home.join(FILE_NAME));
        assert_eq!(v["path"], "/Applications/TTD.app/Contents/MacOS/ttd");
        assert_eq!(v["version"], "0.1.0");
        assert_eq!(v["writtenAt"], "2026-11-06T01:02:03Z");
        assert_eq!(v.as_object().unwrap().len(), 3);
    }

    #[test]
    fn write_replaces_atomically_and_leaves_no_temp_files() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(FILE_NAME), "{garbage").unwrap();
        write(tmp.path(), Path::new("/a/ttd"), "0.1.0", "2026-11-06T00:00:00Z").unwrap();
        write(tmp.path(), Path::new("/b/ttd"), "0.1.0", "2026-11-06T00:00:01Z").unwrap();
        assert_eq!(read_json(&tmp.path().join(FILE_NAME))["path"], "/b/ttd");
        let names: Vec<_> = std::fs::read_dir(tmp.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec![FILE_NAME.to_string()]);
    }

    #[test]
    fn paths_with_quotes_and_backslashes_are_escaped() {
        let tmp = tempfile::tempdir().unwrap();
        let weird = r#"C:\Users\a "b"\ttd.exe"#;
        write(tmp.path(), Path::new(weird), "0.1.0", "2026-11-06T00:00:00Z").unwrap();
        assert_eq!(read_json(&tmp.path().join(FILE_NAME))["path"], weird);
    }

    #[test]
    fn now_iso_is_rfc3339_utc() {
        let s = now_iso();
        assert!(s.ends_with('Z') && s.len() >= 20 && s.as_bytes()[10] == b'T', "{s}");
    }
}
