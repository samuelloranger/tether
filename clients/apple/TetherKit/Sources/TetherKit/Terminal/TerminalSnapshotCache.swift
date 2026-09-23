import Foundation

/// Last grid shown for each host-qualified session.
///
/// Used on a first attach this launch when the live emulator has not been
/// built yet. Switch-back reuses `TerminalSessionGrids` instead of this.
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
