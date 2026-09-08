import SwiftUI

/// Native agent-chat surface: a scrolling transcript of user turns and streamed
/// assistant turns (prose + code + tool cards), a thinking indicator, and a
/// composer. Auto-scrolls to the newest content as it streams.
public struct AgentChatView: View {
  @Bindable public var model: AgentChatModel
  @State private var draft = ""
  @FocusState private var composerFocused: Bool

  private let bottomID = "agent-chat-bottom"

  public init(model: AgentChatModel) { self.model = model }

  public var body: some View {
    VStack(spacing: 0) {
      transcript
      composer
    }
    .background(TetherColors.background)
    .sheet(item: $model.pendingApproval) { call in
      AgentApprovalSheet(call: call) { decision in model.resolveApproval(decision) }
        .presentationDetents([.medium, .large])
        .presentationBackground(TetherColors.surface)
    }
  }

  private var transcript: some View {
    ScrollViewReader { proxy in
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
            Color.clear.frame(height: 1).id(bottomID)
          }
          .padding(.horizontal, 16)
          .padding(.vertical, 18)
        }
      }
      .onChange(of: model.messages.count) { _, _ in scrollToBottom(proxy) }
      .onChange(of: model.messages.last?.text) { _, _ in scrollToBottom(proxy) }
      .onChange(of: model.turn) { _, _ in scrollToBottom(proxy) }
    }
  }

  // Scroll in the change handler, never inline in the same update — SwiftUI
  // can't scroll to an item added in the pass that adds it.
  private func scrollToBottom(_ proxy: ScrollViewProxy) {
    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bottomID, anchor: .bottom) }
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
      TextField("Message Claude Code…", text: $draft, axis: .vertical)
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
        Image(systemName: model.turn == .idle ? "arrow.up" : "stop.fill")
          .font(.system(size: 15, weight: .bold))
          .foregroundStyle(TetherColors.onAccent)
          .frame(width: 38, height: 38)
          .background(sendEnabled ? TetherColors.accent : TetherColors.textFaint)
          .clipShape(Circle())
      }
      .disabled(!sendEnabled)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .background(TetherColors.surface)
    .overlay(alignment: .top) { Divider().overlay(TetherColors.border) }
  }

  private var sendEnabled: Bool {
    model.turn != .idle || !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private func sendOrStop() {
    if model.turn != .idle {
      model.interrupt()
      return
    }
    model.sendPrompt(draft)
    draft = ""
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
      Text(message.text)
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
      ForEach(Array(splitMarkdownBlocks(message.text).enumerated()), id: \.offset) { _, block in
        switch block {
        case let .prose(text): ProseText(text)
        case let .code(language, body): CodeBlock(language: language, code: body)
        }
      }
      ForEach(message.tools) { call in AgentToolCard(call: call) }
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
      Text(message.text)
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

// MARK: - Prose + code

struct ProseText: View {
  let text: String
  init(_ text: String) { self.text = text }

  var body: some View {
    attributed
      .font(.body)
      .foregroundStyle(TetherColors.textPrimary)
      .textSelection(.enabled)
      .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var attributed: Text {
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
