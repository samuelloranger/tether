import SwiftUI

/// A subagent launch: one compact row that opens onto the agent's own tool calls, its brief and,
/// for a foreground run, its report.
struct SubagentRow: View {
  let call: ChatToolCall
  let cwd: String
  let expanded: Bool
  let toggle: () -> Void

  @State private var openChildren: Set<String>
  @State private var briefOpen: Bool

  init(call: ChatToolCall, cwd: String, expanded: Bool, toggle: @escaping () -> Void) {
    self.call = call
    self.cwd = cwd
    self.expanded = expanded
    self.toggle = toggle
    #if DEBUG
    let open = ChatFixture.openSubagents
    #else
    let open = false
    #endif
    _openChildren = State(initialValue: open ? Set(call.children.filter { $0.diff != nil }.map(\.id)) : [])
    _briefOpen = State(initialValue: open)
  }

  private var report: String? {
    guard call.subagent?.background != true, ChatToolDetail.hasContent(text: call.text, rawOutput: nil) else { return nil }
    return call.text
  }

  private var brief: String? {
    guard let prompt = call.subagent?.prompt, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    return prompt
  }

  private var expandable: Bool { !call.children.isEmpty || brief != nil || report != nil }

  private var subtitle: String {
    var parts: [String] = []
    if let model = call.subagent?.model { parts.append(model) }
    if call.subagent?.background == true { parts.append("background") }
    let count = call.children.count
    if count > 0 { parts.append(count == 1 ? "1 tool call" : "\(count) tool calls") }
    return parts.joined(separator: " \u{00B7} ")
  }

  private var failed: Bool { call.status == .failed }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button(action: toggle) { header }
        .buttonStyle(.plain)
        .disabled(!expandable)
      if expanded && expandable { detail }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .contain)
  }

  private var header: some View {
    HStack(spacing: 10) {
      Image(systemName: "arrow.triangle.branch").font(.footnote)
        .foregroundStyle(failed ? TetherColors.danger : TetherColors.textFaint)
        .frame(width: 24)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 1) {
        Text(call.subagentTitle).font(.footnote)
          .foregroundStyle(failed ? TetherColors.danger : TetherColors.textSecondary)
          .lineLimit(1).truncationMode(.middle)
        if !subtitle.isEmpty {
          Text(subtitle).font(.caption2).foregroundStyle(TetherColors.textFaint).lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      ToolStatusGlyph(status: call.status, active: call.isActive).frame(width: 14)
      if expandable {
        Image(systemName: expanded ? "chevron.down" : "chevron.right")
          .font(.caption2.weight(.semibold)).foregroundStyle(TetherColors.textFaint)
      }
    }
    .padding(.horizontal, 12).padding(.vertical, 6)
    .frame(minHeight: 36)
    .contentShape(Rectangle())
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Subagent \(call.subagentTitle), \(subtitle), \(call.isActive ? "running" : failed ? "failed" : "done")")
    .accessibilityHint(expandable ? (expanded ? "Hides the subagent's activity" : "Shows the subagent's activity") : "")
  }

  private var detail: some View {
    VStack(alignment: .leading, spacing: 8) {
      if !call.children.isEmpty {
        VStack(spacing: 0) {
          ForEach(Array(call.children.enumerated()), id: \.element.id) { index, child in
            if index > 0 { Rectangle().fill(TetherColors.border).frame(height: 0.5) }
            ToolCallRow(call: child, cwd: cwd, expanded: openChildren.contains(child.id)) { toggleChild(child.id) }
          }
        }
        .padding(.leading, 10)
        .overlay(alignment: .leading) { Rectangle().fill(TetherColors.border).frame(width: 2) }
        .padding(.leading, 22)
      }
      if let brief { briefView(brief) }
      if let report { reportView(report) }
    }
    .padding(.bottom, 8)
    .padding(.trailing, 4)
  }

  private func toggleChild(_ id: String) {
    if openChildren.contains(id) { openChildren.remove(id) } else { openChildren.insert(id) }
  }

  private func briefView(_ text: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Button { briefOpen.toggle() } label: {
        HStack(spacing: 6) {
          Text("Brief").font(.caption.weight(.medium))
          Image(systemName: briefOpen ? "chevron.down" : "chevron.right").font(.caption2.weight(.semibold))
        }
        .foregroundStyle(TetherColors.textFaint)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityHint(briefOpen ? "Hides the instructions" : "Shows the instructions given to the subagent")
      if briefOpen {
        MarkdownBodyView(blocks: ChatToolDetail.blocks(text: text, rawOutput: nil))
          .textSelection(.enabled)
          .padding(10)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(TetherColors.background.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
      }
    }
    .padding(.leading, 34).padding(.trailing, 8)
  }

  private func reportView(_ text: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Report").font(.caption.weight(.medium)).foregroundStyle(TetherColors.textFaint)
      MarkdownBodyView(blocks: ChatToolDetail.blocks(text: text, rawOutput: nil))
        .textSelection(.enabled)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TetherColors.background.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
    }
    .padding(.leading, 34).padding(.trailing, 8)
  }
}
