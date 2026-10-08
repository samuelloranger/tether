//! Which network changes matter to a connection.

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
