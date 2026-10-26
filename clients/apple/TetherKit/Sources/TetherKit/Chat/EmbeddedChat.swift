import SwiftUI

/// A chat shown in the terminal screen's main area. Its own connection, so the terminal stays attached.
struct EmbeddedChat: View {
  let onSessions: () -> Void
  let needsYou: Bool
  let onContinueInTerminal: (String, String) -> Void
  @State private var model: ChatSessionModel

  init(
    route: ChatRoute, controller: SSHTerminalController, needsYou: Bool = false, onSessions: @escaping () -> Void,
    onContinueInTerminal: @escaping (String, String) -> Void
  ) {
    self.onSessions = onSessions
    self.needsYou = needsYou
    self.onContinueInTerminal = onContinueInTerminal
    _model = State(initialValue: controller.makeChatModel(route: route))
  }

  var body: some View {
    NavigationStack {
      ChatView(
        model: model, onSessions: onSessions, sessionsNeedYou: needsYou, onContinueInTerminal: onContinueInTerminal)
    }
    .tint(TetherColors.accent)
  }
}

/// The working-folder step of a new chat, opened from the drawer's "+" menu, with a second mode
/// that picks an earlier conversation in that folder to carry on.
struct NewChatSheet: View {
  enum Mode: String, CaseIterable, Identifiable {
    case new = "New"
    case resume = "Continue"
    var id: String { rawValue }
  }

  let initialFolder: String
  var initialMode: Mode = .new
  /// Resolves the folder and opens the chat; a message leaves the sheet up showing it.
  let onStart: (String) async -> String?
  /// The earlier conversations in a folder.
  let loadSessions: (String) async -> ChatContinueLoader.Result
  /// Opens the chat that continues `session`; a message leaves the sheet up showing it.
  let onContinue: (String, ACPSavedSession) async -> String?
  let onCancel: () -> Void

  @State private var mode: Mode = .new
  @State private var folder = ""
  @State private var starting = false
  @State private var failure: String?
  @State private var listing: Listing = .idle
  @State private var reloads = 0
  @State private var continuing: String?
  @FocusState private var focused: Bool

