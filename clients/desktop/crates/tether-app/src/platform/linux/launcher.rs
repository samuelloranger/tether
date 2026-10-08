use std::collections::HashMap;

use tether_core::osc::Progress;
use zbus::blocking::Connection;
use zbus::zvariant::Value;

use tether_core::taskbar::{TaskbarState, taskbar_state};

const APP_URI: &str = "application://tether.desktop";
const PATH: &str = "/com/canonical/unity/launcherentry/1";
const INTERFACE: &str = "com.canonical.Unity.LauncherEntry";

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LauncherUpdate {
    pub progress: f64,
    pub visible: bool,
    pub urgent: bool,
}

/// The Unity launcher protocol has a single bar: paused and error show their value as a normal
/// bar (an error also marks the entry urgent) and an indeterminate one shows an empty bar.
pub fn launcher_update(p: Option<&Progress>) -> LauncherUpdate {
    let (state, value) = taskbar_state(p);
    let progress = value.map_or(0.0, |v| v.min(100) as f64 / 100.0);
    LauncherUpdate {
        progress,
        visible: state != TaskbarState::NoProgress,
        urgent: state == TaskbarState::Error,
    }
}

pub fn emit(conn: &Connection, u: LauncherUpdate) {
    let props: HashMap<&str, Value> = HashMap::from([
        ("progress", Value::from(u.progress)),
        ("progress-visible", Value::from(u.visible)),
        ("urgent", Value::from(u.urgent)),
    ]);
    if let Err(e) = conn.emit_signal(None::<&str>, PATH, INTERFACE, "Update", &(APP_URI, props)) {
        tracing::debug!("launcher update failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tether_core::osc::ProgressState;

    fn update(state: ProgressState, percent: u8) -> LauncherUpdate {
        launcher_update(Some(&Progress { state, percent }))
    }

    #[test]
    fn each_osc_9_4_state_maps_to_the_launcher_entry() {
        let none = launcher_update(None);
        assert_eq!(
            (none.visible, none.urgent, none.progress),
            (false, false, 0.0)
        );
        let normal = update(ProgressState::Normal, 40);
        assert_eq!(
            (normal.visible, normal.urgent, normal.progress),
            (true, false, 0.4)
        );
        let error = update(ProgressState::Error, 100);
        assert_eq!(
            (error.visible, error.urgent, error.progress),
            (true, true, 1.0)
        );
        assert_eq!(update(ProgressState::Paused, 10).progress, 0.1);
        let wait = update(ProgressState::Indeterminate, 0);
        assert_eq!((wait.visible, wait.progress), (true, 0.0));
    }
}
