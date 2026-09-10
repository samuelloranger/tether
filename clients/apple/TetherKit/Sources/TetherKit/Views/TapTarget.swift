import SwiftUI

public extension View {
  /// 44pt minimum touch target, all of it live. `contentShape` makes the extra frame
  /// hit-testable (a Button hit-tests only its label); minWidth keeps a wider label's width.
  func tapTarget(_ side: CGFloat = 44) -> some View {
    frame(minWidth: side, minHeight: side)
      .contentShape(Rectangle())
  }
}
