import SwiftUI

/// "working" / "needs you" / "done 5m" — always words, colour only reinforces them.
struct AgentStatusTag: View {
  let status: AgentStatus
  let now: Date
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var pulsing = false

  static func label(for status: AgentStatus, now: Date) -> String {
    switch status.state {
    case .working: return "working"
    case .waiting: return "needs you"
    case .done: return "done \(AgentStatus.ageLabel(since: status.since, now: now))"
    }
  }

  private var color: Color {
    switch status.state {
    case .working: return TetherColors.accent
    case .waiting: return TetherColors.warning
    case .done: return TetherColors.textFaint
    }
  }

  var body: some View {
    HStack(spacing: 4) {
      Circle().fill(color).frame(width: 6, height: 6)
        .opacity(status.state == .working && pulsing ? 0.35 : 1)
      Text(Self.label(for: status, now: now)).font(.caption2.monospaced())
    }
    .foregroundStyle(color)
    .onAppear {
      guard status.state == .working, !reduceMotion else { return }
      withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { pulsing = true }
    }
    .accessibilityHidden(true)
  }
}

/// Another session on this host needs attention; tap to go there.
struct AgentAlertBanner: View {
  let alert: AgentStatus
  let onOpen: () -> Void
  let onDismiss: () -> Void

  private var text: String {
    let verb = alert.state == .waiting ? "needs you" : "done"
    return alert.message.isEmpty ? "\(alert.session) · \(verb)" : "\(alert.session) · \(verb) — \(alert.message)"
  }

  var body: some View {
    HStack(spacing: 8) {
      Button(action: onOpen) {
        HStack(spacing: 8) {
          Circle().fill(alert.state == .waiting ? TetherColors.warning : TetherColors.textFaint)
            .frame(width: 7, height: 7)
          Text(text).font(.caption.monospaced()).foregroundStyle(TetherColors.textPrimary)
            .lineLimit(1).truncationMode(.tail)
          Spacer(minLength: 4)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(TetherPressStyle())
      .accessibilityIdentifier("agentAlertBanner")
      .accessibilityLabel(text)
      .accessibilityHint("Switches to \(alert.session)")
      Button(action: onDismiss) {
        Image(systemName: "xmark").font(.caption.weight(.semibold)).foregroundStyle(TetherColors.textFaint)
          .frame(width: 32, height: 32).contentShape(Rectangle())
      }
      .buttonStyle(TetherPressStyle())
      .accessibilityIdentifier("agentAlertDismiss")
      .accessibilityLabel("Dismiss")
    }
    .padding(.leading, 12).padding(.trailing, 4).padding(.vertical, 4)
    .background(TetherColors.surface)
    .overlay(alignment: .bottom) { Rectangle().fill(TetherColors.border).frame(height: 1) }
  }
}

/// Claude is asking a question in this session. Floats over the terminal so nothing
/// underneath moves; the sheet answers it instead of the dialog's keys.
struct HeldQuestionBanner: View {
  let status: AgentStatus
  let onAnswer: () -> Void
  let onDismiss: () -> Void

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "questionmark.bubble.fill").foregroundStyle(TetherColors.accent)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 1) {
        Text("Claude is asking").font(.caption2.weight(.semibold)).foregroundStyle(TetherColors.textSecondary)
        Text(status.message.isEmpty ? "A question" : status.message)
          .font(.footnote).foregroundStyle(TetherColors.textPrimary).lineLimit(1).truncationMode(.tail)
      }
      Spacer(minLength: 4)
      Button(action: onAnswer) {
        Text("Answer").font(.footnote.weight(.semibold)).foregroundStyle(TetherColors.onAccent)
          .padding(.horizontal, 14).padding(.vertical, 7)
          .background(TetherColors.accent, in: Capsule())
      }
      .buttonStyle(TetherPressStyle())
      .accessibilityIdentifier("heldQuestionAnswer")
      Button(action: onDismiss) {
        Image(systemName: "xmark").font(.caption.weight(.semibold)).foregroundStyle(TetherColors.textFaint)
          .frame(width: 28, height: 28).contentShape(Rectangle())
      }
      .buttonStyle(TetherPressStyle())
      .accessibilityIdentifier("heldQuestionDismiss")
      .accessibilityLabel("Dismiss")
    }
    .padding(.leading, 14).padding(.trailing, 6).padding(.vertical, 8)
    .background(TetherColors.surface.opacity(0.97), in: RoundedRectangle(cornerRadius: 14))
    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(TetherColors.border))
    .shadow(color: .black.opacity(0.35), radius: 10, y: 3)
    .padding(.horizontal, 12).padding(.bottom, 10)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Claude is asking: \(status.message)")
  }
}