  enum Listing: Equatable {
    case idle
    case loading
    case loaded([ACPSavedSession])
    case failed(String)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text(mode == .new ? "New chat" : "Continue a chat").font(.footnote.weight(.semibold))
          .foregroundStyle(TetherColors.textSecondary)
          .accessibilityAddTraits(.isHeader)
        Spacer()
        Button("Cancel", action: onCancel).font(.subheadline).foregroundStyle(TetherColors.accent)
          .buttonStyle(TetherPressStyle())
      }
      Picker("Mode", selection: $mode) {
        ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
      }
      .pickerStyle(.segmented)
      .accessibilityIdentifier("sshNewChatMode")
      VStack(alignment: .leading, spacing: 6) {
        Text("Working folder").font(.caption).foregroundStyle(TetherColors.textSecondary)
        TextField("Folder on the host", text: $folder)
          .font(.callout.monospaced()).foregroundStyle(TetherColors.textPrimary)
          .textInputAutocapitalization(.never).autocorrectionDisabled()
          .focused($focused).submitLabel(.go).onSubmit(submitFolder)
          .padding(10).background(TetherColors.input, in: RoundedRectangle(cornerRadius: 10))
          .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TetherColors.border))
          .accessibilityLabel("Working folder for the new chat")
          .accessibilityIdentifier("sshNewChatFolder")
        if let failure {
          Text(failure).font(.caption).foregroundStyle(TetherColors.warning)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("sshNewChatError")
        }
      }
      if mode == .new {
        Button(action: start) {
          Group {
            if starting { ProgressView().tint(TetherColors.onAccent) } else {
              Text("Start chat").font(.subheadline.weight(.semibold))
            }
          }
          .frame(maxWidth: .infinity).frame(height: 36)
          .foregroundStyle(TetherColors.onAccent)
          .background(TetherColors.accent, in: RoundedRectangle(cornerRadius: 10))
          .padding(.vertical, 4).contentShape(Rectangle())
        }
        .buttonStyle(TetherPressStyle())
        .disabled(starting)
        .accessibilityIdentifier("sshNewChatStart")
        Spacer(minLength: 0)
      } else {
        sessionList
      }
    }
    .padding(.horizontal, 16).padding(.top, 16)
    .background(TetherColors.background.ignoresSafeArea())
    .presentationDetents(mode == .new ? [.height(failure == nil ? 252 : 320)] : [.medium, .large])
    .onAppear {
      if folder.isEmpty { folder = initialFolder }
      mode = initialMode
    }
    .task(id: "\(mode.rawValue)|\(folder)|\(reloads)") { await reload() }
    .onChange(of: mode) { _, _ in failure = nil }
  }

  private var sessionList: some View {
    VStack(alignment: .leading, spacing: 0) {
      switch listing {
      case .idle, .loading:
        HStack(spacing: 8) {
          ProgressView().controlSize(.small).tint(TetherColors.textFaint)
          Text("Looking for earlier conversations…").font(.subheadline).foregroundStyle(TetherColors.textSecondary)
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .accessibilityIdentifier("sshContinueLoading")
      case let .failed(message):
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(message).font(.caption).foregroundStyle(TetherColors.warning)
            .fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 0)
          Button("Retry") { reloads += 1 }
            .font(.subheadline.weight(.semibold)).foregroundStyle(TetherColors.accent)
            .buttonStyle(TetherPressStyle())
            .accessibilityIdentifier("sshContinueRetry")
        }
        .padding(.vertical, 8)
        .accessibilityIdentifier("sshContinueError")
      case let .loaded(sessions) where sessions.isEmpty:
        Text("No earlier conversations in this folder").font(.subheadline).foregroundStyle(TetherColors.textSecondary)
          .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
          .accessibilityIdentifier("sshContinueEmpty")
      case let .loaded(sessions):
        TimelineView(.periodic(from: .now, by: 30)) { context in
          ScrollView {
            LazyVStack(spacing: 0) {
              ForEach(Array(sessions.enumerated()), id: \.element.id) { index, session in
                if index > 0 { Rectangle().fill(TetherColors.border.opacity(0.6)).frame(height: 0.5) }
                sessionRow(session, now: context.date)
              }
            }
          }
          .scrollBounceBehavior(.basedOnSize)
        }
        .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(TetherColors.border, lineWidth: 0.5))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .accessibilityIdentifier("sshContinueList")
      }
    }
    .frame(maxHeight: .infinity, alignment: .top)
    .padding(.bottom, 8)
  }

  private func sessionRow(_ session: ACPSavedSession, now: Date) -> some View {
    Button { resume(session) } label: {
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 8) {
          Text(session.displayTitle).font(.subheadline).foregroundStyle(TetherColors.textPrimary).lineLimit(1)
          Spacer(minLength: 4)
          if continuing == session.id {
            ProgressView().controlSize(.small).tint(TetherColors.textFaint)
          } else {
            Text(ChatContinueFormat.relative(session.updatedAt, now: now)).font(.caption)
              .foregroundStyle(TetherColors.textFaint).fixedSize()
          }
        }
        if ChatContinueFormat.isRecent(session.updatedAt, now: now) {
          Text(ChatContinueFormat.recentNote).font(.caption2).foregroundStyle(TetherColors.warning)
            .lineLimit(2).fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(.horizontal, 12).padding(.vertical, 8)
      .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(TetherPressStyle())
    .disabled(continuing != nil)
    .accessibilityLabel("\(session.displayTitle), \(ChatContinueFormat.relative(session.updatedAt, now: now))")
    .accessibilityIdentifier("sshContinueRow_\(session.id)")
  }

  private func reload() async {
    guard mode == .resume else { return }
    let wanted = folder
    listing = .loading
    try? await Task.sleep(nanoseconds: 500_000_000)
    guard !Task.isCancelled else { return }
    let result = await loadSessions(wanted)
    guard !Task.isCancelled, wanted == folder else { return }
    switch result {
    case let .loaded(sessions): listing = .loaded(sessions)
    case let .failed(message): listing = .failed(message)
    }
  }

  private func submitFolder() {
    if mode == .new { start() } else { focused = false; reloads += 1 }
  }

  private func start() {
    guard !starting else { return }
    starting = true
    failure = nil
    focused = false
    Task {
      defer { starting = false }
      failure = await onStart(folder)
    }
  }

  private func resume(_ session: ACPSavedSession) {
    guard continuing == nil else { return }
    continuing = session.id
    failure = nil
    focused = false
    Task {
      defer { continuing = nil }
      failure = await onContinue(folder, session)
    }
  }
}
