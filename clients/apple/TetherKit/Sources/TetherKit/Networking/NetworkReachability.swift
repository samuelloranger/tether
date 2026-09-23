import Network

/// A normalized `NWPath` reading. `.usable` means the device has *a* path, never that the
/// SSH host answered or that auth succeeded; that stays the transport's job.
public struct NetworkReachability: Equatable, Sendable {
  public enum Availability: Equatable, Sendable {
    case offline
    /// The path needs something else first — a VPN dial, a captive portal.
    case requiresConnection
    case usable
  }

  public var availability: Availability
  /// Usable interfaces, most preferred first; empty unless usable.
  public var interfaces: [NWInterface.InterfaceType]

  public init(availability: Availability, interfaces: [NWInterface.InterfaceType] = []) {
    self.availability = availability
    self.interfaces = interfaces
  }

  public var isUsable: Bool { availability == .usable }
  public var primary: NWInterface.InterfaceType? { interfaces.first }

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
    return NetworkReachability(availability: availability, interfaces: availability == .usable ? interfaces : [])
  }

  public static func classify(_ path: NWPath) -> NetworkReachability {
    classify(status: path.status, interfaces: path.availableInterfaces.map(\.type))
  }
}
