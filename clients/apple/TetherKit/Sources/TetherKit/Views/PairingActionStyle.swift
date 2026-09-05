import SwiftUI

struct PairingActionStyle: ButtonStyle {
  let prominent: Bool
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.subheadline.weight(.semibold))
      .frame(maxWidth: .infinity)
      .padding(.vertical, 9)
      .background(background)
      .foregroundStyle(foreground)
      .clipShape(Capsule())
      .opacity(configuration.isPressed ? 0.75 : 1)
  }

  private var background: Color {
    guard isEnabled else { return TetherColors.textSecondary.opacity(0.14) }
    return prominent ? TetherColors.accent : TetherColors.accent.opacity(0.16)
  }

  private var foreground: Color {
    guard isEnabled else { return TetherColors.textSecondary }
    return prominent ? TetherColors.onAccent : TetherColors.accent
  }
}
