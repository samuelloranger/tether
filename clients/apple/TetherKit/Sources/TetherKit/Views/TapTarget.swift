import SwiftUI

public extension View {
  /// Guarantees Apple's 44pt minimum touch target, and makes all of it live.
  ///
  /// The two halves have to travel together. A `Button` hit-tests its *label*,
  /// so an icon sitting in a larger frame leaves that frame transparent and
  /// therefore dead — sizing without `contentShape` buys nothing. Every icon
  /// button in the app used a bare 32pt or 36pt frame and had both problems at
  /// once, which is why they read as unreliable rather than as small.
  ///
  /// `minWidth`/`minHeight` rather than a fixed frame: a control with a label
  /// wider than 44pt keeps its own width and only gains the floor.
  func tapTarget(_ side: CGFloat = 44) -> some View {
    frame(minWidth: side, minHeight: side)
      .contentShape(Rectangle())
  }
}
