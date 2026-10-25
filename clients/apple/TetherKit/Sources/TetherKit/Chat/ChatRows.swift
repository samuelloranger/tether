import SwiftUI

extension ACPToolKind {
  var symbolName: String {
    switch self {
    case .read: "doc.text"
    case .edit: "pencil"
    case .delete: "trash"
    case .move: "arrow.right.square"
    case .search: "magnifyingglass"
    case .execute: "terminal"
    case .think: "brain"
    case .fetch: "globe"
    case .switchMode: "arrow.left.arrow.right"
    case .other: "gearshape"
    }
  }
}

/// A run of tool calls reads as one list, so consecutive tool entries share a surface.
enum ChatBlock: Identifiable {
  case item(ChatItem)
  case tools([ChatItem])

  var id: Int {
    switch self {
    case let .item(item): item.id
    case let .tools(items): items[0].id
    }
  }
}

enum ChatGrouping {
  static func blocks(_ items: [ChatItem]) -> [ChatBlock] {
    var blocks: [ChatBlock] = []
    var run: [ChatItem] = []
    func flush() {
      if !run.isEmpty { blocks.append(.tools(run)) }
      run = []
    }
    for item in items {
      switch item.kind {
      case .tool, .permission: run.append(item)
      default:
        flush()
        blocks.append(.item(item))
      }
    }
    flush()
    return blocks
  }
}

/// One transcript entry. Equatable so a streaming chunk redraws its own row, not the list.
struct ChatItemRow: View, Equatable {
  let item: ChatItem
  let cwd: String
  let expanded: Bool
  let toggle: () -> Void

  static func == (lhs: ChatItemRow, rhs: ChatItemRow) -> Bool {
    lhs.item == rhs.item && lhs.cwd == rhs.cwd && lhs.expanded == rhs.expanded
  }

  var body: some View {
    switch item.kind {
    case let .user(text, images, _):
      UserMessageRow(text: text, imageCount: images)
    case let .assistant(text, _):
      AssistantTextView(text: text)
    case let .thought(text):
      ThoughtRow(text: text, expanded: expanded, toggle: toggle)
    case .tool, .permission:
      ToolGroupView(items: [item], cwd: cwd, expandedIDs: expanded ? [item.id] : []) { _ in toggle() }
    case let .plan(entries):
      PlanRow(entries: entries)
    case let .notice(text):
      QuietRow(symbol: "info.circle", text: text, tint: TetherColors.textFaint)
    case let .error(text):
      QuietRow(symbol: "exclamationmark.triangle", text: text, tint: TetherColors.danger)
    }
  }
}

struct UserMessageRow: View {
  let text: String
  var imageCount = 0

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      if imageCount > 0 {
        Label(ChatComposerRule.imageLabel(imageCount), systemImage: "photo")
          .font(.caption).foregroundStyle(TetherColors.textSecondary)
      }
      if !text.isEmpty {
        Text(text)
          .font(.subheadline)
          .foregroundStyle(TetherColors.textPrimary)
          .textSelection(.enabled)
      }
    }
      .padding(.horizontal, 14).padding(.vertical, 10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 14))
      .padding(.leading, 28)
      .accessibilityLabel("You: \(imageCount > 0 ? ChatComposerRule.imageLabel(imageCount) + ". " : "")\(text)")
  }
}

struct AssistantTextView: View {
  let text: String
  @State private var blocks: [MarkdownBlock]

  init(text: String) {
    self.text = text
    _blocks = State(initialValue: MarkdownDocument.parse(text))
  }

  var body: some View {
    MarkdownBodyView(blocks: blocks, reading: true)
      .frame(maxWidth: .infinity, alignment: .leading)
      .textSelection(.enabled)
      .onChange(of: text) { _, next in blocks = MarkdownDocument.parse(next) }
      .accessibilityElement(children: .combine)
  }
}

