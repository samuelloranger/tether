import PhotosUI
import SwiftUI
import UIKit

/// A document-style transcript: the agent's prose at full width, everything else quiet.
struct ChatView: View {
  @Bindable var model: ChatSessionModel

  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.dismiss) private var dismiss
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var focusComposer = false
  var startAtTop = false
  var initialDraft = ""
  var openControls = false
  /// Set when the chat sits inside the terminal screen: the header button then opens its drawer.
  var onSessions: (() -> Void)?
  /// Another session or chat is waiting on an answer; the drawer button carries a dot.
  var sessionsNeedYou = false
  var seedAttachments = false
  #if DEBUG
  var sendDraft: String?
  var probeLastRow = false
  @State private var lastRowVisible = false
  @State private var probeText = ""
  #endif
  @FocusState private var composerFocused: Bool
  @State private var draft = ""
  @State private var expanded: Set<Int> = []
  @State private var userScrolledUp = false
  @State private var bottomEdge: CGFloat = 0
  @State private var viewportHeight: CGFloat = 0
  @State private var atBottom = true
  @State private var sendTick = 0
  @State private var scrolledUnder = false
  @State private var reviewing: ChatPermission?
  @State private var questionTyping = false
  @State private var showingControls = false
  @State private var attachments = ChatAttachments()
  @State private var pickingPhotos = false
  @State private var pickedPhotos: [PhotosPickerItem] = []
  @State private var copiedFolder = false
  @State private var cursor: Int?
  @State private var caretRequest: Int?

  private let bottomID = "chat-bottom"
  private static let space = "chat-scroll"

  var body: some View {
    scroller
    #if DEBUG
    .coordinateSpace(name: "probe-viewport")
    #endif
    .background(TetherColors.background.ignoresSafeArea())
    .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
    .navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(TetherColors.background, for: .navigationBar)
    .toolbarBackground(.visible, for: .navigationBar)
    .navigationBarBackButtonHidden(true)
    .overlay(alignment: .top) { headerRule }
    #if DEBUG
    .overlay(alignment: .topTrailing) {
      if probeLastRow {
        Text("LAST ROW VISIBLE: \(lastRowVisible ? "yes" : "no")")
          .font(.system(size: 13, weight: .bold, design: .monospaced))
          .foregroundStyle(.white).padding(6)
          .background(lastRowVisible ? Color.green : Color.red)
          .padding(.top, 4)
          .overlay(alignment: .bottom) { Text(probeText).font(.system(size: 8)).offset(y: 14) }
      }
    }
    #endif
    .toolbar {
      ToolbarItem(placement: .topBarLeading) { backButton }.withoutGlass()
      ToolbarItem(placement: .principal) { titleBlock }.withoutGlass()
      ToolbarItem(placement: .topBarTrailing) { connectionBadge }.withoutGlass()
    }
    .task { await model.connect() }
    .task {
      if !initialDraft.isEmpty, draft.isEmpty { draft = initialDraft }
      #if DEBUG
      if seedAttachments { attachments.seedPlaceholders() }
      #endif
      if openControls {
        try? await Task.sleep(nanoseconds: 900_000_000)
        showingControls = true
      }
      #if DEBUG
      if ChatFixture.planMode == "plan-sheet" {
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        reviewing = model.state.pendingPermissions.first
      }
      #endif
    }
    .task {
      guard focusComposer else { return }
      try? await Task.sleep(nanoseconds: 700_000_000)
      composerFocused = true
      #if DEBUG
      guard let sendDraft else { return }
      try? await Task.sleep(nanoseconds: 4_000_000_000)
      draft = sendDraft
      try? await Task.sleep(nanoseconds: 1_000_000_000)
      sendMessage()
      #endif
    }
    .onChange(of: scenePhase) { _, phase in
      switch phase {
      case .active: model.sceneBecameActive()
      case .background: model.sceneEnteredBackground()
      default: break
      }
    }
    .onDisappear { model.leave() }
    .sensoryFeedback(.impact(weight: .light), trigger: model.state.pendingPermissions.first?.requestId)
    .sensoryFeedback(.impact(weight: .light), trigger: model.state.pendingQuestions.first?.requestId)
    .sheet(isPresented: $showingControls) { ChatControlsSheet(model: model) }
    .photosPicker(
      isPresented: $pickingPhotos, selection: $pickedPhotos, maxSelectionCount: max(1, attachments.room),
      matching: .images
    )
    .onChange(of: pickedPhotos) { _, picked in
      guard !picked.isEmpty else { return }
      for item in picked.prefix(attachments.room) {
        attachments.add { try? await item.loadTransferable(type: Data.self) }
      }
      pickedPhotos = []
    }
    .sheet(item: Binding(get: { reviewing }, set: { reviewing = $0 })) { permission in
      PermissionReviewSheet(permission: permission, cwd: model.cwd)
    }
  }

  @ViewBuilder private var scroller: some View {
    if #available(iOS 18.0, *) {
      FollowingTranscript(atBottom: $atBottom, scrolledUnder: $scrolledUnder, sendTick: sendTick, reduceMotion: reduceMotion, startAtTop: startAtTop) { transcript }
    } else {
      legacyScroller
    }
  }

  private var transcript: some View {
    LazyVStack(alignment: .leading, spacing: 12) {
      if model.state.items.isEmpty { emptyState }
      ForEach(ChatGrouping.blocks(visibleItems)) { block in
        switch block {
        case let .item(item):
          ChatItemRow(
            item: item, cwd: model.cwd, expanded: isExpanded(item), toggle: { toggleExpanded(item.id) },
            queued: model.state.isQueued(item.id), host: model.hostLabel,
            signInRetry: model.needsSignIn && item.id == model.state.items.last?.id ? model.signInRetry : nil,
            retrySignIn: { model.retrySignIn() }
          )
          .equatable()
        case let .tools(items):
          ToolGroupView(
            items: items, cwd: model.cwd, expandedIDs: Set(items.filter(isExpanded).map(\.id)),
            toggle: toggleExpanded
          )
          .equatable()
        }
      }
      ForEach(model.outbox.failed) { message in
        FailedMessageRow(
          message: message, canRetry: model.canSend,
          retry: { model.retry(message.id) }, discard: { model.discard(message.id) })
      }
      if model.state.turn == .working && !answerPending { WorkingIndicator(activity: model.state.subagentActivity) }
      #if DEBUG
      if probeLastRow {
        Color.clear.frame(height: 1)
          .onGeometryChange(for: String.self) { proxy in
            let frame = proxy.frame(in: .named("probe-viewport"))
            guard let viewport = proxy.bounds(of: .named("probe-viewport")) else { return "nil \(frame)" }
            return "\(frame.maxY > viewport.minY && frame.minY < viewport.maxY) \(frame) \(viewport)"
          } action: { probeText = $0; lastRowVisible = $0.hasPrefix("true") }
          .onDisappear { lastRowVisible = false }
      }
      #endif
    }
    .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 16)
  }

  /// iOS 17: the transcript follows by scrolling to a sentinel when the tail changes.
  private var legacyScroller: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(spacing: 0) {
          transcript
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(Self.space)).minY } action: {
              scrolledUnder = $0 < -1
            }
          Color.clear.frame(height: 1).id(bottomID)
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(Self.space)).maxY } action: { bottomEdge = $0 }
            .onDisappear { bottomEdge = .infinity }
        }
      }
      .coordinateSpace(name: Self.space)
      .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewportHeight = $0 }
      .defaultScrollAnchor(.bottom)
      .scrollDismissesKeyboard(.interactively)
      .simultaneousGesture(
        DragGesture(minimumDistance: 14).onChanged { drag in
          if drag.translation.height > 24, !nearBottom { userScrolledUp = true }
        })
      .onChange(of: bottomEdge) { _, _ in if nearBottom { userScrolledUp = false } }
      .onChange(of: model.state.tailSignature) { _, _ in
        if !userScrolledUp { proxy.scrollTo(bottomID, anchor: .bottom) }
      }
      .overlay(alignment: .bottom) {
        if userScrolledUp {
          JumpToLatestButton {
            userScrolledUp = false
            withAnimation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion)) {
              proxy.scrollTo(bottomID, anchor: .bottom)
            }
          }
        }
      }
      .animation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion), value: userScrolledUp)
    }
  }

  /// An unanswered permission or question lives in the card, not in the scroll.
  private var visibleItems: [ChatItem] {
    model.state.items.filter {
      if case let .permission(permission) = $0.kind { return permission.resolvedOptionId != nil }
      if case let .question(question) = $0.kind { return !question.isPending }
      return true
    }
  }

  private func isExpanded(_ item: ChatItem) -> Bool {
    #if DEBUG
    if ProcessInfo.processInfo.environment["TETHER_DEBUG_TOOLS_OPEN"] != nil { return true }
    if ChatFixture.openSubagents, case let .tool(call) = item.kind, call.subagent != nil { return true }
    #endif
    return expanded.contains(item.id)
  }

  private func toggleExpanded(_ id: Int) {
    withAnimation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion)) {
      if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
    }
  }

  private var nearBottom: Bool { bottomEdge <= viewportHeight + 48 }

  private var emptyState: some View {
    VStack(spacing: 8) {
      Image(systemName: "text.bubble").font(.title).foregroundStyle(TetherColors.textFaint)
      Text(model.readOnly ? "Nothing here yet" : "Ask the agent anything")
        .font(.subheadline).foregroundStyle(TetherColors.textSecondary)
      Text(model.cwd).font(.caption.monospaced()).foregroundStyle(TetherColors.textFaint)
        .lineLimit(1).truncationMode(.head)
    }
    .frame(maxWidth: .infinity)
    .padding(.top, 80)
    .accessibilityElement(children: .combine)
  }

  // MARK: Header

  private var backButton: some View {
    Button { if let onSessions { onSessions() } else { dismiss() } } label: {
      Image(systemName: onSessions == nil ? "chevron.backward" : "line.3.horizontal")
        .font(.system(size: onSessions == nil ? 18 : 17, weight: .semibold))
        .foregroundStyle(TetherColors.accent)
        .overlay(alignment: .topTrailing) {
          if onSessions != nil, sessionsNeedYou {
            Circle().fill(TetherColors.warning).frame(width: 8, height: 8).offset(x: 4, y: -3)
              .accessibilityHidden(true)
          }
        }
        .frame(width: 44, height: 44, alignment: .leading)
        .contentShape(Rectangle())
    }
    .accessibilityLabel(onSessions == nil ? "Chats" : sessionsNeedYou ? "Open session list, a session needs you" : "Open session list")
    .accessibilityIdentifier(onSessions == nil ? "chatBack" : "chatSessions")
  }

  private var titleBlock: some View {
    let line = ChatStatusLine(state: model.state)
    return VStack(spacing: 2) {
      Text(copiedFolder ? "Folder copied" : model.title)
        .font(.subheadline.weight(.semibold)).foregroundStyle(TetherColors.textPrimary).lineLimit(1)
        .onLongPressGesture(minimumDuration: 0.4) { copyFolder() }
        .accessibilityAddTraits(.isHeader)
        .accessibilityHint("Long press copies the folder")
      if line.isAvailable {
        Button { showingControls = true } label: { statusLine(line) }
          .buttonStyle(.plain)
          .accessibilityLabel(line.spoken)
          .accessibilityHint("Opens the session controls")
          .accessibilityIdentifier("chatControls")
      } else {
        Text(ChatFormat.folderName(model.cwd)).font(.caption).foregroundStyle(TetherColors.textSecondary)
          .lineLimit(1)
          .accessibilityLabel(model.cwd)
      }
    }
  }

  private func statusLine(_ line: ChatStatusLine) -> some View {
    HStack(spacing: 8) {
      HStack(spacing: 0) {
        if let name = line.model { Text(name).foregroundStyle(TetherColors.textSecondary) }
        if line.model != nil, line.mode != nil { Text(" · ").foregroundStyle(TetherColors.textFaint) }
        if let mode = line.mode { Text(mode).foregroundStyle(tint(line.tint)).fixedSize() }
      }
      .lineLimit(1)
      if let stats = line.stats {
        Text(stats).foregroundStyle(TetherColors.textFaint).monospacedDigit().lineLimit(1).fixedSize()
      }
      Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)).foregroundStyle(TetherColors.textFaint)
    }
    .font(.system(size: 12))
    .frame(minHeight: 16)
    .hitSlop(vertical: 8, horizontal: 8)
  }

  private func tint(_ tint: ChatModeTint) -> Color {
    switch tint {
    case .accent: TetherColors.accent
    case .success: TetherColors.success
    case .secondary: TetherColors.textSecondary
    case .danger: TetherColors.danger
    }
  }

  private func copyFolder() {
    UIPasteboard.general.string = model.cwd
    UINotificationFeedbackGenerator().notificationOccurred(.success)
    copiedFolder = true
    Task {
      try? await Task.sleep(nanoseconds: 1_300_000_000)
      copiedFolder = false
    }
  }

  /// Context usage as a 3pt line under the header; otherwise a hairline once content scrolls under it.
  @ViewBuilder private var headerRule: some View {
    if scrolledUnder, ChatFormat.contextFraction(used: model.state.contextUsed, size: model.state.contextSize) == nil {
      Rectangle().fill(TetherColors.border).frame(height: 0.5)
    } else { contextHairline }
  }

  @ViewBuilder private var contextHairline: some View {
    if let fraction = ChatFormat.contextFraction(used: model.state.contextUsed, size: model.state.contextSize) {
      Rectangle().fill(TetherColors.border).frame(height: 3)
        .overlay(alignment: .leading) {
          GeometryReader { proxy in
            Rectangle().fill(TetherColors.accent).frame(width: proxy.size.width * fraction)
          }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Context used")
        .accessibilityValue(
          ChatFormat.contextSummary(used: model.state.contextUsed, size: model.state.contextSize) ?? "")
    }
  }

  @ViewBuilder private var connectionBadge: some View {
    switch model.link.phase {
    case .lost:
      Button { model.reconnect() } label: {
        Label("Reconnect", systemImage: "arrow.clockwise").font(.caption.weight(.semibold))
          .frame(height: 24).hitSlop(vertical: 10)
      }
      .accessibilityHint("The connection to the host was lost")
    case .connecting, .catchingUp:
      badge(color: TetherColors.warning, text: model.link.phase == .connecting ? "Connecting" : "Catching up")
    case .live:
      badge(color: TetherColors.success, text: "Live")
    case .ended:
      badge(color: TetherColors.textFaint, text: "Ended")
    }
  }

  private func badge(color: Color, text: String) -> some View {
    HStack(spacing: 5) {
      Circle().fill(color).frame(width: 6, height: 6)
      Text(text).font(.caption).foregroundStyle(TetherColors.textSecondary)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Connection: \(text)")
  }

  // MARK: Bottom bar

  private var bottomBar: some View {
    VStack(spacing: 10) {
      if let notice = model.notice {
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: "exclamationmark.triangle").foregroundStyle(TetherColors.warning)
          Text(notice).font(.footnote).foregroundStyle(TetherColors.textSecondary)
          Spacer(minLength: 0)
          Button { model.notice = nil } label: { Image(systemName: "xmark") }
            .font(.caption.weight(.semibold)).foregroundStyle(TetherColors.textFaint)
            .accessibilityLabel("Dismiss")
        }
        .padding(10)
        .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 12))
      }
      if let question = pendingQuestion, model.state.pendingPermissions.isEmpty, !model.readOnly, !model.hasEnded {
        QuestionCard(
          question: question,
          position: model.state.pendingQuestions.count > 1 ? "1 of \(model.state.pendingQuestions.count)" : nil,
          enabled: model.canInteract,
          respond: { model.answerQuestion(question, action: $0, content: $1) },
          typing: { questionTyping = $0 })
          .id(question.requestId)
          .transition(.move(edge: .bottom).combined(with: .opacity))
        if model.answerFailures.contains(question.requestId) {
          Text("Couldn't send your answer. Try again.")
            .font(.caption).foregroundStyle(TetherColors.textFaint)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4)
            .accessibilityIdentifier("chatAnswerRetry")
        }
      } else if let permission = model.state.pendingPermissions.first, !model.readOnly, !model.hasEnded {
        PermissionCard(
          permission: permission, cwd: model.cwd,
          position: model.state.pendingPermissions.count > 1 ? "1 of \(model.state.pendingPermissions.count)" : nil,
          enabled: model.canInteract,
          approve: { model.approve(permission, option: $0) },
          review: { reviewing = permission }, startOpen: debugOpenMore)
          .transition(.move(edge: .bottom).combined(with: .opacity))
        if model.answerFailures.contains(permission.requestId) {
          Text("Couldn't send your answer. Choose again to retry.")
            .font(.caption).foregroundStyle(TetherColors.textFaint)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 4)
            .accessibilityIdentifier("chatAnswerRetry")
        }
      }
      if model.readOnly {
        Label("Started on another device. Read only.", systemImage: "eye")
          .font(.footnote).foregroundStyle(TetherColors.textSecondary)
          .frame(maxWidth: .infinity).padding(.vertical, 6)
      } else if model.hasEnded {
        Label("This chat has ended. You can still read it.", systemImage: "moon.zzz")
          .font(.footnote).foregroundStyle(TetherColors.textSecondary)
          .frame(maxWidth: .infinity).padding(.vertical, 6)
          .accessibilityIdentifier("chatEnded")
      } else if !(questionTyping && pendingQuestion != nil) {
        composer
      }
    }
    .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 6)
    .background(TetherColors.background.ignoresSafeArea(.all, edges: .bottom))
    .overlay(alignment: .top) { Rectangle().fill(TetherColors.border).frame(height: 0.5) }
    .animation(TetherMotion.ui(TetherMotion.overlay, reduceMotion: reduceMotion), value: model.state.pendingPermissions.first?.requestId)
    .animation(TetherMotion.ui(TetherMotion.overlay, reduceMotion: reduceMotion), value: pendingQuestion?.requestId)
  }

  private var composer: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let query = slashQuery {
        SlashPalette(query: query, commands: model.state.commands) { command in
          draft = ChatSlash.insertion(for: command).text
          composerFocused = true
        }
      }
      if let mention = mentionToken {
        MentionPalette(matches: ChatMention.matches(query: mention.query, files: model.fileIndex.files)) { match in
          let result = ChatMention.insertion(in: draft, token: mention, path: match.path)
          draft = result.text
          cursor = result.cursor
          caretRequest = result.cursor
          composerFocused = true
        }
      }
      if model.link.phase == .catchingUp || model.link.phase == .connecting {
        HStack(spacing: 6) {
          ProgressView().controlSize(.mini).tint(TetherColors.textFaint)
          Text("Catching up…").font(.caption).foregroundStyle(TetherColors.textFaint)
        }
        .padding(.leading, 6)
      }
      if let error = attachments.error {
        AttachmentErrorRow(message: error) { attachments.error = nil }
      }
      if !attachments.items.isEmpty { AttachmentStrip(attachments: attachments) }
      HStack(alignment: .bottom, spacing: 4) {
        attachButton
        composerField
          .lineLimit(1...6)
          .font(.subheadline)
          .padding(.horizontal, 14).padding(.vertical, 8)
          .background(TetherColors.surfaceRaised, in: RoundedRectangle(cornerRadius: 20))
          .opacity(answerPending ? 0.55 : 1)
          .accessibilityLabel("Message the agent")
          .accessibilityHint(permissionPending ? "A permission is waiting above" : questionPending ? "A question is waiting above" : "")
          .accessibilityIdentifier("chatComposer")
        actionButton.padding(.leading, 4)
      }
    }
    .onChange(of: mentionCandidate != nil) { _, open in
      if open { Task { await model.loadMentionFiles() } }
    }
  }

  private var composerPrompt: Text {
    Text(permissionPending ? "Answer the permission above" : questionPending ? "Answer the question above" : working ? "Queue a message" : "Message the agent")
      .foregroundStyle(TetherColors.placeholder)
  }

  @ViewBuilder private var composerField: some View {
    if #available(iOS 18.0, *) {
      CaretComposerField(
        text: $draft, cursor: $cursor, caretRequest: $caretRequest, prompt: composerPrompt, focus: $composerFocused)
    } else {
      TextField("", text: $draft, prompt: composerPrompt, axis: .vertical).focused($composerFocused)
    }
  }

  /// The `@word` being typed, while the host's folder listing is usable and nothing else owns the draft.
  private var mentionCandidate: ChatMention.Token? {
    guard !answerPending, !model.readOnly, !model.hasEnded, slashQuery == nil else { return nil }
    return ChatMention.token(in: draft, cursor: cursor)
  }

  private var mentionToken: ChatMention.Token? {
    guard let token = mentionCandidate,
      !ChatMention.matches(query: token.query, files: model.fileIndex.files, limit: 1).isEmpty
    else { return nil }
    return token
  }

  private var slashQuery: String? {
    guard !answerPending, !model.state.commands.isEmpty else { return nil }
    return ChatSlash.query(in: draft)
  }

  private var attachButton: some View {
    Menu {
      Button { pickingPhotos = true } label: { Label("Photo Library", systemImage: "photo.on.rectangle") }
      if UIPasteboard.general.hasImages {
        Button { pasteImage() } label: { Label("Paste image", systemImage: "doc.on.clipboard") }
      }
    } label: {
      Image(systemName: "plus")
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(TetherColors.textSecondary)
        .frame(width: 28, height: 28)
        .background(TetherColors.surfaceRaised, in: Circle())
        .hitSlop(vertical: 8, horizontal: 8)
    }
    .disabled(answerPending || attachments.room == 0)
    .opacity(answerPending ? 0.55 : 1)
    .padding(.bottom, 4)
    .accessibilityLabel("Attach image")
    .accessibilityIdentifier("chatAttach")
  }

  private func pasteImage() {
    let board = UIPasteboard.general
    let data =
      board.data(forPasteboardType: "public.jpeg") ?? board.data(forPasteboardType: "public.png")
      ?? board.image?.pngData()
    guard let data else { return }
    attachments.add(data: data)
  }

  private var debugOpenMore: Bool {
    #if DEBUG
    ChatFixture.planMode == "plan-more"
    #else
    false
    #endif
  }

  private var permissionPending: Bool { !model.state.pendingPermissions.isEmpty }
  private var pendingQuestion: ChatQuestion? { model.state.pendingQuestions.first }
  private var questionPending: Bool { pendingQuestion != nil }
  private var answerPending: Bool { permissionPending || questionPending }
  private var canSendNow: Bool {
    ChatComposerRule.canSend(
      text: draft, readyImages: attachments.ready.count, encoding: attachments.encoding, sessionCanSend: model.canSend)
  }

  private var working: Bool { model.state.turn == .working }
  private var action: ChatComposerRule.Action {
    ChatComposerRule.action(
      working: working, hasContent: !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.items.isEmpty)
  }
  private var stopping: Bool { action == .stop }

  private var discColor: Color {
    if stopping { return TetherColors.danger.opacity(0.2) }
    return canSendNow ? TetherColors.accent : TetherColors.textFaint.opacity(0.35)
  }

  private var glyphColor: Color {
    if stopping { return TetherColors.danger }
    return canSendNow ? TetherColors.onAccent : TetherColors.textSecondary
  }

  private func sendMessage() {
    guard canSendNow, model.send(text: draft, images: attachments.ready) else { return }
    draft = ""
    attachments.clear()
    userScrolledUp = false
    sendTick += 1
  }

  private var actionButton: some View {
    Button {
      if stopping { model.cancel() } else { sendMessage() }
    } label: {
      Image(systemName: stopping ? "stop.fill" : "arrow.up")
        .font(.system(size: 14, weight: .bold))
        .frame(width: 32, height: 32)
        .foregroundStyle(glyphColor)
        .background(discColor, in: Circle())
        .hitSlop(vertical: 6, horizontal: 6)
    }
    .buttonStyle(TetherPressStyle())
    .disabled(stopping ? !model.canInteract : !canSendNow)
    .accessibilityLabel(stopping ? "Stop" : working ? "Queue message" : "Send")
    .accessibilityIdentifier("chatAction")
  }
}

