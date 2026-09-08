import SwiftUI

#if canImport(UIKit)
  import UIKit
#endif

/// Native agent-chat surface: a scrolling transcript of user turns and streamed
/// assistant turns (prose + code + tool cards), a thinking indicator, and a
/// composer. Auto-scrolls to the newest content as it streams.
public struct AgentChatView: View {
  @Bindable public var model: AgentChatModel
  @State private var keyboardInset: CGFloat = 0

  public init(model: AgentChatModel) { self.model = model }

  public var body: some View {
    VStack(spacing: 0) {
      // Transcript and composer are separate views on purpose: the composer owns
      // `model.draft`, so a keystroke re-evaluates only the composer. If the
      // transcript read `draft` (directly or by sharing a body), every keystroke
      // would re-parse the whole transcript's markdown and re-measure it — which,
      // with a bottom scroll anchor, yanked the view around while typing.
      AgentTranscriptView(model: model)
      AgentComposerView(model: model)
    }
    // RootView ignores the keyboard safe area at the root (the terminal measures
    // the keyboard itself), so this surface must lift its own composer above the
    // keyboard rather than relying on SwiftUI's automatic avoidance.
    .padding(.bottom, keyboardInset)
    .background(TetherColors.background)
    #if canImport(UIKit)
      .onReceive(
        NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)
      ) { note in
        keyboardInset = Self.keyboardOverlap(note)
      }
      .onReceive(
        NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)
      ) { _ in
        keyboardInset = 0
      }
    #endif
    .sheet(item: $model.pendingApproval) { call in
      AgentApprovalSheet(call: call) { decision in model.resolveApproval(decision) }
        .presentationDetents([.medium, .large])
        .presentationBackground(TetherColors.surface)
    }
  }

  #if canImport(UIKit)
    /// Height of the key window the keyboard's end frame covers, minus the
    /// bottom safe inset the layout already reserves (mirrors the terminal's).
    private static func keyboardOverlap(_ note: Notification) -> CGFloat {
      guard
        let end = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
        let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
        let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first
      else { return 0 }
      return max(0, window.bounds.maxY - end.minY - window.safeAreaInsets.bottom)
    }
  #endif
}

// MARK: - Transcript

/// The scrolling record of the conversation. Reads `messages` / `turn` /
/// `queued` / `revision` but NEVER `draft`, so typing does not re-render it.
struct AgentTranscriptView: View {
  let model: AgentChatModel
  /// The scroll follows the foot only while the user is already near it. It
  /// starts true (a fresh chat opens pinned) and flips off the moment the user
  /// scrolls up to read history, so streamed deltas stop yanking them back.
  @State private var following = true

  private let bottomID = "agent.transcript.bottom"

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView(.vertical) {
        if model.messages.isEmpty {
          emptyState.padding(.top, 80)
        } else {
          LazyVStack(alignment: .leading, spacing: 16) {
            ForEach(model.messages) { message in
              AgentMessageRow(
                message: message,
                onRetry: message.role == .error && model.canRetry
                  ? { model.retryLast() } : nil
              )
              .id(message.id)
            }
            if model.turn == .thinking { ThinkingRow() }
            ForEach(Array(model.queued.enumerated()), id: \.offset) { index, text in
              QueuedRow(text: text) { model.cancelQueued(at: index) }
            }
            // Zero-height sentinel the reader scrolls to. Anchoring on a fixed
            // trailing element (not `.defaultScrollAnchor`) means only an
            // explicit `scrollTo` moves the view — never a keyboard resize.
            Color.clear.frame(height: 1).id(bottomID)
          }
          .padding(.horizontal, 16)
          .padding(.vertical, 18)
        }
      }
      // A drag through the transcript pulls the keyboard down with the finger.
      // (Dropped the blanket tap-to-dismiss gesture: it also swallowed taps
      // meant for tool cards and text selection.)
      .scrollDismissesKeyboard(.interactively)
      .modifier(NearBottomTracker { following = $0 })
      .onChange(of: model.revision) {
        guard following else { return }
        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bottomID, anchor: .bottom) }
      }
      .onAppear {
        proxy.scrollTo(bottomID, anchor: .bottom)
      }
      // Jump-to-latest: only while the user has scrolled up off the foot (and
      // there is something to scroll to). Tapping re-arms follow so streamed
      // output keeps up again.
      .overlay(alignment: .bottomTrailing) {
        if !following && !model.messages.isEmpty {
          jumpToLatest {
            following = true
            withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(bottomID, anchor: .bottom) }
          }
        }
      }
    }
  }

  private func jumpToLatest(_ action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: "arrow.down")
        .font(.system(size: 15, weight: .bold))
        .foregroundStyle(TetherColors.onAccent)
        .frame(width: 36, height: 36)
        .background(TetherColors.accent)
        .clipShape(Circle())
        .shadow(color: .black.opacity(0.25), radius: 6, y: 2)
    }
    .padding(.trailing, 14)
    .padding(.bottom, 14)
    .transition(.scale.combined(with: .opacity))
    .accessibilityLabel("Scroll to latest")
  }

  private var emptyState: some View {
    VStack(spacing: 10) {
      Image(systemName: "sparkle")
        .font(.system(size: 26))
        .foregroundStyle(TetherColors.accent)
      Text("Ask Claude Code")
        .font(.headline)
        .foregroundStyle(TetherColors.textPrimary)
      Text(URL(fileURLWithPath: model.cwd).lastPathComponent)
        .font(.system(.caption, design: .monospaced))
        .foregroundStyle(TetherColors.textFaint)
    }
    .frame(maxWidth: .infinity)
  }
}

