#![allow(dead_code)]
pub mod proxy;
pub mod server;
pub mod server_scp;

use std::time::Duration;

pub const TIMEOUT: Duration = Duration::from_secs(10);

pub fn transport() -> tether_ssh::RusshTransport {
    tether_ssh::RusshTransport::new(tokio::runtime::Handle::current())
}
