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
    case let .user(text, _):
      UserMessageRow(text: text)
    case let .assistant(text, _):
      AssistantTextView(text: text)
    case let .thought(text):
      ThoughtRow(text: text, expanded: expanded, toggle: toggle)
    case let .tool(call):
      ToolCallRow(call: call, cwd: cwd, expanded: expanded, toggle: toggle)
    case let .permission(permission):
      if let resolved = permission.resolvedOptionId {
        ResolvedPermissionRow(permission: permission, optionId: resolved)
      }
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

  var body: some View {
    Text(text)
      .font(.callout)
      .foregroundStyle(TetherColors.textPrimary)
      .textSelection(.enabled)
      .padding(.horizontal, 14).padding(.vertical, 10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 14))
      .padding(.leading, 28)
      .accessibilityLabel("You: \(text)")
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

struct ToolCallRow: View {
  let call: ChatToolCall
  let cwd: String
  let expanded: Bool
  let toggle: () -> Void

  private var detail: String? {
    let text = call.text ?? call.rawOutput
    return text?.isEmpty == false ? text : nil
  }

  private var expandable: Bool { call.diff != nil || detail != nil }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Button(action: toggle) { header }
        .buttonStyle(.plain)
        .disabled(!expandable)
      if expanded && expandable { detailView }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .contain)
  }

  private var header: some View {
    HStack(spacing: 9) {
      Image(systemName: call.kind.symbolName)
        .font(.caption)
        .foregroundStyle(call.status == .failed ? TetherColors.danger : TetherColors.textFaint)
        .frame(width: 18)
        .accessibilityHidden(true)
      Text(call.title)
        .font(.footnote)
        .foregroundStyle(call.status == .failed ? TetherColors.danger : TetherColors.textSecondary)
        .lineLimit(1).truncationMode(.middle)
      if let diff = call.diff {
        let file = ACPDiffAdapter.file(for: diff, relativeTo: cwd)
        HStack(spacing: 4) {
          if file.added > 0 { Text("+\(file.added)").foregroundStyle(TetherColors.success) }
          if file.removed > 0 { Text("−\(file.removed)").foregroundStyle(TetherColors.danger) }
        }
        .font(.caption2.monospaced())
      }
      Spacer(minLength: 6)
      statusGlyph
      if expandable {
        Image(systemName: expanded ? "chevron.down" : "chevron.right")
          .font(.caption2.weight(.semibold)).foregroundStyle(TetherColors.textFaint)
      }
    }
    .padding(.vertical, 5)
    .contentShape(Rectangle())
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(call.title), \(statusWord)")
    .accessibilityHint(expandable ? (expanded ? "Hides the details" : "Shows the details") : "")
  }

  @ViewBuilder private var statusGlyph: some View {
    switch call.status {
    case .pending, .inProgress:
      ProgressView().controlSize(.mini).tint(TetherColors.textFaint)
    case .completed:
      Image(systemName: "checkmark").font(.caption2.weight(.bold)).foregroundStyle(TetherColors.success)
    case .failed:
      Image(systemName: "xmark").font(.caption2.weight(.bold)).foregroundStyle(TetherColors.danger)
    }
  }

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
      } else if let detail {
        Text(String(detail.prefix(4000)) + (detail.count > 4000 ? "\n…" : ""))
          .font(.caption.monospaced())
          .foregroundStyle(TetherColors.textSecondary)
          .textSelection(.enabled)
          .padding(10)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TetherColors.border))
    .clipShape(RoundedRectangle(cornerRadius: 10))
    .padding(.leading, 27)
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
    QuietRow(
      symbol: allowed ? "checkmark.shield" : "xmark.shield",
      text: "\(option?.name ?? "Cancelled") · \(permission.title)",
      tint: allowed ? TetherColors.textFaint : TetherColors.warning)
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
    .accessibilityLabel("The agent is working")
  }

  private func label(sweep: Double) -> some View {
    let mid = min(1, max(0, sweep))
    let lead = max(0, min(mid, sweep - 0.25))
    let trail = max(mid, min(1, sweep + 0.25))
    return Text("Working…")
      .font(.footnote.weight(.medium))
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