/// Pinned above the composer so an approval is never lost in the scroll.
struct PermissionCard: View {
  let permission: ChatPermission
  let cwd: String
  let position: String?
  let enabled: Bool
  let approve: (ACPPermissionOption) -> Void
  let review: () -> Void

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @State private var showMore = false
  var startOpen = false

  private func syncOpen() { if startOpen { showMore = true } }

  private var isPlan: Bool { permission.kind == .switchMode && !(permission.text ?? "").isEmpty && permission.diff == nil }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Image(systemName: permission.kind.symbolName).foregroundStyle(TetherColors.accent)
        VStack(alignment: .leading, spacing: 1) {
          Text(isPlan ? "PLAN" : "PERMISSION").font(.caption2.weight(.bold)).tracking(0.8).foregroundStyle(TetherColors.textFaint)
          Text(permission.title).font(.subheadline.weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
            .lineLimit(2)
        }
        Spacer(minLength: 0)
        if let position {
          Text(position).font(.caption2.weight(.semibold).monospaced()).foregroundStyle(TetherColors.textFaint)
        }
      }
      preview
      actions
    }
    .padding(14)
    .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 18))
    .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(TetherColors.accent.opacity(0.45)))
    .shadow(color: .black.opacity(0.18), radius: 10, y: 3)
    .accessibilityElement(children: .contain)
    .onAppear(perform: syncOpen)
  }

  @State private var previewWidth: CGFloat = 0

  @ViewBuilder private var preview: some View {
    if let diff = permission.diff {
      let file = ACPDiffAdapter.file(for: diff, relativeTo: cwd)
      let rows = previewRows(file)
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 8) {
          Text(file.path).font(.caption.monospaced()).lineLimit(1).truncationMode(.head)
            .foregroundStyle(TetherColors.textPrimary)
          Spacer(minLength: 6)
          HStack(spacing: 6) {
            if file.added > 0 { Text("+\(file.added)").foregroundStyle(TetherColors.success) }
            if file.removed > 0 { Text("−\(file.removed)").foregroundStyle(TetherColors.danger) }
          }
          .font(.system(size: 14, weight: .semibold, design: .monospaced))
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(TetherColors.surfaceRaised)
        ScrollView(.horizontal, showsIndicators: false) {
          VStack(alignment: .leading, spacing: 0) {
            ForEach(rows) { row in
              HStack(spacing: 6) {
                Text(gutter(row.kind)).foregroundStyle(edge(row.kind))
                  .frame(width: 10)
                Text(row.text.isEmpty ? " " : row.text)
                  .foregroundStyle(TetherColors.textPrimary)
                  .fixedSize(horizontal: true, vertical: false)
              }
              .font(.caption2.monospaced())
              .padding(.horizontal, 10).padding(.vertical, 1)
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(edge(row.kind).opacity(0.10))
              .overlay(alignment: .leading) { edge(row.kind).frame(width: 2) }
              .accessibilityLabel("\(accessibleKind(row.kind)) \(row.text)")
            }
          }
          .frame(minWidth: previewWidth, alignment: .leading)
          .fixedSize(horizontal: true, vertical: false)
          .padding(.vertical, 4)
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { previewWidth = $0 }
        .mask {
          VStack(spacing: 0) {
            Color.black
            LinearGradient(colors: [.black, .black.opacity(0.15)], startPoint: .top, endPoint: .bottom)
              .frame(height: 16)
          }
        }
        Button(action: review) {
          HStack(spacing: 6) {
            Text("Show full diff").font(.footnote.weight(.semibold))
            Image(systemName: "arrow.up.left.and.arrow.down.right").font(.footnote)
            Spacer(minLength: 0)
          }
          .foregroundStyle(TetherColors.accent)
          .padding(.horizontal, 10)
          .frame(minHeight: 36)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Show full diff of \(file.path), \(file.added) added, \(file.removed) removed")
      }
      .background(TetherColors.background.opacity(0.5))
      .clipShape(RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TetherColors.border))
    } else if isPlan, let text = permission.text {
      PlanPreview(text: text, review: review)
    } else if let text = permission.text, !text.isEmpty {
      Text(String(text.prefix(300))).font(.caption.monospaced()).foregroundStyle(TetherColors.textSecondary)
        .lineLimit(4)
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(TetherColors.background.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TetherColors.border))
    }
  }

  /// Up to five lines: the first removed ones, then the added ones, so a rewrite shows both sides.
  private func previewRows(_ file: DiffFile) -> [DiffRow] {
    let total = dynamicTypeSize.isAccessibilitySize ? 3 : 5
    let removed = Array(file.rows.filter { $0.kind == .removed }.prefix(2))
    let added = Array(file.rows.filter { $0.kind == .added }.prefix(total - removed.count))
    return removed + added
  }

  private func gutter(_ kind: DiffRow.Kind) -> String {
    switch kind {
    case .added: "+"
    case .removed: "−"
    default: " "
    }
  }

  private func accessibleKind(_ kind: DiffRow.Kind) -> String {
    switch kind {
    case .added: "Added"
    case .removed: "Removed"
    default: ""
    }
  }

  private func edge(_ kind: DiffRow.Kind) -> Color {
    switch kind {
    case .added: TetherColors.success
    case .removed: TetherColors.danger
    default: .clear
    }
  }

  /// Reject and the primary allow share one row; the rest are links, or behind "More options" past three.
  private var actions: some View {
    let layout = ChatPermissionOptions.layout(permission.options)
    let pair = [layout.reject, layout.primary].compactMap { $0 }
    return VStack(spacing: 6) {
      if dynamicTypeSize.isAccessibilitySize {
        VStack(spacing: 8) { ForEach(pair, id: \.optionId) { actionButton($0, rejectId: layout.reject?.optionId) } }
      } else {
        HStack(spacing: 8) { ForEach(pair, id: \.optionId) { actionButton($0, rejectId: layout.reject?.optionId) } }
      }
      if layout.collapsed, !layout.more.isEmpty {
        Button { withAnimation(.easeOut(duration: 0.18)) { showMore.toggle() } } label: {
          HStack(spacing: 4) {
            Text("More options").font(.footnote.weight(.medium))
            Image(systemName: showMore ? "chevron.up" : "chevron.down").font(.system(size: 9, weight: .bold))
          }
          .foregroundStyle(TetherColors.textSecondary)
          .frame(maxWidth: .infinity, minHeight: 28)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("More options")
        .accessibilityValue(showMore ? "Expanded" : "Collapsed")
        .accessibilityIdentifier("permissionMore")
        if showMore {
          VStack(spacing: 6) {
            ForEach(layout.more, id: \.optionId) { option in
              Button { approve(option) } label: {
                Text(option.name).font(.subheadline.weight(.medium)).foregroundStyle(TetherColors.accent)
                  .multilineTextAlignment(.center)
                  .frame(maxWidth: .infinity, minHeight: 36)
                  .padding(.horizontal, 10)
                  .background(TetherColors.surfaceRaised, in: RoundedRectangle(cornerRadius: 10))
              }
              .buttonStyle(TetherPressStyle())
              .disabled(!enabled)
              .opacity(enabled ? 1 : 0.5)
              .accessibilityLabel(option.name)
            }
          }
        }
      } else {
        ForEach(layout.more, id: \.optionId) { option in
          Button { approve(option) } label: {
            Text(option.name).font(.footnote.weight(.medium)).foregroundStyle(TetherColors.accent)
              .multilineTextAlignment(.center)
              .frame(maxWidth: .infinity, minHeight: 24)
              .hitSlop(vertical: 10)
          }
          .buttonStyle(.plain)
          .disabled(!enabled)
          .opacity(enabled ? 1 : 0.5)
          .accessibilityLabel(option.name)
        }
      }
    }
  }

  private func actionButton(_ option: ACPPermissionOption, rejectId: String?) -> some View {
    let deny = option.optionId == rejectId
    return Button { approve(option) } label: {
      Text(option.name)
        .font(.subheadline.weight(deny ? .medium : .semibold))
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity, minHeight: 34)
        .padding(.horizontal, 10).padding(.vertical, 6)
        .foregroundStyle(deny ? TetherColors.danger : TetherColors.onAccent)
        .background(deny ? TetherColors.danger.opacity(0.14) : TetherColors.accent, in: RoundedRectangle(cornerRadius: 10))
        .hitSlop(vertical: 5)
    }
    .buttonStyle(TetherPressStyle())
    .disabled(!enabled)
    .opacity(enabled ? 1 : 0.5)
    .accessibilityLabel(option.name)
  }
}

