import Foundation

/// A burst of BEL characters rings once: `yes $'\a'` must not buzz the phone without end.
struct BellThrottle {
  static let window: TimeInterval = 0.2
  private var lastRing: TimeInterval?

  mutating func shouldRing(at now: TimeInterval) -> Bool {
    if let lastRing, now - lastRing < Self.window { return false }
    lastRing = now
    return true
  }
}

/// What the terminal does when a program rings the bell.
public enum BellMode: String, CaseIterable, Identifiable, Sendable {
  case off
  case haptic
  case flash
  case hapticAndFlash

  public var id: String { rawValue }

  public var label: String {
    switch self {
    case .off: "Off"
    case .haptic: "Haptic"
    case .flash: "Flash"
    case .hapticAndFlash: "Haptic + Flash"
    }
  }

  var haptic: Bool { self == .haptic || self == .hapticAndFlash }
  var flash: Bool { self == .flash || self == .hapticAndFlash }
}