/// Reports whether the scroll is parked within a hair of the foot, so the
/// transcript knows when to keep following streamed output. Uses the iOS 18
/// scroll-geometry hook where present; older systems just keep following (only
/// real content changes trigger a scroll there, so nothing runs away).
private struct NearBottomTracker: ViewModifier {
  let onChange: (Bool) -> Void

  func body(content: Content) -> some View {
    if #available(iOS 18.0, *) {
      content.onScrollGeometryChange(for: Bool.self) { geo in
        geo.contentOffset.y >= geo.contentSize.height - geo.containerSize.height
          - geo.contentInsets.bottom - 48
      } action: { _, nearBottom in
        onChange(nearBottom)
      }
    } else {
      content
    }
  }
}

// MARK: - Composer

/// The input row. Owns `model.draft`; isolating it here keeps typing from
/// re-rendering the transcript.
struct AgentComposerView: View {
  @Bindable var model: AgentChatModel
  @FocusState private var focused: Bool

  var body: some View {
    HStack(alignment: .bottom, spacing: 10) {
      TextField("Message Claude Code…", text: $model.draft, axis: .vertical)
        .lineLimit(1...5)
        .font(.body)
        .foregroundStyle(TetherColors.textPrimary)
        .focused($focused)
        .padding(.horizontal, 13)
        .padding(.vertical, 9)
        .background(TetherColors.input)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .stroke(TetherColors.border, lineWidth: 1)
        )
      Button(action: sendOrStop) {
        Group {
          if showSpinner {
            ProgressView().controlSize(.small)
          } else {
            Image(systemName: isStop ? "stop.fill" : "arrow.up")
              .font(.system(size: 15, weight: .bold))
          }
        }
        .foregroundStyle(TetherColors.onAccent)
        .tint(TetherColors.onAccent)
        .frame(width: 38, height: 38)
        .background(sendEnabled ? TetherColors.accent : TetherColors.textFaint)
        .clipShape(Circle())
      }
      .disabled(!sendEnabled || showSpinner)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .background(TetherColors.surface)
    .overlay(alignment: .top) { Divider().overlay(TetherColors.border) }
  }

  private var hasDraft: Bool {
    !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  /// Empty composer while the agent works → the button stops the turn. With text
  /// in it, the button always sends: immediately when idle, queued when busy.
  private var isStop: Bool { model.turn != .idle && !hasDraft }

  /// Stop was tapped and the turn hasn't ended yet — the button shows the
  /// interrupt in flight. Typing overrides it (the button becomes send/queue).
  private var showSpinner: Bool { model.interrupting && !hasDraft }

  private var sendEnabled: Bool { isStop || hasDraft }

  private func sendOrStop() {
    if isStop {
      model.interrupt()
      return
    }
    model.submit(model.draft)
    model.draft = ""
  }
}

// MARK: - One message

struct AgentMessageRow: View {
  let message: AgentMessage
  /// Present on an error row when a retry is possible — resends the last prompt.
  var onRetry: (() -> Void)?

  var body: some View {
    switch message.role {
    case .user: userBubble
    case .assistant: assistantTurn
    case .error: errorBubble
    }
  }

