import Foundation

/// Last packed grid shown for each host-qualified session.
///
/// Noise `start` always full-replays, so the live emulator cannot be reused
/// across a switch (that would double-apply bytes). The last TGRD frame can:
/// showing it on attach is what stops the surface going blank until replay lands.
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
