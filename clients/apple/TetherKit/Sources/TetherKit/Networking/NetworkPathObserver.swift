import Foundation
import Network

/// Reports normalized `NWPathMonitor` changes on the main actor. It decides nothing:
/// whether a change is worth a redial is the terminal controller's call.
@MainActor
public final class NetworkPathObserver {
  private let queue = DispatchQueue(label: "cloud.samlo.tether.network-path")
  /// Recreated on each start: a cancelled `NWPathMonitor` cannot be restarted, and
  /// a screen can be left and re-entered.
  private var monitor: NWPathMonitor?
  private var onChange: ((NetworkReachability) -> Void)?

  public init() {}

  public func start(onChange: @escaping (NetworkReachability) -> Void) {
    guard monitor == nil else { return }
    self.onChange = onChange
    let monitor = NWPathMonitor()
    self.monitor = monitor
    monitor.pathUpdateHandler = { path in
      // Leave the monitor queue before touching observable state.
      let value = NetworkReachability.classify(path)
      Task { @MainActor [weak self] in self?.deliver(value) }
    }
    monitor.start(queue: queue)
  }

  public func stop() {
    monitor?.pathUpdateHandler = nil
    monitor?.cancel()
    monitor = nil
    onChange = nil
  }

  private func deliver(_ value: NetworkReachability) {
    onChange?(value)
  }
}