  private var userBubble: some View {
    HStack {
      Spacer(minLength: 40)
      Text(message.plainText)
        .font(.body)
        .foregroundStyle(TetherColors.textPrimary)
        .padding(.horizontal, 13)
        .padding(.vertical, 9)
        .background(TetherColors.accent.opacity(0.16))
        .overlay(
          RoundedRectangle(cornerRadius: 14, style: .continuous)
            .stroke(TetherColors.accent.opacity(0.35), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .contextMenu { CopyButton(message.plainText) }
    }
  }

  private var assistantTurn: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(message.blocks) { block in
        switch block {
        case let .text(_, text):
          ForEach(Array(splitMarkdownBlocks(text).enumerated()), id: \.offset) { _, mdBlock in
            switch mdBlock {
            case let .prose(text): ProseText(text)
            case let .code(language, body): CodeBlock(language: language, code: body)
            }
          }
        case let .tool(call):
          AgentToolCard(call: call)
        }
      }
      if message.isStreaming {
        StreamingCaret()
      } else if let usage = message.usage, !usage.isEmpty {
        usageFooter(usage)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .contextMenu { CopyButton(message.plainText) }
  }

  /// Cost + tokens for a finished turn, muted and small under the reply.
  private func usageFooter(_ usage: AgentUsage) -> some View {
    HStack(spacing: 10) {
      if usage.inputTokens > 0 || usage.outputTokens > 0 {
        Label("\(Self.tokens(usage.inputTokens))↑ \(Self.tokens(usage.outputTokens))↓", systemImage: "number")
          .labelStyle(.titleOnly)
      }
      if usage.cost > 0 {
        Text(Self.money(usage.cost))
      }
    }
    .font(.system(size: 11, design: .monospaced))
    .foregroundStyle(TetherColors.textFaint)
    .padding(.top, 2)
  }

  private static func tokens(_ n: Int) -> String {
    n >= 1000 ? String(format: "%.1fk", Double(n) / 1000) : "\(n)"
  }

  private static func money(_ c: Double) -> String {
    c < 0.01 ? String(format: "$%.4f", c) : String(format: "$%.2f", c)
  }

  private var errorBubble: some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: "exclamationmark.octagon.fill")
        .font(.caption)
        .foregroundStyle(TetherColors.danger)
      Text(message.plainText)
        .font(.callout)
        .foregroundStyle(TetherColors.danger)
      Spacer(minLength: 0)
      if let onRetry {
        Button(action: onRetry) {
          Label("Retry", systemImage: "arrow.clockwise")
            .labelStyle(.titleAndIcon)
            .font(.caption.weight(.semibold))
            .foregroundStyle(TetherColors.accent)
        }
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 9)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(TetherColors.danger.opacity(0.1))
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
  }
}

/// Copies text to the clipboard from a context menu. iOS-only (UIPasteboard);
/// compiles to nothing elsewhere.
struct CopyButton: View {
  let text: String
  init(_ text: String) { self.text = text }
  var body: some View {
    Button {
      #if canImport(UIKit)
        UIPasteboard.general.string = text
      #endif
    } label: {
      Label("Copy", systemImage: "doc.on.doc")
    }
  }
}

// MARK: - Queued (pending) message

/// A prompt typed while the agent was busy: styled like a user bubble but muted
/// and dashed, with a clock, to read as "waiting its turn". Tap to drop it.
struct QueuedRow: View {
  let text: String
  let onCancel: () -> Void

  var body: some View {
    HStack {
      Spacer(minLength: 40)
      HStack(alignment: .top, spacing: 6) {
        Image(systemName: "clock")
          .font(.caption2)
          .foregroundStyle(TetherColors.textFaint)
        Text(text)
          .font(.body)
          .foregroundStyle(TetherColors.textSecondary)
      }
      .padding(.horizontal, 13)
      .padding(.vertical, 9)
      .background(TetherColors.accent.opacity(0.08))
      .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .stroke(TetherColors.accent.opacity(0.25), style: StrokeStyle(lineWidth: 1, dash: [4]))
      )
      .onTapGesture(perform: onCancel)
      .accessibilityHint("Queued. Tap to remove.")
    }
  }
}

// MARK: - Prose + code

