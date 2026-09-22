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
  public var usesWiFi: Bool
  public var usesCellular: Bool
  public var isExpensive: Bool
  public var isConstrained: Bool

  public init(
    availability: Availability,
    usesWiFi: Bool = false,
    usesCellular: Bool = false,
    isExpensive: Bool = false,
    isConstrained: Bool = false
  ) {
    self.availability = availability
    self.usesWiFi = usesWiFi
    self.usesCellular = usesCellular
    self.isExpensive = isExpensive
    self.isConstrained = isConstrained
  }

  public var isUsable: Bool { availability == .usable }

  public static func classify(
    status: NWPath.Status,
    interfaces: [NWInterface.InterfaceType],
    isExpensive: Bool,
    isConstrained: Bool
  ) -> NetworkReachability {
    let availability: Availability
    switch status {
    case .satisfied: availability = .usable
    case .requiresConnection: availability = .requiresConnection
    case .unsatisfied: availability = .offline
    @unknown default: availability = .offline
    }
    // Interface facts only mean something on a path that can carry traffic;
    // a down path still reports the interfaces it would have used.
    let routable = availability == .usable
    return NetworkReachability(
      availability: availability,
      usesWiFi: routable && interfaces.contains(.wifi),
      usesCellular: routable && interfaces.contains(.cellular),
      isExpensive: routable && isExpensive,
      isConstrained: routable && isConstrained
    )
  }

  public static func classify(_ path: NWPath) -> NetworkReachability {
    let known: [NWInterface.InterfaceType] = [.wifi, .cellular, .wiredEthernet, .loopback, .other]
    return classify(
      status: path.status,
      interfaces: known.filter(path.usesInterfaceType),
      isExpensive: path.isExpensive,
      isConstrained: path.isConstrained
    )
  }
}