/// The agent's plan as markdown in a capped, scrollable box; the full text opens in a sheet.
private struct PlanPreview: View {
  let text: String
  let review: () -> Void
  @State private var blocks: [MarkdownBlock]

  init(text: String, review: @escaping () -> Void) {
    self.text = text
    self.review = review
    _blocks = State(initialValue: MarkdownDocument.parse(text))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ScrollView {
        MarkdownBodyView(blocks: blocks)
          .padding(10)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(maxHeight: 150)
      .scrollBounceBehavior(.basedOnSize)
      Rectangle().fill(TetherColors.border).frame(height: 0.5)
      Button(action: review) {
        HStack(spacing: 6) {
          Text("Show full plan").font(.footnote.weight(.semibold))
          Image(systemName: "arrow.up.left.and.arrow.down.right").font(.footnote)
          Spacer(minLength: 0)
        }
        .foregroundStyle(TetherColors.accent)
        .padding(.horizontal, 10)
        .frame(minHeight: 36)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("planShowFull")
    }
    .background(TetherColors.background.opacity(0.5))
    .clipShape(RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TetherColors.border))
    .onChange(of: text) { _, next in blocks = MarkdownDocument.parse(next) }
  }
}

extension ChatPermission: Identifiable {
  var id: ACPID { requestId }
}

