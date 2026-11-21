import SwiftUI

/// The end of a finished turn: the files it changed and the commands it ran, readable at a glance
/// after coming back to the chat.
struct ChatTurnReceiptView: View {
  let receipt: ChatTurnReceipt

  private static let shown = 6

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if !receipt.changed.isEmpty {
        section("Changed", count: receipt.changed.count) {
          ForEach(receipt.changed.prefix(Self.shown), id: \.path) { change in
            line(change.path) {
              HStack(spacing: 5) {
                if change.added > 0 { Text("+\(change.added)").foregroundStyle(TetherColors.success) }
                if change.removed > 0 { Text("\u{2212}\(change.removed)").foregroundStyle(TetherColors.danger) }
              }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(change.path), \(change.added) added, \(change.removed) removed")
          }
        }
      }
      if !receipt.changed.isEmpty, !receipt.ran.isEmpty {
        Rectangle().fill(TetherColors.border).frame(height: 0.5)
      }
      if !receipt.ran.isEmpty {
        section("Ran", count: receipt.ran.count) {
          ForEach(Array(receipt.ran.prefix(Self.shown).enumerated()), id: \.offset) { _, command in
            line(command.title) {
              if command.failed { Text("failed").foregroundStyle(TetherColors.danger) }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(command.failed ? "\(command.title), failed" : command.title)
          }
        }
      }
    }
    .padding(.horizontal, 14)
    .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 14))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("chatTurnReceipt")
  }

  private func section<Rows: View>(_ label: String, count: Int, @ViewBuilder rows: () -> Rows) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Text(label).font(.chat(.caption)).foregroundStyle(TetherColors.textFaint)
        .frame(width: 64, alignment: .leading)
        .accessibilityAddTraits(.isHeader)
      VStack(alignment: .leading, spacing: 4) {
        rows()
        if count > Self.shown {
          Text("\(count - Self.shown) more").font(.chat(.caption)).foregroundStyle(TetherColors.textFaint)
        }
      }
    }
    .padding(.vertical, 10)
  }

  private func line<Trailing: View>(_ text: String, @ViewBuilder trailing: () -> Trailing) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(text).font(.caption.monospaced()).foregroundStyle(TetherColors.textPrimary)
        .lineLimit(1).truncationMode(.middle)
        .frame(maxWidth: .infinity, alignment: .leading)
      trailing().font(.chat(.caption).monospacedDigit())
    }
  }
}
