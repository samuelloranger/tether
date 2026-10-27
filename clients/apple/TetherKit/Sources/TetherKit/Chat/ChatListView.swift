import SwiftUI

/// Reached from a host: its chats, and a row to start another.
struct ChatListView: View {
  @Bindable var model: ChatListModel
  var onOpen: (ChatRoute) -> Void
  var onClose: () -> Void

  @State private var newFolder = "~"
  @State private var starting = false
  @State private var pendingDeletion: ACPChatSummary?
  @FocusState private var folderFocused: Bool

  var body: some View {
    List {
      Section {
        newChatRow.themedRow()
        if let message = model.startError {
          Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(TetherColors.warning)
            .themedRow()
            .accessibilityIdentifier("chatStartError")
        }
      } header: {
        sectionHeader("New chat")
      }
      Section {
        content
      } header: {
        sectionHeader("On \(model.hostName)")
      }
    }
    .themedList()
    .listStyle(.insetGrouped)
    .navigationTitle("Chat")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        Button(action: onClose) { Label("Home", systemImage: "chevron.backward") }
          .accessibilityIdentifier("chatListHome")
      }
    }
    .refreshable { await model.refresh() }
    .task { await model.refresh() }
    .alert(
      "Something went wrong",
      isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })
    ) {
      Button("OK", role: .cancel) { model.errorMessage = nil }
    } message: {
      Text(model.errorMessage ?? "")
    }
    .destructiveConfirmation(
      $pendingDeletion,
      title: { "Delete \($0.title)?" },
      actionLabel: "Delete chat",
      message: "The agent stops and the conversation is removed from the host."
    ) { chat in Task { await model.delete(chat) } }
  }

  private func sectionHeader(_ text: String) -> some View {
    Text(text).font(.system(size: 12, weight: .semibold)).tracking(0.6)
      .foregroundStyle(TetherColors.textSecondary)
      .textCase(.uppercase)
  }

  private var newChatRow: some View {
    VStack(alignment: .leading, spacing: 10) {
      VStack(alignment: .leading, spacing: 4) {
        Text("Working folder").font(.caption).foregroundStyle(TetherColors.textSecondary)
        HStack(spacing: 8) {
          TextField("Folder on the host", text: $newFolder)
            .font(.body.monospaced())
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .focused($folderFocused)
            .submitLabel(.go)
            .onSubmit(start)
            .accessibilityLabel("Working folder for the new chat")
          Image(systemName: "chevron.right").font(.caption.weight(.semibold))
            .foregroundStyle(TetherColors.textFaint)
            .accessibilityHidden(true)
        }
        .contentShape(Rectangle())
        .onTapGesture { folderFocused = true }
      }
      Button(action: start) {
        Group {
          if starting {
            ProgressView().tint(TetherColors.onAccent)
          } else {
            Text("Start chat").font(.subheadline.weight(.semibold))
          }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 36)
        .foregroundStyle(TetherColors.onAccent)
        .background(TetherColors.accent, in: RoundedRectangle(cornerRadius: 10))
        .padding(.vertical, 4)
        .contentShape(Rectangle())
      }
      .buttonStyle(TetherPressStyle())
      .disabled(starting)
      .accessibilityIdentifier("chatNew")
    }
    .padding(.vertical, 2)
  }

  private func start() {
    guard !starting else { return }
    starting = true
    folderFocused = false
    Task {
      defer { starting = false }
      if let route = await model.newRoute(cwdText: newFolder) { onOpen(route) }
    }
  }

  @ViewBuilder private var content: some View {
    switch model.load {
    case .loading where model.chats.isEmpty:
      HStack { Spacer(); ProgressView().tint(TetherColors.accent); Spacer() }.themedRow()
    case let .failed(message):
      VStack(alignment: .leading, spacing: 8) {
        Label("Couldn't list chats", systemImage: "exclamationmark.triangle")
          .font(.subheadline.weight(.semibold)).foregroundStyle(TetherColors.warning)
        Text(message).font(.footnote).foregroundStyle(TetherColors.textSecondary)
        Button("Try again") { Task { await model.refresh() } }.font(.footnote.weight(.semibold))
      }
      .themedRow()
    default:
      if model.chats.isEmpty {
        Text("No chats on this host yet.").font(.footnote).foregroundStyle(TetherColors.textSecondary)
          .themedRow()
      }
      ForEach(model.chats) { chat in
        Button { onOpen(model.route(for: chat)) } label: { ChatListRow(chat: chat, agent: model.agent(for: chat)) }
          .buttonStyle(.plain)
          .themedRow()
          .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) { pendingDeletion = chat } label: { Label("Delete", systemImage: "trash") }
          }
      }
    }
  }
}

