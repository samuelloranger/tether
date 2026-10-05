/// `(online, route_changed)`. The route is the interface index Windows would use for the host.
/// A change counts only when both sides are known and differ.
pub fn route_change(previous: Option<u32>, now: Option<u32>, online: bool) -> (bool, bool) {
    let changed = online && matches!((previous, now), (Some(a), Some(b)) if a != b);
    (online, changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_different_known_interface_is_a_route_change() {
        assert_eq!(route_change(Some(5), Some(5), true), (true, false));
        assert_eq!(route_change(Some(5), Some(9), true), (true, true));
        assert_eq!(route_change(None, Some(9), true), (true, false));
        assert_eq!(route_change(Some(5), None, true), (true, false));
        assert_eq!(route_change(Some(5), Some(9), false), (false, false));
    }
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::net::{SocketAddr, ToSocketAddrs};
    use std::sync::Mutex;
    use windows::Networking::Connectivity::{
        NetworkConnectivityLevel, NetworkInformation, NetworkStatusChangedEventHandler,
    };
    use windows::Win32::NetworkManagement::IpHelper::GetBestInterfaceEx;
    use windows::Win32::Networking::WinSock::{
        AF_INET, AF_INET6, IN_ADDR, IN_ADDR_0, IN6_ADDR, IN6_ADDR_0, SOCKADDR, SOCKADDR_IN,
        SOCKADDR_IN6,
    };

    struct Watch {
        host: String,
        port: u16,
        route: Option<u32>,
    }
    static WATCH: Mutex<Option<Watch>> = Mutex::new(None);
    static REGISTERED: std::sync::Once = std::sync::Once::new();

    fn route_to(host: &str, port: u16) -> Option<u32> {
        let addr = (host, port).to_socket_addrs().ok()?.next()?;
        let mut index = 0u32;
        let rc = unsafe {
            match addr {
                SocketAddr::V4(a) => {
                    let sa = SOCKADDR_IN {
                        sin_family: AF_INET,
                        sin_port: a.port().to_be(),
                        sin_addr: IN_ADDR {
                            S_un: std::mem::transmute::<u32, IN_ADDR_0>(u32::from_ne_bytes(
                                a.ip().octets(),
                            )),
                        },
                        ..Default::default()
                    };
                    GetBestInterfaceEx(&sa as *const _ as *const SOCKADDR, &mut index)
                }
                SocketAddr::V6(a) => {
                    let sa = SOCKADDR_IN6 {
                        sin6_family: AF_INET6,
                        sin6_port: a.port().to_be(),
                        sin6_addr: IN6_ADDR {
                            u: std::mem::transmute::<[u8; 16], IN6_ADDR_0>(a.ip().octets()),
                        },
                        ..Default::default()
                    };
                    GetBestInterfaceEx(&sa as *const _ as *const SOCKADDR, &mut index)
                }
            }
        };
        (rc == 0).then_some(index)
    }

    fn online() -> bool {
        NetworkInformation::GetInternetConnectionProfile()
            .and_then(|p| p.GetNetworkConnectivityLevel())
            .is_ok_and(|level| level != NetworkConnectivityLevel::None)
    }

    pub fn watch(host: String, port: u16) {
        std::thread::spawn(move || {
            let route = route_to(&host, port);
            *WATCH.lock().unwrap() = Some(Watch { host, port, route });
        });
        REGISTERED.call_once(|| {
            let handler = NetworkStatusChangedEventHandler::new(|_| {
                let mut guard = WATCH.lock().unwrap();
                let Some(w) = guard.as_mut() else {
                    return Ok(());
                };
                let now = route_to(&w.host, w.port);
                let (online, route_changed) = route_change(w.route, now, online());
                if now.is_some() {
                    w.route = now;
                }
                let _ = slint::invoke_from_event_loop(move || {
                    if let Some(s) = crate::terminal::glue::current() {
                        s(crate::terminal::model::Msg::Network {
                            online,
                            route_changed,
                        });
                    }
                });
                Ok(())
            });
            let _ = NetworkInformation::NetworkStatusChanged(&handler);
        });
    }
}
#[cfg(windows)]
pub use win::watch;
