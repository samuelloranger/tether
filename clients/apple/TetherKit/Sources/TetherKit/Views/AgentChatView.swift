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
  @FocusState private var composerFocused: Bool

  public init(model: AgentChatModel) { self.model = model }

  public var body: some View {
    VStack(spacing: 0) {
      transcript
      composer
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

  private var transcript: some View {
    // `.defaultScrollAnchor(.bottom)` owns BOTH jobs: it opens an existing chat
    // at its foot AND keeps the foot pinned as content grows (new turns, streamed
    // deltas). An earlier version drove that by hand with `withAnimation
    // scrollTo` on four onChange handlers; on send they raced each other and the
    // anchor and overshot past the content into the window backdrop before an
    // update pulled it back. One anchor, no manual scrolling, no fight.
    ScrollView(.vertical) {
      if model.messages.isEmpty {
        emptyState.padding(.top, 80)
      } else {
        LazyVStack(alignment: .leading, spacing: 16) {
          ForEach(model.messages) { message in
            AgentMessageRow(message: message)
              .id(message.id)
          }
          if model.turn == .thinking { ThinkingRow() }
          ForEach(Array(model.queued.enumerated()), id: \.offset) { index, text in
            QueuedRow(text: text) { model.cancelQueued(at: index) }
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 18)
      }
    }
    .defaultScrollAnchor(.bottom)
    // A drag through the transcript pulls the keyboard down with the finger; a
    // plain tap dismisses it outright. Without either, the composer keyboard
    // stayed up over the transcript with no way down but the send button.
    .scrollDismissesKeyboard(.interactively)
    .simultaneousGesture(TapGesture().onEnded { composerFocused = false })
  }

  private var emptyState: some View {
    VStack(spacing: 10) {
      Image(systemName: "sparkle")
        .font(.system(size: 26))
        .foregroundStyle(TetherColors.accent)
      Text("Ask Claude Code")
        .font(.headline)
        .foregroundStyle(TetherColors.textPrimary)
      Text(shortCwd)
        .font(.system(.caption, design: .monospaced))
        .foregroundStyle(TetherColors.textFaint)
    }
    .frame(maxWidth: .infinity)
  }

  private var shortCwd: String {
    URL(fileURLWithPath: model.cwd).lastPathComponent
  }

  private var composer: some View {
    HStack(alignment: .bottom, spacing: 10) {
      TextField("Message Claude Code…", text: $model.draft, axis: .vertical)
        .lineLimit(1...5)
        .font(.body)
        .foregroundStyle(TetherColors.textPrimary)
        .focused($composerFocused)
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
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var errorBubble: some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: "exclamationmark.octagon.fill")
        .font(.caption)
        .foregroundStyle(TetherColors.danger)
      Text(message.plainText)
        .font(.callout)
        .foregroundStyle(TetherColors.danger)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 9)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(TetherColors.danger.opacity(0.1))
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
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
