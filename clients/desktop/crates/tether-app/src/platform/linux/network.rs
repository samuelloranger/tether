use std::net::{IpAddr, SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::Mutex;
use std::time::Duration;

use netlink_sys::{Socket, SocketAddr as NetlinkAddr, protocols::NETLINK_ROUTE};

use crate::platform::windows::network::route_change;
use crate::terminal::model::Msg;

// RTMGRP_LINK | RTMGRP_IPV4_IFADDR | RTMGRP_IPV4_ROUTE | RTMGRP_IPV6_IFADDR | RTMGRP_IPV6_ROUTE
const GROUPS: u32 = 0x1 | 0x10 | 0x40 | 0x100 | 0x400;
/// A network change arrives as a burst of messages; wait for it to finish before looking.
const SETTLE: Duration = Duration::from_millis(300);

struct Watch {
    host: String,
    port: u16,
    route: Option<u32>,
    online: bool,
}
static WATCH: Mutex<Option<Watch>> = Mutex::new(None);
static REGISTERED: std::sync::Once = std::sync::Once::new();

/// The interface holding `local`, by name.
pub fn interface_of(local: IpAddr, addrs: &[(String, IpAddr)]) -> Option<&str> {
    addrs
        .iter()
        .find(|(_, ip)| *ip == local)
        .map(|(name, _)| name.as_str())
}

fn local_addrs() -> Vec<(String, IpAddr)> {
    let Ok(list) = nix::ifaddrs::getifaddrs() else {
        return Vec::new();
    };
    list.filter_map(|a| {
        let addr = a.address?;
        let ip = match (addr.as_sockaddr_in(), addr.as_sockaddr_in6()) {
            (Some(v4), _) => IpAddr::V4(v4.ip()),
            (_, Some(v6)) => IpAddr::V6(v6.ip()),
            _ => return None,
        };
        Some((a.interface_name, ip))
    })
    .collect()
}

/// The interface the kernel would send to the host from, found by asking it for a source address
/// (connecting a UDP socket sends nothing).
fn route_to(host: &str, port: u16) -> Option<u32> {
    let target = (host, port).to_socket_addrs().ok()?.next()?;
    let bind: SocketAddr = match target {
        SocketAddr::V4(_) => ([0, 0, 0, 0], 0).into(),
        SocketAddr::V6(_) => ([0u16; 8], 0).into(),
    };
    let socket = UdpSocket::bind(bind).ok()?;
    socket.connect(target).ok()?;
    let local = socket.local_addr().ok()?.ip();
    let name = interface_of(local, &local_addrs())?.to_string();
    nix::net::if_::if_nametoindex(name.as_str()).ok()
}

/// Whether to tell the model: a route change always, otherwise only when reachability flipped.
pub fn worth_reporting(was_online: bool, online: bool, route_changed: bool) -> bool {
    route_changed || was_online != online
}

fn recheck() {
    let mut guard = WATCH.lock().unwrap();
    let Some(w) = guard.as_mut() else { return };
    let now = route_to(&w.host, w.port);
    let (online, route_changed) = route_change(w.route, now, now.is_some());
    let report = worth_reporting(w.online, online, route_changed);
    w.online = online;
    if now.is_some() {
        w.route = now;
    }
    drop(guard);
    if report {
        super::deliver(Msg::Network {
            online,
            route_changed,
        });
    }
}

fn listen() -> std::io::Result<()> {
    let mut socket = Socket::new(NETLINK_ROUTE)?;
    socket.bind(&NetlinkAddr::new(0, GROUPS))?;
    socket.set_no_enobufs(true)?;
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        socket.recv(&mut &mut buf[..], 0)?;
        std::thread::sleep(SETTLE);
        socket.set_non_blocking(true)?;
        while socket.recv(&mut &mut buf[..], 0).is_ok() {}
        socket.set_non_blocking(false)?;
        recheck();
    }
}

/// Follows the route to the machine being used. Called on every open: the first call starts the
/// listener, and each call retargets it.
pub fn watch(host: String, port: u16) {
    std::thread::spawn(move || {
        let route = route_to(&host, port);
        *WATCH.lock().unwrap() = Some(Watch {
            host,
            port,
            route,
            online: route.is_some(),
        });
    });
    REGISTERED.call_once(|| {
        let spawned = std::thread::Builder::new()
            .name("netlink".into())
            .spawn(|| {
                if let Err(e) = listen() {
                    tracing::debug!("netlink watch stopped: {e}");
                }
            });
        if let Err(e) = spawned {
            tracing::debug!("netlink watch failed: {e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_source_address_belongs_to_the_interface_holding_it() {
        let addrs = vec![
            ("lo".to_string(), "127.0.0.1".parse().unwrap()),
            ("eth0".to_string(), "192.168.1.5".parse().unwrap()),
            ("eth0".to_string(), "fe80::1".parse().unwrap()),
        ];
        assert_eq!(
            interface_of("192.168.1.5".parse().unwrap(), &addrs),
            Some("eth0")
        );
        assert_eq!(
            interface_of("fe80::1".parse().unwrap(), &addrs),
            Some("eth0")
        );
        assert_eq!(interface_of("10.0.0.2".parse().unwrap(), &addrs), None);
    }

    #[test]
    fn only_a_flip_or_a_new_route_is_reported() {
        assert!(!worth_reporting(true, true, false));
        assert!(worth_reporting(true, true, true));
        assert!(worth_reporting(true, false, false));
        assert!(worth_reporting(false, true, false));
        assert!(!worth_reporting(false, false, false));
    }

    #[test]
    fn loopback_routes_through_lo() {
        let idx = route_to("127.0.0.1", 22);
        assert_eq!(idx, nix::net::if_::if_nametoindex("lo").ok());
    }
}
