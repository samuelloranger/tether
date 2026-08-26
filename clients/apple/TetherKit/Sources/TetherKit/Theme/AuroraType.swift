import SwiftUI

public extension View {
  /// Aurora's only section-heading device — micro label, uppercase, faint.
  func auroraEyebrow() -> some View {
    self
      .font(.system(size: 10, weight: .bold))
      .tracking(1.1)
      .textCase(.uppercase)
      .foregroundStyle(TetherColors.textFaint)
  }

  /// Machine values — mono + tabular.
  func auroraMono(_ size: CGFloat = 12.5) -> some View {
    self
      .font(.system(size: size, weight: .regular, design: .monospaced))
      .monospacedDigit()
  }
}
