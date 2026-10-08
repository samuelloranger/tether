//! How a program's progress maps onto a taskbar or launcher entry.

use crate::osc::{Progress, ProgressState};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskbarState {
    NoProgress,
    Normal,
    Error,
    Indeterminate,
    Paused,
}

pub fn taskbar_state(p: Option<&Progress>) -> (TaskbarState, Option<u64>) {
    let Some(p) = p else {
        return (TaskbarState::NoProgress, None);
    };
    let value = Some(p.percent as u64);
    match p.state {
        ProgressState::Normal => (TaskbarState::Normal, value),
        ProgressState::Error => (TaskbarState::Error, value),
        ProgressState::Paused => (TaskbarState::Paused, value),
        ProgressState::Indeterminate => (TaskbarState::Indeterminate, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_osc_9_4_state_maps_to_the_taskbar() {
        let p = |state, percent| Progress { state, percent };
        assert_eq!(taskbar_state(None), (TaskbarState::NoProgress, None));
        assert_eq!(
            taskbar_state(Some(&p(ProgressState::Normal, 40))),
            (TaskbarState::Normal, Some(40))
        );
        assert_eq!(
            taskbar_state(Some(&p(ProgressState::Error, 40))),
            (TaskbarState::Error, Some(40))
        );
        assert_eq!(
            taskbar_state(Some(&p(ProgressState::Paused, 10))),
            (TaskbarState::Paused, Some(10))
        );
        assert_eq!(
            taskbar_state(Some(&p(ProgressState::Indeterminate, 0))),
            (TaskbarState::Indeterminate, None)
        );
    }
}
