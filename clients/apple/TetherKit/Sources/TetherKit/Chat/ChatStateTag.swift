import SwiftUI

extension DrawerChatState {
  var tint: Color {
    switch self {
    case .working, .tasks, .running: TetherColors.textSecondary
    case .waiting: TetherColors.textPrimary
    case .idle, .ended: TetherColors.textSecondary
    }
  }
}

/// The word is the state; the colour only reinforces it. A working chat pulses like a terminal
/// session's agent tag, a chat that needs an answer is bolder.
struct ChatStateTag: View {
  let state: DrawerChatState
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var pulsing = false

  var body: some View {
    HStack(spacing: 4) {
      if state == .working || state == .waiting {
        Circle().fill(TetherColors.textPrimary).frame(width: 6, height: 6)
          .opacity(state == .working && pulsing ? 0.35 : 1)
      }
      if case .tasks = state { ProgressView().controlSize(.mini).tint(TetherColors.textSecondary) }
      Text(state.label).font(.app(.caption).weight(state == .waiting ? .semibold : .regular))
    }
    .foregroundStyle(state.tint)
    .fixedSize()
    .onAppear {
      guard state == .working, !reduceMotion else { return }
      withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { pulsing = true }
    }
    .accessibilityHidden(true)
  }
}
