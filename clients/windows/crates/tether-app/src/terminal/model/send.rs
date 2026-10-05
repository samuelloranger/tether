use std::path::PathBuf;

use super::*;

#[derive(Debug, Clone, PartialEq)]
pub struct SendJob;

pub(crate) struct SendState;

impl TerminalModel {
    pub(crate) fn on_send_files(&mut self, _paths: Vec<PathBuf>, _fx: &mut Vec<Effect>) {}
    pub(crate) fn on_send_started(&mut self, _names: Vec<String>) {}
    pub(crate) fn on_send_file_started(&mut self, _index: usize) {}
    pub(crate) fn on_send_file_done(
        &mut self,
        _remote: &str,
        _now: Duration,
        _fx: &mut Vec<Effect>,
    ) {
    }
    pub(crate) fn on_send_file_failed(&mut self, _reason: String, _now: Duration) {}
    pub(crate) fn send_capsule(&self) -> Option<String> {
        None
    }
}