struct ThoughtRow: View {
  let text: String
  let expanded: Bool
  let toggle: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button(action: toggle) {
        HStack(spacing: 6) {
          Image(systemName: "brain").font(.caption)
          Text("Thinking").font(.footnote)
          Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.caption2.weight(.semibold))
        }
        .foregroundStyle(TetherColors.textFaint)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityHint(expanded ? "Hides the agent's reasoning" : "Shows the agent's reasoning")
      if expanded {
        Text(text).font(.footnote.italic()).foregroundStyle(TetherColors.textFaint)
          .textSelection(.enabled)
          .padding(.leading, 10)
          .overlay(alignment: .leading) { Rectangle().fill(TetherColors.border).frame(width: 2) }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// Tool rows in one rounded surface: a 24pt icon column, one text column, trailing facts.
struct ToolGroupView: View, Equatable {
  let items: [ChatItem]
  let cwd: String
  let expandedIDs: Set<Int>
  let toggle: (Int) -> Void

  static func == (lhs: ToolGroupView, rhs: ToolGroupView) -> Bool {
    lhs.items == rhs.items && lhs.cwd == rhs.cwd && lhs.expandedIDs == rhs.expandedIDs
  }

  var body: some View {
    VStack(spacing: 0) {
      ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
        if index > 0 { Rectangle().fill(TetherColors.border).frame(height: 0.5).padding(.leading, 46) }
        row(item)
      }
    }
    .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(TetherColors.border))
    .clipShape(RoundedRectangle(cornerRadius: 12))
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder private func row(_ item: ChatItem) -> some View {
    switch item.kind {
    case let .tool(call):
      if call.subagent != nil {
        SubagentRow(call: call, cwd: cwd, expanded: expandedIDs.contains(item.id)) { toggle(item.id) }
      } else {
        ToolCallRow(call: call, cwd: cwd, expanded: expandedIDs.contains(item.id)) { toggle(item.id) }
      }
    case let .permission(permission):
      if let resolved = permission.resolvedOptionId {
        ResolvedPermissionRow(permission: permission, optionId: resolved)
      }
    default:
      EmptyView()
    }
  }
}

/// The shared row frame: icon in a 24pt column, text, then whatever trails.
struct ToolRowLayout<Trailing: View>: View {
  let symbol: String
  let tint: Color
  let title: String
  let titleTint: Color
  @ViewBuilder var trailing: Trailing

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: symbol).font(.footnote).foregroundStyle(tint)
        .frame(width: 24)
        .accessibilityHidden(true)
      Text(title).font(.footnote).foregroundStyle(titleTint)
        .lineLimit(1).truncationMode(.middle)
        .frame(maxWidth: .infinity, alignment: .leading)
      trailing
    }
    .padding(.horizontal, 12)
    .frame(minHeight: 36)
  }
}

struct ToolStatusGlyph: View {
  let status: ACPToolStatus
  let active: Bool

  var body: some View {
    if active {
      ProgressView().controlSize(.mini).tint(TetherColors.textFaint)
    } else if status == .failed {
      Image(systemName: "xmark").font(.caption2.weight(.bold)).foregroundStyle(TetherColors.danger)
    } else {
      Image(systemName: "checkmark").font(.caption2.weight(.bold)).foregroundStyle(TetherColors.success)
    }
  }
}

struct ToolCallRow: View {
  let call: ChatToolCall
  let cwd: String
  let expanded: Bool
  let toggle: () -> Void

  private var expandable: Bool { call.diff != nil || ChatToolDetail.hasContent(text: call.text, rawOutput: call.rawOutput) }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button(action: toggle) { header }
        .buttonStyle(.plain)
        .disabled(!expandable)
      if expanded && expandable { detailView }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .contain)
  }

  private var header: some View {
    ToolRowLayout(
      symbol: call.kind.symbolName,
      tint: call.status == .failed ? TetherColors.danger : TetherColors.textFaint,
      title: call.title,
      titleTint: call.status == .failed ? TetherColors.danger : TetherColors.textSecondary
    ) {
      HStack(spacing: 8) {
        if let diff = call.diff {
          let file = ACPDiffAdapter.file(for: diff, relativeTo: cwd)
          HStack(spacing: 5) {
            if file.added > 0 { Text("+\(file.added)").foregroundStyle(TetherColors.success) }
            if file.removed > 0 { Text("\u{2212}\(file.removed)").foregroundStyle(TetherColors.danger) }
          }
          .font(.caption2.monospacedDigit())
        }
        statusGlyph.frame(width: 14)
        if expandable {
          Image(systemName: expanded ? "chevron.down" : "chevron.right")
            .font(.caption2.weight(.semibold)).foregroundStyle(TetherColors.textFaint)
        }
      }
    }
    .contentShape(Rectangle())
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(call.title), \(statusWord)")
    .accessibilityHint(expandable ? (expanded ? "Hides the details" : "Shows the details") : "")
  }

  private var statusGlyph: some View { ToolStatusGlyph(status: call.status, active: call.isRunning) }

  private var statusWord: String {
    switch call.status {
    case .pending: "waiting"
    case .inProgress: "running"
    case .completed: "done"
    case .failed: "failed"
    }
  }

  @ViewBuilder
  private var detailView: some View {
    Group {
      if let diff = call.diff {
        DiffReviewView(files: [ACPDiffAdapter.file(for: diff, relativeTo: cwd)])
      } else {
        MarkdownBodyView(blocks: ChatToolDetail.blocks(text: call.text, rawOutput: call.rawOutput))
          .textSelection(.enabled)
          .padding(10)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .background(TetherColors.background.opacity(0.5))
    .clipShape(RoundedRectangle(cornerRadius: 8))
    .padding(.horizontal, 8).padding(.bottom, 8)
  }
}

struct PlanRow: View {
  let entries: [ACPPlanEntry]

  #if DEBUG
  @State private var open = ProcessInfo.processInfo.environment["TETHER_DEBUG_PLAN_OPEN"] != nil
  #else
  @State private var open = false
  #endif
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var done: Int { entries.filter { $0.status == "completed" }.count }
  private var current: ACPPlanEntry? { entries.first { $0.status == "in_progress" } }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Button {
        withAnimation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion)) { open.toggle() }
      } label: {
        HStack(spacing: 6) {
          Image(systemName: "checklist").font(.caption)
          Text("Plan · \(done) of \(entries.count)").font(.footnote.weight(.medium))
          if !open, let current {
            Text(current.content).font(.footnote).lineLimit(1)
              .foregroundStyle(TetherColors.textFaint)
          }
          Spacer(minLength: 6)
          Image(systemName: open ? "chevron.down" : "chevron.right").font(.caption2.weight(.semibold))
        }
        .foregroundStyle(TetherColors.textSecondary)
        .padding(.vertical, 5)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Plan, \(done) of \(entries.count) done")
      .accessibilityHint(open ? "Hides the steps" : "Shows the steps")
      if open {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
            HStack(alignment: .firstTextBaseline, spacing: 9) {
              glyph(entry.status).frame(width: 16)
              Text(entry.content)
                .font(entry.status == "in_progress" ? .footnote.weight(.semibold) : .footnote)
                .foregroundStyle(
                  entry.status == "completed" ? TetherColors.textSecondary : TetherColors.textPrimary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(entry.content), \(entry.status.replacingOccurrences(of: "_", with: " "))")
          }
        }
        .padding(.leading, 2)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder private func glyph(_ status: String) -> some View {
    switch status {
    case "completed":
      Image(systemName: "checkmark.circle.fill").foregroundStyle(TetherColors.success)
    case "in_progress":
      Image(systemName: "circle.lefthalf.filled").foregroundStyle(TetherColors.accent)
    default:
      Image(systemName: "circle").foregroundStyle(TetherColors.textFaint)
    }
  }
}

struct QuietRow: View {
  let symbol: String
  let text: String
  let tint: Color

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: symbol).font(.caption).foregroundStyle(tint)
      Text(text).font(.footnote).foregroundStyle(tint == TetherColors.danger ? tint : TetherColors.textSecondary)
        .textSelection(.enabled)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
  }
}

