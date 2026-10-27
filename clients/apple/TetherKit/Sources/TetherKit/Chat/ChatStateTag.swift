import SwiftUI

extension DrawerChatState {
  var tint: Color {
    switch self {
    case .working, .tasks: TetherColors.accent
    case .waiting: TetherColors.warning
    case .running: TetherColors.success
    case .idle, .ended: TetherColors.textFaint
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
        Circle().fill(state.tint).frame(width: 6, height: 6)
          .opacity(state == .working && pulsing ? 0.35 : 1)
      }
      if case .tasks = state { ProgressView().controlSize(.mini).tint(TetherColors.accent) }
      Text(state.label).font(.caption2.monospaced().weight(state == .waiting ? .bold : .regular))
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
