import Foundation

/// For a first attach this launch, before the live emulator exists; switch-back
/// reuses `TerminalSessionGrids` instead.
final class TerminalSnapshotCache {
  private var grids: [String: TerminalFrame] = [:]

  func remember(_ snapshot: TerminalFrame, for key: String) {
    grids[key] = snapshot
  }

  func openingSnapshot(for key: String) -> TerminalFrame? {
    grids[key]
  }

  func forget(_ key: String) {
    grids.removeValue(forKey: key)
  }
}