struct ResolvedPermissionRow: View {
  let permission: ChatPermission
  let optionId: String

  private var option: ACPPermissionOption? { permission.options.first { $0.optionId == optionId } }
  private var allowed: Bool { option.map { ChatPermissionRole(kind: $0.kind) != .destructive } ?? false }

  var body: some View {
    ToolRowLayout(
      symbol: allowed ? "checkmark.shield" : "xmark.shield",
      tint: allowed ? TetherColors.textFaint : TetherColors.warning,
      title: "\(option?.name ?? "Cancelled") \u{00B7} \(permission.title)",
      titleTint: TetherColors.textFaint
    ) { EmptyView() }
    .accessibilityElement(children: .combine)
  }
}

struct FailedMessageRow: View {
  let message: ChatOutbox.Failed
  let canRetry: Bool
  let retry: () -> Void
  let discard: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(message.text).font(.callout).foregroundStyle(TetherColors.textSecondary)
        .frame(maxWidth: .infinity, alignment: .leading)
      HStack(spacing: 14) {
        Label("Not sent", systemImage: "exclamationmark.circle.fill")
          .font(.caption.weight(.semibold)).foregroundStyle(TetherColors.danger)
        Spacer()
        Button("Discard", role: .destructive, action: discard).font(.caption.weight(.semibold))
        Button("Retry", action: retry).font(.caption.weight(.semibold)).disabled(!canRetry)
      }
    }
    .padding(.horizontal, 14).padding(.vertical, 10)
    .background(TetherColors.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(TetherColors.danger.opacity(0.35)))
    .padding(.leading, 28)
    .accessibilityElement(children: .contain)
  }
}

/// "Working…" with a light sweep; plain under Reduce Motion.
struct WorkingIndicator: View {
  var activity: String?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    Group {
      if reduceMotion {
        label(sweep: 0.5)
      } else {
        TimelineView(.animation(minimumInterval: 1.0 / 20)) { context in
          let seconds = context.date.timeIntervalSinceReferenceDate
          label(sweep: seconds.truncatingRemainder(dividingBy: 1.8) / 1.8 * 1.6 - 0.3)
        }
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(activity.map { "The agent is working: \($0)" } ?? "The agent is working")
  }

  private func label(sweep: Double) -> some View {
    let mid = min(1, max(0, sweep))
    let lead = max(0, min(mid, sweep - 0.25))
    let trail = max(mid, min(1, sweep + 0.25))
    return Text(activity ?? "Working…")
      .font(.footnote.weight(.medium))
      .lineLimit(1).truncationMode(.middle)
      .foregroundStyle(
        LinearGradient(
          stops: [
            .init(color: TetherColors.textFaint, location: lead),
            .init(color: TetherColors.textPrimary, location: mid),
            .init(color: TetherColors.textFaint, location: trail),
          ],
          startPoint: .leading, endPoint: .trailing))
      .frame(maxWidth: .infinity, alignment: .leading)
  }
}
