use std::rc::Rc;

use tether_core::Machine;

use crate::app::App;

/// M6 replaces this body with the connect flow.
pub fn on_open_machine(_app: &Rc<App>, machine: Machine) {
    tracing::info!(machine = %machine.name, "open requested");
}
