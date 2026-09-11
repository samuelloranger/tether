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
    .sheet(item: $model.pendingPicker) { kind in
      Group {
        switch kind {
        case .model: AgentModelSheet(model: model)
        case .resume: AgentResumeSheet(model: model)
        }
      }
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
  /// False until the open-time scroll to the foot has landed. The geometry
  /// callbacks fire during that first layout with the PRE-scroll offset, which
  /// latched `following` off — so a chat opened on a transcript taller than the
  /// screen sat at the foot showing jump-to-latest and refused to follow new
  /// output until the user tapped it.
  @State private var settled = false
  /// Whether the scroll is currently being driven by a finger. Only a finger may
  /// turn `following` off — see the tracker below.
  @State private var userScrolling = false
  @State private var viewportHeight: CGFloat = 0
  @State private var bottomY: CGFloat = 0

  private let bottomID = "agent.transcript.bottom"
  private static let scrollSpace = "agent.transcript.scroll"

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView(.vertical) {
        if model.messages.isEmpty {
          emptyState.padding(.top, 80)
        } else {
          LazyVStack(alignment: .leading, spacing: 24) {
            // No accessibilityIdentifier on the row: SwiftUI pushes a container's
            // identifier down onto every leaf inside it, which would shadow the
            // per-part ids (agentUserBubble / agentAssistantTurn / agentToolCard)
            // that the UI tests query.
            ForEach(model.messages) { message in
              AgentMessageRow(
                message: message,
                onRetry: message.role == .error && model.canRetry
                  ? { model.retryLast() } : nil
              )
              .id(message.id)
            }
            if model.turn == .thinking {
              ThinkingRow().accessibilityIdentifier("agentThinking")
            }
            ForEach(Array(model.queued.enumerated()), id: \.offset) { index, text in
              QueuedRow(text: text) { model.cancelQueued(at: index) }
                .accessibilityIdentifier("agentQueuedRow")
            }
            // Zero-height sentinel the reader scrolls to. Anchoring on a fixed
            // trailing element (not `.defaultScrollAnchor`) means only an
            // explicit `scrollTo` moves the view — never a keyboard resize.
            Color.clear.frame(height: 1).id(bottomID)
              .background(
                GeometryReader { geo in
                  Color.clear.preference(
                    key: BottomYKey.self,
                    value: geo.frame(in: .named(Self.scrollSpace)).maxY
                  )
                }
              )
          }
          .padding(.horizontal, 16)
          .padding(.vertical, 18)
        }
      }
      .accessibilityIdentifier("agentTranscript")
      .coordinateSpace(name: Self.scrollSpace)
      .background(
        GeometryReader { geo in
          Color.clear.preference(key: ViewportHeightKey.self, value: geo.size.height)
        }
      )
      .onPreferenceChange(ViewportHeightKey.self) { h in
        let shrank = viewportHeight > 0 && h < viewportHeight - 1
        viewportHeight = h
        updateFollowingForLegacyScroll()
        // The keyboard rising shrinks the viewport without scrolling anything, so
        // a chat pinned at the foot hid its newest line behind the keyboard — and
        // offered no jump-to-latest either, because follow was still on. Re-pin.
        // Only while following: a reader parked up in history must not be moved.
        // After the shrink has been laid out, not during it: scrolling against
        // the old content height lands short of the foot.
        if shrank, settled, following {
          Task { @MainActor in
            await Task.yield()
            scrollToBottom(proxy)
          }
        }
      }
      .onPreferenceChange(BottomYKey.self) { y in
        bottomY = y
        updateFollowingForLegacyScroll()
      }
      // A drag through the transcript pulls the keyboard down with the finger;
      // a tap anywhere in it lowers the keyboard too. `simultaneousGesture` (not
      // `onTapGesture`) is the point: the tapped element STILL receives its tap —
      // tool cards expand, retry fires, text stays selectable — so the dismiss
      // rides alongside instead of swallowing them (which is why the old blanket
      // tap gesture was removed).
      .scrollDismissesKeyboard(.interactively)
      .simultaneousGesture(
        TapGesture().onEnded {
          #if canImport(UIKit)
            UIApplication.shared.sendAction(
              #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
          #endif
        }
      )
      // Follow is re-armed whenever the foot comes back into view, but it is only
      // dropped by the USER scrolling away. Geometry alone is not enough: every
      // `scrollTo` while streaming reports an intermediate offset that is not at
      // the foot, which dropped follow mid-turn and left jump-to-latest showing
      // over a transcript that was already at the bottom.
      .agentScrollTracker(
        nearBottom: { near in
          guard settled else { return }
          if near {
            following = true
          } else if userScrolling {
            following = false
          }
        },
        userScrolling: { userScrolling = $0 }
      )
      .onChange(of: model.revision) {
        guard following else { return }
        scrollToBottom(proxy)
      }
      .onAppear {
        // Explicitly disable animation so a tab switch (or any outer animated
        // transaction) can't turn this into a long "scroll down" from the top.
        Task { @MainActor in
          await Task.yield()
          scrollToBottom(proxy)
          // Only now may the trackers speak: see `settled`.
          try? await Task.sleep(nanoseconds: 250_000_000)
          following = true
          settled = true
        }
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

  private func scrollToBottom(_ proxy: ScrollViewProxy) {
    var t = Transaction()
    t.disablesAnimations = true
    withTransaction(t) {
      proxy.scrollTo(bottomID, anchor: .bottom)
    }
  }

  private func updateFollowingForLegacyScroll() {
    if #available(iOS 18.0, *) { return }
    guard settled, viewportHeight > 0 else { return }
    let nearBottom = bottomY <= viewportHeight + 48
    if nearBottom != following {
      following = nearBottom
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
    .accessibilityIdentifier("agentJumpToLatest")
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

private struct ViewportHeightKey: PreferenceKey {
  static var defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = nextValue()
  }
}

private struct BottomYKey: PreferenceKey {
  static var defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = nextValue()
  }
}

private extension View {
  @ViewBuilder
  func agentScrollTracker(
    nearBottom: @escaping (Bool) -> Void,
    userScrolling: @escaping (Bool) -> Void
  ) -> some View {
    if #available(iOS 18.0, *) {
      self
        .onScrollGeometryChange(for: Bool.self) { geo in
          geo.contentOffset.y >= geo.contentSize.height - geo.containerSize.height
            - geo.contentInsets.bottom - 48
        } action: { _, near in
          nearBottom(near)
        }
        // `.animating` is our own scrollTo; the three finger-driven phases are
        // what may drop follow.
        .onScrollPhaseChange { _, phase in
          userScrolling(phase == .tracking || phase == .interacting || phase == .decelerating)
        }
    } else {
      self
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
    VStack(spacing: 8) {
      // Slash-command palette rises over the input while the draft is a bare
      // `/word`. Touch-first: tap a row, no keyboard navigation.
      let matches = matchCommands(model.draft)
      if !matches.isEmpty {
        VStack(spacing: 0) {
          ForEach(matches) { cmd in
            Button { runCommand(cmd) } label: {
              HStack(spacing: 10) {
                Text(cmd.glyph).foregroundStyle(TetherColors.textFaint)
                Text(cmd.trigger)
                  .font(.system(.callout, design: .monospaced))
                  .foregroundStyle(TetherColors.accent)
                if let a = cmd.args {
                  Text(a)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(TetherColors.textFaint)
                }
                Spacer()
                Text(cmd.desc)
                  .font(.caption)
                  .foregroundStyle(TetherColors.textSecondary)
                  .lineLimit(1)
              }
              .padding(.horizontal, 10)
              .padding(.vertical, 7)
            }
            .buttonStyle(.plain)
          }
        }
        .background(TetherColors.surfaceRaised)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .stroke(TetherColors.border, lineWidth: 1)
        )
      }
      // Stats strip sits atop the input, sharing the composer's surface.
      AgentInfoStrip(status: model.status, usage: model.sessionUsage)
      HStack(alignment: .bottom, spacing: 10) {
        TextField("Message Claude Code…", text: $model.draft, axis: .vertical)
          .lineLimit(1...5)
          .font(.body)
          .foregroundStyle(TetherColors.textPrimary)
          .focused($focused)
          .accessibilityIdentifier("agentComposerInput")
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
        .accessibilityIdentifier("agentSendButton")
      }
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
    switch dispatchDraft(model.draft) {
    case let .local(id, _):
      model.draft = ""
      runLocal(id)
    case let .agentText(text):
      model.draft = ""
      model.submit(text)
    case .none:
      model.submit(model.draft)
      model.draft = ""
    }
  }

  private func runCommand(_ cmd: AgentCommand) {
    model.draft = ""
    if cmd.kind == .local {
      runLocal(cmd.id)
    } else {
      model.submit(cmd.trigger)
    }
  }

  private func runLocal(_ id: String) {
    switch id {
    case "clear": model.clearTranscript()
    case "retry": model.retryLast()
    case "copy": copyTranscript()
    case "model": model.openPicker(.model)
    case "resume":
      model.openPicker(.resume)
      model.requestSessions()
    default: break
    }
  }

  private func copyTranscript() {
    let text = model.messages
      .map { "\($0.role == .user ? "You" : "Claude"): \($0.plainText)" }
      .joined(separator: "\n\n")
    #if canImport(UIKit)
      UIPasteboard.general.string = text
    #endif
  }
}

// MARK: - Info strip

/// A single-line stats bar atop the composer: the active model, the 5h/7d
/// account usage gauges, and this chat's running token/cost total. Renders
/// nothing until at least one datum is known — model + usage windows stay nil
/// until an `agent.status` frame arrives (server support pending), so today it
/// typically shows just the session total. Mirrors desktop `AgentInfoStrip`.
struct AgentInfoStrip: View {
  let status: AgentStatus?
  let usage: AgentUsage?

  var body: some View {
    let model = status?.model
    let fiveHour = status?.fiveHour
    let sevenDay = status?.sevenDay
    let total = Self.totalLabel(usage)

    if model == nil && fiveHour == nil && sevenDay == nil && total == nil {
      EmptyView()
    } else {
      HStack(spacing: 10) {
        if let model {
          Text(model)
            .font(.system(size: 11, weight: .medium, design: .monospaced))
            .foregroundStyle(TetherColors.textSecondary)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        Spacer(minLength: 8)
        if let fiveHour { UsageGauge(label: "5h", window: fiveHour) }
        if let sevenDay { UsageGauge(label: "7d", window: sevenDay) }
        if let total {
          Text(total)
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(TetherColors.textFaint)
            .lineLimit(1)
        }
      }
    }
  }

  /// "12.0k↑ 480↓ · $0.02", or nil when the turn reported neither.
  static func totalLabel(_ usage: AgentUsage?) -> String? {
    guard let usage, !usage.isEmpty else { return nil }
    var parts: [String] = []
    if usage.inputTokens > 0 || usage.outputTokens > 0 {
      parts.append("\(tokens(usage.inputTokens))↑ \(tokens(usage.outputTokens))↓")
    }
    if usage.cost > 0 { parts.append(money(usage.cost)) }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  static func tokens(_ n: Int) -> String {
    n >= 1000 ? String(format: "%.1fk", Double(n) / 1000) : "\(n)"
  }

  static func money(_ c: Double) -> String {
    c < 0.01 ? String(format: "$%.4f", c) : String(format: "$%.2f", c)
  }
}

/// One usage window: a label, a filled track coloured by how close to the cap
/// it is (green under 70%, amber under 90%, red at/above), and the percentage.
struct UsageGauge: View {
  let label: String
  let window: UsageWindow

  var body: some View {
    let pct = max(0, min(100, window.utilization))
    HStack(spacing: 4) {
      Text(label)
        .font(.system(size: 10, weight: .semibold, design: .monospaced))
        .foregroundStyle(TetherColors.textFaint)
      GeometryReader { geo in
        ZStack(alignment: .leading) {
          Capsule().fill(TetherColors.surfaceRaised)
          Capsule().fill(fillColor(pct))
            .frame(width: geo.size.width * CGFloat(pct) / 100)
        }
      }
      .frame(width: 34, height: 5)
      Text("\(pct)%")
        .font(.system(size: 10, design: .monospaced))
        .foregroundStyle(TetherColors.textFaint)
        .monospacedDigit()
    }
    .accessibilityLabel("\(label) usage \(pct) percent")
  }

  private func fillColor(_ pct: Int) -> Color {
    if pct >= 90 { return TetherColors.danger }
    if pct >= 70 { return TetherColors.warning }
    return TetherColors.success
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
        .accessibilityIdentifier("agentUserBubble")
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
    .accessibilityIdentifier("agentAssistantTurn")
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
    case let .table(header, rows):
      MarkdownTable(header: header, rows: rows)
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

/// A GFM pipe table. Columns size to their widest cell and the whole table
/// scrolls horizontally (like `CodeBlock`) rather than squishing on a phone.
/// The header is bold with a rule beneath; rows are separated by hairlines.
struct MarkdownTable: View {
  let header: [String]
  let rows: [[String]]

  private var columnCount: Int {
    max(header.count, rows.map(\.count).max() ?? 0)
  }

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
        GridRow {
          ForEach(0..<columnCount, id: \.self) { col in
            cell(col < header.count ? header[col] : "", bold: true)
          }
        }
        Divider().overlay(TetherColors.border).gridCellColumns(columnCount)
        ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
          GridRow {
            ForEach(0..<columnCount, id: \.self) { col in
              cell(col < row.count ? row[col] : "", bold: false)
            }
          }
          if index < rows.count - 1 {
            Divider().overlay(TetherColors.border.opacity(0.5)).gridCellColumns(columnCount)
          }
        }
      }
    }
    .background(TetherColors.surface)
    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .stroke(TetherColors.border, lineWidth: 1)
    )
  }

  private func cell(_ text: String, bold: Bool) -> some View {
    ProseText.inline(text)
      .font(.callout.weight(bold ? .semibold : .regular))
      .foregroundStyle(bold ? TetherColors.textPrimary : TetherColors.textSecondary)
      .multilineTextAlignment(.leading)
      .fixedSize(horizontal: false, vertical: true)
      .padding(.horizontal, 12)
      .padding(.vertical, 7)
      .frame(minWidth: 44, alignment: .leading)
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

/// `/model` picker: the static aliases (current one checked) plus a free-text
/// row for any full model ID. Picking sets the model and closes.
struct AgentModelSheet: View {
  @Bindable var model: AgentChatModel
  @State private var custom = ""

  var body: some View {
    NavigationStack {
      List {
        Section {
          ForEach(agentModelAliases, id: \.name) { alias in
            Button {
              model.setModel(alias.name)
              model.closePicker()
            } label: {
              HStack {
                Image(systemName: model.status?.model == alias.name ? "checkmark" : "")
                  .frame(width: 16)
                  .foregroundStyle(TetherColors.accent)
                VStack(alignment: .leading, spacing: 1) {
                  Text(alias.name).font(.system(.body, design: .monospaced))
                  Text(alias.desc).font(.caption).foregroundStyle(TetherColors.textSecondary)
                }
              }
            }
          }
        }
        Section("Custom") {
          HStack {
            TextField("type a model ID…", text: $custom)
              .font(.system(.body, design: .monospaced))
              .autocorrectionDisabled()
            Button("Set") {
              let name = custom.trimmingCharacters(in: .whitespacesAndNewlines)
              guard !name.isEmpty else { return }
              model.setModel(name)
              model.closePicker()
            }
            .disabled(custom.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }
        }
      }
      .navigationTitle("Model")
      #if canImport(UIKit)
        .navigationBarTitleDisplayMode(.inline)
      #endif
    }
  }
}

/// `/resume` browser: past Claude sessions for this project. Picking one opens a
/// new agent tab resumed at that session (via `model.onResume`).
struct AgentResumeSheet: View {
  @Bindable var model: AgentChatModel

  var body: some View {
    NavigationStack {
      List {
        if model.resumeSessions.isEmpty {
          Text("No past sessions for this folder.")
            .font(.callout)
            .foregroundStyle(TetherColors.textSecondary)
        } else {
          ForEach(model.resumeSessions) { session in
            Button {
              model.closePicker()
              model.onResume?(session)
            } label: {
              VStack(alignment: .leading, spacing: 2) {
                Text(session.label.isEmpty ? session.id : session.label)
                  .font(.body)
                  .lineLimit(1)
                HStack(spacing: 8) {
                  Text(Self.relativeTime(session.mtimeMs))
                  Text("\(session.msgCount) msgs")
                  if session.cwd != model.cwd {
                    Text("⌂ \(session.cwd)").foregroundStyle(TetherColors.warning).lineLimit(1)
                  }
                }
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(TetherColors.textFaint)
              }
            }
          }
        }
      }
      .navigationTitle("Resume")
      #if canImport(UIKit)
        .navigationBarTitleDisplayMode(.inline)
      #endif
    }
  }

  private static func relativeTime(_ ms: Double) -> String {
    let s = max(0, (Date().timeIntervalSince1970 * 1000 - ms) / 1000)
    if s < 90 { return "just now" }
    let m = s / 60
    if m < 90 { return "\(Int(m.rounded()))m ago" }
    let h = m / 60
    if h < 36 { return "\(Int(h.rounded()))h ago" }
    return "\(Int((h / 24).rounded()))d ago"
  }
}
