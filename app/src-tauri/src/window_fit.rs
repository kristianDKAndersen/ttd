//! Pure geometry for keeping the main window on a monitor when it is placed or re-shown.
//! All values are logical pixels (macOS points); callers convert from physical with each monitor's own scale.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// A window counts as "on a monitor" when at least this many logical px of it (both axes) overlap a work area.
pub const MIN_VISIBLE: f64 = 80.0;

/// Where `window` should be so the user can see it: unchanged when it is already inside a work area, nudged
/// inside the area it overlaps most, or centered on the primary area (else the first) when it overlaps none
/// by `MIN_VISIBLE`. The size is clamped to the target area. No areas: unchanged.
pub fn fit(window: Rect, areas: &[Rect], primary: Option<usize>) -> Rect {
    if areas.is_empty() {
        return window;
    }
    let overlap = |a: &Rect| ((window.x + window.w).min(a.x + a.w) - window.x.max(a.x), (window.y + window.h).min(a.y + a.h) - window.y.max(a.y));
    let mut best: Option<(&Rect, f64)> = None;
    for a in areas {
        let (ow, oh) = overlap(a);
        if ow >= MIN_VISIBLE.min(window.w) && oh >= MIN_VISIBLE.min(window.h) && best.is_none_or(|(_, size)| ow * oh > size) {
            best = Some((a, ow * oh));
        }
    }
    let (target, centered) = match best {
        Some((a, _)) => (*a, false),
        None => (areas[primary.filter(|&i| i < areas.len()).unwrap_or(0)], true),
    };
    let (w, h) = (window.w.min(target.w), window.h.min(target.h));
    if centered {
        Rect { x: target.x + (target.w - w) / 2.0, y: target.y + (target.h - h) / 2.0, w, h }
    } else {
        Rect { x: window.x.clamp(target.x, target.x + target.w - w), y: window.y.clamp(target.y, target.y + target.h - h), w, h }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: Rect = Rect { x: 0.0, y: 38.0, w: 2056.0, h: 1291.0 };
    const EXT: Rect = Rect { x: -5120.0, y: -407.0, w: 5120.0, h: 1440.0 };
    fn r(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn keeps_a_window_that_is_fully_on_a_monitor() {
        let w = r(100.0, 100.0, 320.0, 480.0);
        assert_eq!(fit(w, &[MAIN, EXT], Some(0)), w);
    }

    #[test]
    fn no_monitors_leaves_the_window_alone() {
        let w = r(5000.0, 5000.0, 320.0, 480.0);
        assert_eq!(fit(w, &[], None), w);
    }

    #[test]
    fn window_right_of_every_monitor_is_centered_on_the_primary() {
        // The saved state from the bug report: logical x=2936 is right of both displays.
        let got = fit(r(2936.0, 66.0, 1040.0, 1252.0), &[MAIN, EXT], Some(0));
        assert_eq!(got, r(508.0, 57.5, 1040.0, 1252.0));
    }

    #[test]
    fn window_hanging_below_its_monitor_is_nudged_back_inside() {
        // Observed live: x=-1841 y=-109 1040x1252 on the external display whose bottom edge is y=1033.
        let got = fit(r(-1841.0, -109.0, 1040.0, 1252.0), &[MAIN, EXT], Some(0));
        assert_eq!(got, r(-1841.0, -219.0, 1040.0, 1252.0));
    }

    #[test]
    fn a_sliver_of_overlap_is_not_enough() {
        let got = fit(r(2056.0 - 40.0, 100.0, 320.0, 480.0), &[MAIN], Some(0));
        assert_eq!(got, r(868.0, 443.5, 320.0, 480.0));
    }

    #[test]
    fn a_window_larger_than_the_work_area_is_clamped_to_it() {
        let got = fit(r(10.0, 10.0, 3000.0, 2000.0), &[MAIN], Some(0));
        assert_eq!(got, MAIN);
    }

    #[test]
    fn picks_the_monitor_with_the_largest_overlap() {
        // Mostly on EXT (right edge at x=0), a little on MAIN.
        let got = fit(r(-900.0, 100.0, 1000.0, 400.0), &[MAIN, EXT], Some(0));
        assert_eq!(got, r(-1000.0, 100.0, 1000.0, 400.0));
    }

    #[test]
    fn missing_primary_falls_back_to_the_first_monitor() {
        let got = fit(r(9000.0, 0.0, 320.0, 480.0), &[EXT, MAIN], None);
        assert_eq!(got, r(-2720.0, 73.0, 320.0, 480.0));
    }

    #[test]
    fn out_of_range_primary_index_falls_back_to_the_first_monitor() {
        let got = fit(r(9000.0, 0.0, 320.0, 480.0), &[MAIN], Some(7));
        assert_eq!(got, r(868.0, 443.5, 320.0, 480.0));
    }
}