struct ProseText: View {
  let text: String
  init(_ text: String) { self.text = text }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      ForEach(Array(parseProse(text).enumerated()), id: \.offset) { _, element in
        row(for: element)
      }
    }
    .textSelection(.enabled)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder
  private func row(for element: ProseElement) -> some View {
    switch element {
    case let .heading(level, text):
      Self.inline(text)
        .font(Self.headingFont(level))
        .foregroundStyle(TetherColors.textPrimary)
        .frame(maxWidth: .infinity, alignment: .leading)
    case let .bullet(text):
      marker("•", Self.inline(text))
    case let .ordered(number, text):
      marker("\(number).", Self.inline(text))
    case let .paragraph(text):
      Self.inline(text)
        .font(.callout)
        .foregroundStyle(TetherColors.textPrimary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func marker(_ glyph: String, _ content: Text) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(glyph)
        .font(.callout)
        .foregroundStyle(TetherColors.textSecondary)
        .frame(minWidth: 16, alignment: .trailing)
      content
        .font(.callout)
        .foregroundStyle(TetherColors.textPrimary)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private static func headingFont(_ level: Int) -> Font {
    switch level {
    case 1: return .title2.weight(.bold)
    case 2: return .title3.weight(.bold)
    case 3: return .headline
    default: return .subheadline.weight(.semibold)
    }
  }

  /// Inline markdown only (bold/italic/code spans/links); block structure is
  /// already resolved by `parseProse`.
  static func inline(_ text: String) -> Text {
    let options = AttributedString.MarkdownParsingOptions(
      interpretedSyntax: .inlineOnlyPreservingWhitespace
    )
    if let a = try? AttributedString(markdown: text, options: options) {
      return Text(a)
    }
    return Text(text)
  }
}

struct CodeBlock: View {
  let language: String?
  let code: String

  private var lang: CodeLanguage? { language.flatMap { CodeLanguage(rawValue: $0.lowercased()) } }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let language, !language.isEmpty {
        Text(language.lowercased())
          .font(.system(size: 10, weight: .semibold, design: .monospaced))
          .foregroundStyle(TetherColors.textFaint)
          .padding(.horizontal, 12)
          .padding(.top, 8)
          .padding(.bottom, 2)
      }
      ScrollView(.horizontal, showsIndicators: false) {
        VStack(alignment: .leading, spacing: 1) {
          ForEach(Array(code.components(separatedBy: "\n").enumerated()), id: \.offset) { _, line in
            HighlightedCodeText(content: line.isEmpty ? " " : line, language: lang)
              .font(.system(.caption, design: .monospaced))
          }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(TetherColors.surface)
    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .stroke(TetherColors.border, lineWidth: 1)
    )
    .overlay(alignment: .topTrailing) { copyButton }
    .contextMenu { CopyButton(code) }
  }

  private var copyButton: some View {
    Button {
      #if canImport(UIKit)
        UIPasteboard.general.string = code
      #endif
    } label: {
      Image(systemName: "doc.on.doc")
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(TetherColors.textFaint)
        .padding(6)
        .background(TetherColors.surface.opacity(0.9))
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
    .padding(6)
    .accessibilityLabel("Copy code")
  }
}

// MARK: - Streaming + thinking

struct StreamingCaret: View {
  @State private var on = true
  var body: some View {
    Rectangle()
      .fill(TetherColors.accent)
      .frame(width: 8, height: 16)
      .opacity(on ? 1 : 0.2)
      .onAppear {
        withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) { on.toggle() }
      }
  }
}

struct ThinkingRow: View {
  var body: some View {
    HStack(spacing: 5) {
      ForEach(0..<3, id: \.self) { i in ThinkingDot(delay: Double(i) * 0.18) }
    }
    .padding(.vertical, 6)
  }
}

struct ThinkingDot: View {
  let delay: Double
  @State private var up = false
  var body: some View {
    Circle()
      .fill(TetherColors.textFaint)
      .frame(width: 7, height: 7)
      .scaleEffect(up ? 1 : 0.5)
      .opacity(up ? 1 : 0.4)
      .onAppear {
        withAnimation(.easeInOut(duration: 0.6).repeatForever().delay(delay)) { up = true }
      }
  }
}

// MARK: - Approval sheet (P3 surface; shown now for review)

struct AgentApprovalSheet: View {
  let call: AgentToolCall
  let onDecision: (String) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(spacing: 9) {
        Image(systemName: AgentToolStyle.glyph(for: call.name))
          .foregroundStyle(AgentToolStyle.accent(for: call.name))
        Text("Allow \(call.name)?")
          .font(.headline)
          .foregroundStyle(TetherColors.textPrimary)
      }
      .padding(.top, 8)

      ScrollView(.vertical) {
        Text(call.inputJSON)
          .font(.system(.caption, design: .monospaced))
          .foregroundStyle(TetherColors.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(12)
      }
      .frame(maxHeight: 200)
      .background(TetherColors.input)
      .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

      VStack(spacing: 10) {
        Button { onDecision("allow") } label: {
          sheetLabel("Allow once", filled: true)
        }
        Button { onDecision("allow_always") } label: {
          sheetLabel("Allow for this chat", filled: false)
        }
        Button { onDecision("deny") } label: {
          Text("Deny")
            .font(.body.weight(.semibold))
            .foregroundStyle(TetherColors.danger)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(20)
  }

  private func sheetLabel(_ title: String, filled: Bool) -> some View {
    Text(title)
      .font(.body.weight(.semibold))
      .foregroundStyle(filled ? TetherColors.onAccent : TetherColors.accent)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 12)
      .background(filled ? TetherColors.accent : TetherColors.accent.opacity(0.12))
      .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
  }
}
