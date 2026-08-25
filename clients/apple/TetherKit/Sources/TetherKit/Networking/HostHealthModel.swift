import Foundation
import TetherFFIBindings

public enum HostHealthModel: Equatable, Sendable {
  case unknown
  case reachable
  case unreachable(failures: UInt32)
  case unauthorized

  public init(_ ffi: FfiHostHealth) {
    switch ffi {
    case .unknown:
      self = .unknown
    case .reachable:
      self = .reachable
    case let .unreachable(failures: failures):
      self = .unreachable(failures: failures)
    case .unauthorized:
      self = .unauthorized
    }
  }

  public var ffi: FfiHostHealth {
    switch self {
    case .unknown:
      .unknown
    case .reachable:
      .reachable
    case let .unreachable(failures):
      .unreachable(failures: failures)
    case .unauthorized:
      .unauthorized
    }
  }
}

public enum HostHealthLogic {
  public static func initial() -> HostHealthModel {
    HostHealthModel(ffiInitialHostHealth())
  }

  public static func afterFailure(_ health: HostHealthModel) -> HostHealthModel {
    HostHealthModel(ffiHostHealthAfterFailure(health: health.ffi))
  }

  public static func afterResponse(_ health: HostHealthModel, status: UInt16) -> HostHealthModel {
    HostHealthModel(ffiHostHealthAfterResponse(health: health.ffi, status: status))
  }

  public static func shouldPoll(_ health: HostHealthModel) -> Bool {
    ffiShouldPollHost(health: health.ffi)
  }

  public static func nextPollDelay(_ health: HostHealthModel, normalIntervalMs: UInt64) -> UInt64? {
    ffiNextHostPollDelay(health: health.ffi, normalIntervalMs: normalIntervalMs)
  }
}
