import Foundation

/// Last packed grid shown for each host-qualified session.
///
/// Used on a first attach this launch when the live emulator has not been
/// built yet. Switch-back reuses `TerminalSessionGrids` instead of this.
final class TerminalSnapshotCache {
  private var grids: [String: Data] = [:]

  func remember(_ snapshot: Data, for key: String) {
    grids[key] = snapshot
  }

  func openingSnapshot(for key: String) -> Data? {
    grids[key]
  }

  func forget(_ key: String) {
    grids.removeValue(forKey: key)
  }
}
