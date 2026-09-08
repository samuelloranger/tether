import SwiftUI

/// The characteristic unit of an agent transcript: a tool call rendered as a
/// console card with a coloured left rail keyed to the tool, a monospace header
/// (glyph + name + one-line summary), and an expandable body showing the full
/// arguments — or, for file edits, an inline diff — plus the result.
public struct AgentToolCard: View {
  public let call: AgentToolCall
  @State private var expanded: Bool

  public init(call: AgentToolCall, startExpanded: Bool = false) {
    self.call = call
    _expanded = State(initialValue: startExpanded)
  }

  private var accent: Color { AgentToolStyle.accent(for: call.name) }

  public var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      if expanded { body(for: call) }
    }
    .background(TetherColors.surface)
    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay(alignment: .leading) {
      Rectangle().fill(accent).frame(width: 3)
    }
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .stroke(TetherColors.border, lineWidth: 1)
    )
    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
  }

  private var header: some View {
    Button {
      withAnimation(.easeOut(duration: 0.18)) { expanded.toggle() }
    } label: {
      HStack(spacing: 8) {
        Image(systemName: AgentToolStyle.glyph(for: call.name))
          .font(.caption.weight(.semibold))
          .foregroundStyle(accent)
        Text(call.name.lowercased())
          .font(.system(.caption, design: .monospaced).weight(.semibold))
          .foregroundStyle(accent)
        Text(call.summary)
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(TetherColors.textSecondary)
          .lineLimit(1)
          .truncationMode(.middle)
        Spacer(minLength: 4)
        if call.isError {
          Image(systemName: "exclamationmark.triangle.fill")
            .font(.caption2)
            .foregroundStyle(TetherColors.danger)
        }
        Image(systemName: expanded ? "chevron.up" : "chevron.down")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(TetherColors.textFaint)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 9)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  @ViewBuilder
  private func body(for call: AgentToolCall) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Divider().overlay(TetherColors.border)
      if let diff = call.diff, !diff.isEmpty {
        SideBySideDiffView(lines: parseDiffLines(diff), path: call.summary)
          .padding(.horizontal, 4)
      } else {
        Text(call.inputJSON)
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(TetherColors.textSecondary)
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 12)
      }
      if let result = call.result, !result.isEmpty {
        resultView(result)
      }
    }
    .padding(.bottom, 10)
  }

  private func resultView(_ result: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(call.isError ? "error" : "output")
        .font(.system(size: 10, weight: .bold, design: .monospaced))
        .tracking(0.8)
        .foregroundStyle(call.isError ? TetherColors.danger : TetherColors.textFaint)
      ScrollView(.vertical) {
        Text(result)
          .font(.system(.caption2, design: .monospaced))
          .foregroundStyle(
            call.isError ? TetherColors.danger : TetherColors.textSecondary
          )
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(maxHeight: 180)
    }
    .padding(.horizontal, 12)
  }
}