private struct ChatListRow: View {
  let chat: ACPChatSummary
  let agent: ChatAgentProfile?

  private var status: String { chat.isRunning ? "Running" : "Ended" }
  private var agentTag: String? { ChatFormat.agentLabel(spawn: chat.spawn) ?? (agent == nil ? "Agent" : nil) }

  var body: some View {
    HStack(spacing: 12) {
      ChatAgentMark(agent: agent, size: 18)
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          Text(chat.title).font(.body.weight(.medium)).foregroundStyle(TetherColors.textPrimary)
            .lineLimit(1)
          if let agentTag {
            Text(agentTag).font(.caption2.weight(.semibold)).foregroundStyle(TetherColors.textSecondary)
              .padding(.horizontal, 6).padding(.vertical, 1)
              .background(TetherColors.textPrimary.opacity(0.06), in: Capsule())
              .fixedSize()
          }
        }
        if let parent = ChatFormat.parentPath(chat.cwd) {
          Text(parent).font(.caption.monospaced()).foregroundStyle(TetherColors.textFaint)
            .lineLimit(1).truncationMode(.middle)
        }
      }
      Spacer(minLength: 8)
      VStack(alignment: .trailing, spacing: 4) {
        statusPill
        Text(chat.created, format: .relative(presentation: .named))
          .font(.caption2).foregroundStyle(TetherColors.textFaint)
      }
      Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(TetherColors.textFaint)
    }
    .padding(.vertical, 4)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      "\(chat.title), \(status.lowercased()), started \(chat.created.formatted(.relative(presentation: .named)))"
    )
    .accessibilityHint("Opens this chat")
  }

  private var statusPill: some View {
    let tint = chat.isRunning ? TetherColors.success : TetherColors.textFaint
    return HStack(spacing: 5) {
      Circle().fill(tint).frame(width: 6, height: 6)
      Text(status).font(.caption2.weight(.semibold)).foregroundStyle(chat.isRunning ? tint : TetherColors.textSecondary)
    }
    .padding(.horizontal, 9)
    .frame(height: 24)
    .background(tint.opacity(chat.isRunning ? 0.14 : 0.10), in: Capsule())
    .accessibilityHidden(true)
  }
}

/// The nav stack Home pushes: the list, and a chat on top of it.
struct ChatFlowView: View {
  let list: ChatListModel
  let config: SSHConnectionConfig
  let hostKeyStore: HostKeyStore
  /// A chat a notification asked for.
  var opening: String?
  var onClose: () -> Void

  @State private var route: ChatRoute?

  var body: some View {
    NavigationStack {
      ChatListView(model: list, onOpen: { route = $0 }, onClose: onClose)
        .navigationDestination(item: $route) { route in
          ChatScreen(route: route, config: config, hostKeyStore: hostKeyStore)
        }
    }
    .onChange(of: opening, initial: true) { _, name in
      guard let name else { return }
      route = ChatRoute.opening(
        name: name, chats: list.chats, journal: UserDefaultsChatJournalStore(name: name).load(),
        localAgent: ChatTitleStore(config: config).agent(for: name))
    }
    .onDisappear { Task { await list.close() } }
  }
}

private struct ChatScreen: View {
  @State private var model: ChatSessionModel

  init(route: ChatRoute, config: SSHConnectionConfig, hostKeyStore: HostKeyStore) {
    _model = State(initialValue: .live(route: route, config: config, hostKeyStore: hostKeyStore))
  }

  var body: some View {
    ChatView(model: model)
  }
}