private struct PermissionReviewSheet: View {
  let permission: ChatPermission
  let cwd: String
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        if let diff = permission.diff {
          DiffReviewView(files: [ACPDiffAdapter.file(for: diff, relativeTo: cwd)]).padding(.vertical, 8)
        } else if let text = permission.text {
          MarkdownBodyView(blocks: MarkdownDocument.parse(text), reading: true)
            .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      .background(TetherColors.background)
      .navigationTitle(permission.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
    }
  }
}

struct JumpToLatestButton: View {
  let action: () -> Void
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    Button(action: action) {
      HStack(spacing: 5) {
        Image(systemName: "arrow.down").font(.caption2.weight(.bold))
        Text("Jump to latest").font(.caption.weight(.medium))
      }
      .foregroundStyle(TetherColors.textPrimary)
      .padding(.horizontal, 12).frame(height: 28)
      .background(TetherColors.surfaceRaised, in: Capsule())
      .overlay(Capsule().strokeBorder(TetherColors.border, lineWidth: 0.5))
      .hitSlop(vertical: 8, horizontal: 8)
    }
    .buttonStyle(TetherPressStyle())
    .padding(.bottom, 8)
    .transition(.opacity)
  }
}

/// iOS 18: the scroll view stays pinned to the end while content grows (`.sizeChanges`) and lets go
/// once the user scrolls up; "at the bottom" comes from the real offset and sizes.
@available(iOS 18.0, *)
private struct FollowingTranscript<Content: View>: View {
  @Binding var atBottom: Bool
  @Binding var scrolledUnder: Bool
  let sendTick: Int
  let reduceMotion: Bool
  var startAtTop = false
  @ViewBuilder var content: () -> Content

