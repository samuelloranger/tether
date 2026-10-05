use std::rc::Rc;

use tether_core::Machine;

use crate::app::App;

pub fn on_open_machine(app: &Rc<App>, machine: Machine) {
    crate::terminal::glue::open_machine(app, machine);
}
