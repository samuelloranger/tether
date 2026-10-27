import SwiftUI

/// The background commands still running, above the composer. Several collapse under a count.
struct ChatTaskStrip: View {
  let commands: [ChatToolCall]
  let open: (ChatToolCall) -> Void

  #if DEBUG
  @State private var expanded = ChatFixture.openTasks
  #else
  @State private var expanded = false
  #endif
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var showsLines: Bool { commands.count == 1 || expanded }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if commands.count > 1 {
        Button {
          withAnimation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion)) { expanded.toggle() }
        } label: {
          HStack(spacing: 6) {
            ProgressView().controlSize(.mini).tint(TetherColors.accent)
            Text("\(commands.count) running").font(.caption.monospaced()).foregroundStyle(TetherColors.textSecondary)
            Spacer(minLength: 6)
            Image(systemName: expanded ? "chevron.down" : "chevron.right")
              .font(.caption2.weight(.semibold)).foregroundStyle(TetherColors.textFaint)
          }
          .padding(.horizontal, 10).frame(minHeight: 30)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(commands.count) background commands running")
        .accessibilityHint(expanded ? "Hides the commands" : "Shows the commands")
        .accessibilityIdentifier("chatTaskStripHeader")
      }
      if showsLines {
        ForEach(commands, id: \.id) { call in
          Button { open(call) } label: {
            HStack(spacing: 6) {
              if commands.count == 1 { ProgressView().controlSize(.mini).tint(TetherColors.accent) }
              Text(call.title).font(.caption.monospaced()).foregroundStyle(TetherColors.textSecondary)
                .lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 10).frame(minHeight: 30)
            .padding(.leading, commands.count == 1 ? 0 : 16)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Background command: \(call.title)")
        }
      }
    }
    .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(TetherColors.border, lineWidth: 1))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("chatTaskStrip")
  }
}