  @State private var position = ScrollPosition(edge: .bottom)
  @State private var sendPending = false

  var body: some View {
    ScrollView {
      content()
    }
    .scrollPosition($position)
    .defaultScrollAnchor(.bottom, for: .initialOffset)
    .defaultScrollAnchor(.bottom, for: .sizeChanges)
    .scrollDismissesKeyboard(.interactively)
    .onScrollGeometryChange(for: Bool.self) { geometry in
      ChatScrollFollow.isNearBottom(
        offset: geometry.visibleRect.minY,
        content: geometry.contentSize.height,
        container: geometry.visibleRect.height)
    } action: { _, near in
      atBottom = near
    }
    .onScrollGeometryChange(for: Bool.self) { geometry in
      geometry.contentOffset.y + geometry.contentInsets.top > 1
    } action: { _, under in
      scrolledUnder = under
    }
    .scrollEdgeEffectHiddenIfAvailable()
    .overlay(alignment: .bottom) {
      if !atBottom {
        JumpToLatestButton {
          withAnimation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion)) {
            position.scrollTo(edge: .bottom)
          }
        }
      }
    }
    .task {
      guard startAtTop else { return }
      try? await Task.sleep(nanoseconds: 900_000_000)
      position.scrollTo(edge: .top)
    }
    .onChange(of: sendTick) { _, _ in sendPending = true }
    .onScrollGeometryChange(for: ChatScrollMetrics.self) { geometry in
      ChatScrollMetrics(
        offset: geometry.visibleRect.minY, content: geometry.contentSize.height,
        container: geometry.visibleRect.height)
    } action: { old, new in
      guard ChatScrollFollow.shouldJumpToEnd(old: old, new: new, sendPending: sendPending) else { return }
      if sendPending { sendPending = false }
      position.scrollTo(edge: .bottom)
    }
    .animation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion), value: atBottom)
  }
}

extension View {
  @ViewBuilder fileprivate func scrollEdgeEffectHiddenIfAvailable() -> some View {
    if #available(iOS 26.0, *) { scrollEdgeEffectHidden(true, for: .all) } else { self }
  }
}

extension ToolbarContent {
  /// iOS 26 wraps every toolbar item in a glass bubble; the chat header stays flat.
  @ToolbarContentBuilder fileprivate func withoutGlass() -> some ToolbarContent {
    if #available(iOS 26.0, *) { sharedBackgroundVisibility(.hidden) } else { self }
  }
}
