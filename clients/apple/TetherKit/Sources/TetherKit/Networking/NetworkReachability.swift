import Network

/// A normalized `NWPath` reading: what the radio can route, nothing more.
///
/// A `.usable` value means the device has *a* path — never that the SSH host
/// answered, that the port is open, or that authentication succeeded. Those
/// remain the transport's job to report.
public struct NetworkReachability: Equatable, Sendable {
  public enum Availability: Equatable, Sendable {
    case offline
    /// The path needs something else first — a VPN dial, a captive portal.
    case requiresConnection
    case usable
  }

  public var availability: Availability

  public init(availability: Availability) {
    self.availability = availability
  }

  public var isUsable: Bool { availability == .usable }

  public static func classify(
    status: NWPath.Status,
    interfaces: [NWInterface.InterfaceType]
  ) -> NetworkReachability {
    let availability: Availability
    switch status {
    case .satisfied where !interfaces.isEmpty: availability = .usable
    case .satisfied: availability = .offline
    case .requiresConnection: availability = .requiresConnection
    case .unsatisfied: availability = .offline
    @unknown default: availability = .offline
    }
    return NetworkReachability(availability: availability)
  }

  public static func classify(_ path: NWPath) -> NetworkReachability {
    let known: [NWInterface.InterfaceType] = [.wifi, .cellular, .wiredEthernet, .loopback, .other]
    return classify(
      status: path.status,
      interfaces: known.filter(path.usesInterfaceType)
    )
  }
}
