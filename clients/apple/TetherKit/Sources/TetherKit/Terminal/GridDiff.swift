import Foundation

/// Row-granular change detection between two grid snapshots.
///
/// A frame of terminal output usually touches one or two rows, but the surface
/// repainted all of them. Comparing rows costs a handful of integer compares
/// per cell and lets the renderer skip the CoreText work for everything that
/// did not move.
public enum GridDiff {
  /// Rows whose cells differ.
  ///
  /// `nil` means "assume everything changed": the buffers do not describe the
  /// same geometry, so row indices are not comparable and the caller must
  /// repaint in full.
  public static func dirtyRows(
    previous: [GridSnapshot.Cell],
    current: [GridSnapshot.Cell],
    cols: Int,
    rows: Int
  ) -> [Int]? {
    guard cols > 0, rows > 0 else { return nil }
    let expected = cols * rows
    guard previous.count == expected, current.count == expected else { return nil }

    var dirty: [Int] = []
    for row in 0..<rows {
      let start = row * cols
      var changed = false
      for col in 0..<cols where previous[start + col] != current[start + col] {
        changed = true
        break
      }
      if changed { dirty.append(row) }
    }
    return dirty
  }
}
