import SwiftUI

/// A chat shown in the terminal screen's main area. Its own connection, so the terminal stays attached.
struct EmbeddedChat: View {
  let onSessions: () -> Void
  let needsYou: Bool
  let onContinueInTerminal: (String, String) async -> String?
  let model: ChatSessionModel
  @State private var showGit = false
  private let controller: SSHTerminalController
  private let folder: String
  private let onOpenChat: ((ChatRoute) -> Void)?

  init(
    model: ChatSessionModel, folder: String, controller: SSHTerminalController, needsYou: Bool = false, onSessions: @escaping () -> Void,
    onContinueInTerminal: @escaping (String, String) async -> String?, onOpenChat: ((ChatRoute) -> Void)? = nil
  ) {
    self.onSessions = onSessions
    self.onOpenChat = onOpenChat
    self.needsYou = needsYou
    self.onContinueInTerminal = onContinueInTerminal
    self.controller = controller
    self.model = model
    self.folder = folder
  }

  var body: some View {
    NavigationStack {
      ChatView(
        model: model, onSessions: onSessions, sessionsNeedYou: needsYou, onContinueInTerminal: onContinueInTerminal,
        onShowGit: {
          controller.setGitTarget(GitTarget.forChat(folder: folder))
          showGit = true
        },
        onUpload: { data, name in await controller.sendFile(data: data, filename: name, to: .uploads) },
        uploads: controller.chatUploads,
        onBranch: { point, title, prompt in
          switch await controller.branchChat(source: model, point: point, title: title, prompt: prompt) {
          case let .failed(message): return message
          case let .ready(route): onOpenChat?(route); return nil
          }
        }, onOpenParent: { parent in
          onOpenChat?(ChatRoute.opening(name: parent.name, chats: controller.chats,
            journal: UserDefaultsChatJournalStore(name: parent.name).load(), localAgent: model.agent?.key))
        }, leavesOnDisappear: false)
    }
    .sheet(isPresented: $showGit, onDismiss: { controller.setGitTarget(.session) }) {
      GitDiffView(controller: controller) { showGit = false }
        .onAppear { controller.setGitTarget(GitTarget.forChat(folder: folder)) }
    }
    .tint(TetherColors.accent)
  }
}

/// What a New chat sheet hands the chat it starts.
struct NewChatRequest: Equatable {
  var agent: ChatAgentProfile
  /// nil applies the stored defaults; see `ChatNewOptions.picks`.
  var picks: [String: String]?
  /// The options the sheet changed from what it opened with.
  var changed: Set<String> = []
  /// Folders the agent may use besides the main one, as typed (`~` is resolved on the host).
  var extraFolders: [String] = []
  /// Saved MCP servers picked for this chat.
  var mcpServerNames: [String] = []
}

/// The working-folder step of a new chat, opened from the drawer's "+" menu, with a second mode
/// that picks an earlier conversation in that folder to carry on. The agent and its options are picked here too.
struct NewChatSheet: View {
  enum Mode: String, CaseIterable, Identifiable {
    case new = "New"
    case resume = "Continue"
    var id: String { rawValue }
  }

  let initialFolder: String
  var hostName = ""
  var initialMode: Mode = .new
  /// Nil starts on the agent picked last on this device.
  var initialAgent: ChatAgentProfile?
  var initiallyOpenOptions = false
  var initiallyBrowseFolders = false
  /// Options already changed when the sheet opens, for previews.
  var initialChanges: [String: String] = [:]
  /// The stored defaults and the cached choices of an agent, for the Options row.
  var storedDefaults: (ChatAgentProfile) -> [String: String] = { _ in [:] }
  var cachedOptions: (ChatAgentProfile) -> [ACPConfigOption] = { _ in [] }
  var onAgentPicked: (ChatAgentProfile) -> Void = { _ in }
  /// Agent key → why the host can't run it; those agents are dimmed and refuse the pick.
  var checkAgents: () async -> [String: String] = { [:] }
  let checkFolder: (String, Bool) async -> ChatFolder
  /// Resolves the folder and opens the chat; a message leaves the sheet up showing it.
  let onStart: (String, NewChatRequest) async -> String?
  /// The earlier conversations of an agent in a folder.
  let loadSessions: (String, ChatAgentProfile) async -> ChatContinueLoader.Result
  /// Opens the chat that continues `session`; a message leaves the sheet up showing it.
  let onContinue: (String, ACPSavedSession, NewChatRequest) async -> String?
  /// Deletes an earlier conversation on the host; a message is the reason it failed.
  var onDeleteSession: ((String, ACPSavedSession, ChatAgentProfile) async -> String?)?
  /// This host's saved MCP servers; nil hides the section.
  var mcpStore: ChatMCPServerStore?
  var initiallyOpenAccess = false
  var initialExtraFolders: [String] = []
  var initialMCPPicks: Set<String> = []
  /// The host's agent versions; nil leaves the update notice out.
  var loadVersions: (() async -> ACPAgentVersions.Result?)?
  /// Updates an agent's adapter on the host; a message is why it failed.
  var onUpdateAgent: ((ACPAgentVersion) async -> String?)?
  /// The options a new session in the folder starts with, read from the agent now.
  var liveOptions: ((String, ChatAgentProfile) async -> [ACPConfigOption]?)?
  var managedStore: ChatManagedAgentsStore?
  let onCancel: () -> Void

  @State private var mode: Mode = .new
  @State private var agent: ChatAgentProfile = ChatAgents.claude
  @State private var folder = ""
  @State private var folderInfo: ChatFolder?
  @State private var checkingFolder = true
  @State private var creatingFolder = false
  @State private var browsing = false
  @State private var starting = false
  @State private var failure: String?
  @State private var listing: Listing = .idle
  @State private var reloads = 0
  @State private var continuing: String?
  @State private var optionsOpen = false
  @State private var changes: [String: String] = [:]
  @State private var reset = false
  @State private var unavailable: [String: String] = [:]
  @State private var accessOpen = false
  @State private var extraFolders: [String] = []
  @State private var newFolder = ""
  @State private var servers: [ChatMCPServer] = []
  @State private var pickedServers: Set<String> = []
  @State private var addingServer = false
  @State private var deleting: ACPSavedSession?
  @State private var deletingNow = false
  @State private var versions: ACPAgentVersions.Result?
  @State private var updating: String?
  @State private var updateMessage: String?
  @State private var dismissedUpdates: Set<String> = []
  @State private var freshOptions: [String: [ACPConfigOption]] = [:]
  @State private var optionReads = 0
  @FocusState private var focused: Bool

  enum Listing: Equatable {
    case idle
    case loading
    case loaded([ACPSavedSession])
    case failed(String)
  }

  /// The last failure, else why the picked agent can't run here; derived so a mode change keeps it.
  private var shownFailure: String? { failure ?? unavailable[agent.key] }
  private var stored: [String: String] { storedDefaults(agent) }
  private var cached: [ACPConfigOption] { freshOptions[agent.key] ?? cachedOptions(agent) }
  private var optionRows: [ChatNewOptions.Row] {
    ChatNewOptions.rows(agent: agent, stored: stored, cached: cached, changes: changes, reset: reset)
  }
  private var request: NewChatRequest {
    NewChatRequest(
      agent: agent, picks: ChatNewOptions.picks(stored: stored, changes: changes, reset: reset),
      changed: Set(changes.keys), extraFolders: extraFolders,
      mcpServerNames: servers.map(\.name).filter(pickedServers.contains))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text(mode == .new ? "New chat" : "Continue a chat").font(.chat(.headline))
          .foregroundStyle(TetherColors.textPrimary)
          .accessibilityAddTraits(.isHeader)
        Spacer()
        Button("Cancel", action: onCancel).font(.chat(.subheadline)).foregroundStyle(TetherColors.textPrimary)
          .frame(minHeight: 44).buttonStyle(TetherPressStyle())
          .disabled(starting || creatingFolder || continuing != nil)
      }
      Picker("Mode", selection: $mode) {
        ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
      }
      .pickerStyle(.segmented)
      .disabled(starting || creatingFolder || continuing != nil)
      .accessibilityIdentifier("sshNewChatMode")
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          agentPicker
          agentNotice
          VStack(alignment: .leading, spacing: 6) {
            ChatFolderPicker(folder: $folder, folderInfo: $folderInfo, checkingFolder: $checkingFolder,
              creatingFolder: $creatingFolder, browsing: $browsing, focused: $focused,
              disabled: starting || continuing != nil, hostName: hostName,
              checkFolder: checkFolder, onSubmit: submitFolder)
            if let shownFailure {
              Text(shownFailure).font(.chat(.caption)).foregroundStyle(TetherColors.warning)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("sshNewChatError")
            }
          }
          optionsBox.disabled(starting || creatingFolder || continuing != nil)
          accessBox.disabled(starting || creatingFolder || continuing != nil)
          if mode == .resume { sessionList.frame(minHeight: 140, maxHeight: 340) }
        }
      }
      .scrollBounceBehavior(.basedOnSize)
      .scrollDismissesKeyboard(.interactively)
    }
    .padding(.horizontal, 16).padding(.top, 8)
    .background(TetherColors.background.ignoresSafeArea())
    .safeAreaInset(edge: .bottom) {
      if mode == .new { startButton.padding(.horizontal, 16).padding(.vertical, 12).background(TetherColors.background) }
    }
    .presentationDetents(mode == .new ? [.height(newHeight), .large] : [.medium, .large])
    .interactiveDismissDisabled(starting || creatingFolder || continuing != nil)
    .onAppear {
      if folder.isEmpty { folder = initialFolder }
      mode = initialMode
      agent = initialAgent ?? ChatLastAgentStore().agent
      optionsOpen = initiallyOpenOptions
      browsing = initiallyBrowseFolders
      changes = initialChanges
      accessOpen = initiallyOpenAccess
      servers = mcpStore?.servers ?? []
      extraFolders = initialExtraFolders
      pickedServers = initialMCPPicks
    }
    .task(id: "\(mode.rawValue)|\(agent.key)|\(folder)|\(reloads)") { await reload() }
    .task { unavailable = await checkAgents() }
    .task {
      let knewManaged = managedStore?.supported == true
      versions = await loadVersions?()
      // The first read of options ran before this host was known to manage agents.
      if case .supported? = versions, !knewManaged { optionReads += 1 }
    }
    .task(id: "\(agent.key)|\(folderInfo?.ready == true ? folder : "")|\(optionReads)") { await readLiveOptions() }
    .onChange(of: folder) { _, _ in
      folderInfo = nil
      checkingFolder = true
      failure = nil
    }
    .onChange(of: mode) { _, _ in failure = nil }
    .sheet(isPresented: $addingServer) {
      ChatMCPServerForm(existing: servers) { server in
        servers.append(server)
        mcpStore?.servers = servers
        pickedServers.insert(server.name)
      }
    }
    .confirmationDialog(
      "Delete this conversation?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
      titleVisibility: .visible, presenting: deleting
    ) { session in
      Button("Delete", role: .destructive) { delete(session) }
    } message: { _ in
      Text("Its transcript is removed from the host. This can't be undone.")
    }
  }

  private var startButton: some View {
    Button(action: start) {
      Group {
        if starting { ProgressView().tint(TetherColors.background) } else {
          Text("Start chat").font(.chat(.subheadline).weight(.semibold))
        }
      }
      .frame(maxWidth: .infinity, minHeight: 44)
      .foregroundStyle(TetherColors.background)
      .background(TetherColors.textPrimary, in: Capsule())
      .contentShape(Rectangle())
    }
    .buttonStyle(TetherPressStyle())
    .disabled(starting || creatingFolder || checkingFolder || folderInfo?.ready != true)
    .opacity(checkingFolder || creatingFolder || folderInfo?.ready != true ? 0.45 : 1)
    .accessibilityIdentifier("sshNewChatStart")
  }

  private var newHeight: CGFloat {
    var height: CGFloat = 410
    if folderInfo?.message != nil { height += 44 }
    if shownFailure != nil { height += 68 }
    if optionsOpen { height += optionRows.isEmpty ? 64 : CGFloat(optionRows.count) * 44 + 44 }
    height += 56
    height += CGFloat(pendingUpdates.count) * 48
    if updateMessage != nil || (versions == .unsupported && agent.isHostManaged) { height += 40 }
    if accessOpen { height += CGFloat(extraFolders.count + servers.count) * 44 + 44 * 3 + 12 }
    return height
  }

  // MARK: Agent

  private var agentPicker: some View {
    HStack(spacing: 12) {
      Text("Agent").font(.chat(.subheadline)).foregroundStyle(TetherColors.textSecondary)
      Menu {
        ForEach(ChatAgents.all) { option in
          let missing = unavailable[option.key] != nil
          Button { pick(option) } label: {
            Label {
              Text(option.label)
            } icon: {
              ChatAgentMark(agent: option, size: 14)
            }
          }
          .disabled(missing)
          .accessibilityIdentifier("sshNewChatAgent_\(option.key)")
          .accessibilityHint(missing ? "Not installed on the host" : "")
        }
      } label: {
        HStack(spacing: 8) {
          ChatAgentMark(agent: agent, size: 16)
          Text(agent.label).font(.chat(.subheadline).weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
            .lineLimit(1)
          Spacer(minLength: 4)
          Image(systemName: "chevron.up.chevron.down")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(TetherColors.textFaint)
        }
        .padding(.horizontal, 10).frame(minHeight: 44)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Agent, \(agent.label)")
      .accessibilityIdentifier("sshNewChatAgentSelect")
      .disabled(starting || creatingFolder || continuing != nil)
    }
  }

  // MARK: Agent version

  /// The selected agent's adapter and CLI updates the user hasn't put off.
  private var pendingUpdates: [ACPAgentVersion] {
    guard case let .supported(all)? = versions else { return [] }
    return [ACPAgentVersion.Kind.adapter, .cli].compactMap { kind in
      guard let version = all["\(kind.rawValue):\(agent.key)"], version.updateAvailable,
        !dismissedUpdates.contains(version.key + "@" + version.latest), managedStore?.isDismissed(version) != true
      else { return nil }
      return version
    }
  }

  @ViewBuilder private var agentNotice: some View {
    if !pendingUpdates.isEmpty || updateMessage != nil {
      VStack(alignment: .leading, spacing: 0) {
        ForEach(pendingUpdates, id: \.key) { updateRow($0) }
        if let updateMessage {
          Text(updateMessage).font(.chat(.caption)).foregroundStyle(TetherColors.textSecondary)
            .fixedSize(horizontal: false, vertical: true).padding(.vertical, 4)
            .accessibilityIdentifier("sshNewChatUpdateResult")
        }
      }
      .accessibilityIdentifier("sshNewChatUpdateNotice")
    } else if versions == .unsupported, agent.isHostManaged {
      Text("Update tether on this host to manage agent versions.").font(.chat(.caption))
        .foregroundStyle(TetherColors.textFaint)
        .accessibilityIdentifier("sshNewChatHostTooOld")
    }
  }

  private func updateRow(_ version: ACPAgentVersion) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Text(version.notice(label: agent.label)).font(.chat(.caption)).foregroundStyle(TetherColors.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 4)
        if updating == version.key {
          ProgressView().controlSize(.small).tint(TetherColors.textFaint)
        } else {
          Button("Not now") {
            managedStore?.dismiss(version)
            dismissedUpdates.insert(version.key + "@" + version.latest)
          }
          .font(.chat(.caption)).foregroundStyle(TetherColors.textSecondary).frame(minHeight: 44)
          .accessibilityIdentifier("sshNewChatUpdateLater_\(version.key)")
          if version.kind == .adapter || version.runnable {
            Button("Update") { update(version) }
              .font(.chat(.caption).weight(.semibold)).foregroundStyle(TetherColors.textPrimary).frame(minHeight: 44)
              .disabled(updating != nil)
              .accessibilityIdentifier("sshNewChatUpdate_\(version.key)")
          } else {
            Button("Copy") { UIPasteboard.general.string = version.command }
              .font(.chat(.caption).weight(.semibold)).foregroundStyle(TetherColors.textPrimary).frame(minHeight: 44)
              .accessibilityHint("Copies the command that updates it on the host")
          }
        }
      }
      if version.kind == .cli, !version.runnable {
        Text(version.command).font(.chat(.caption2).monospaced()).foregroundStyle(TetherColors.textFaint)
          .lineLimit(1).truncationMode(.middle)
      }
    }
  }

  private func update(_ version: ACPAgentVersion) {
    guard let onUpdateAgent, updating == nil else { return }
    updating = version.key
    Task {
      defer { updating = nil }
      let failure = await onUpdateAgent(version)
      versions = await loadVersions?() ?? versions
      let name = version.kind == .cli ? (ACPAgentVersion.cliNames[version.agent] ?? "The CLI") : "\(agent.label) adapter"
      updateMessage = failure ?? "\(name) updated to \(version.latest). New chats use it."
      if failure == nil { optionReads += 1 }
    }
  }

  /// Shows the cached list meanwhile; an answer for a folder or agent no longer picked is dropped.
  private func readLiveOptions() async {
    guard let liveOptions, folderInfo?.ready == true else { return }
    try? await Task.sleep(nanoseconds: 600_000_000)
    let wanted = (folder, agent)
    guard !Task.isCancelled, let options = await liveOptions(wanted.0, wanted.1) else { return }
    guard !Task.isCancelled, folder == wanted.0, agent == wanted.1 else { return }
    freshOptions[wanted.1.key] = options
  }

  private func pick(_ option: ChatAgentProfile) {
    guard option != agent else { return }
    if let reason = unavailable[option.key] {
      failure = reason
      return
    }
    agent = option
    updateMessage = nil
    changes = [:]
    reset = false
    failure = nil
    onAgentPicked(option)
  }

  // MARK: Options

  private var optionsBox: some View {
    VStack(spacing: 0) {
      Button { withAnimation(.easeInOut(duration: 0.18)) { optionsOpen.toggle() } } label: {
        HStack(spacing: 8) {
          Text("Options").font(.chat(.footnote)).foregroundStyle(TetherColors.textSecondary)
          if !optionsOpen {
            Text(optionsSummary).font(.chat(.caption))
              .foregroundStyle(summaryIsDefaults ? TetherColors.textFaint : TetherColors.textPrimary)
              .lineLimit(1).truncationMode(.tail)
          }
          Spacer(minLength: 4)
          Image(systemName: optionsOpen ? "chevron.down" : "chevron.right").font(.chat(.caption2).weight(.semibold))
            .foregroundStyle(TetherColors.textFaint)
        }
        .padding(.horizontal, 10).frame(minHeight: 44)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Options, \(optionsSummary)")
      .accessibilityHint(optionsOpen ? "Hides the choices" : "Shows the choices")
      .accessibilityIdentifier("sshNewChatOptions")
      if optionsOpen {
        if optionRows.isEmpty {
          Text(ChatNewOptions.note(agent: agent)).font(.chat(.caption)).foregroundStyle(TetherColors.textFaint)
            .fixedSize(horizontal: false, vertical: true)
            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .top) { Rectangle().fill(TetherColors.border).frame(height: 0.5) }
            .accessibilityIdentifier("sshNewChatOptionsNote")
        } else {
          ForEach(optionRows) { optionRow($0) }
          optionsFooter
        }
      }
    }
    .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TetherColors.border, lineWidth: 0.5))
    .clipShape(RoundedRectangle(cornerRadius: 10))
  }

  private var summaryIsDefaults: Bool { optionRows.isEmpty || (reset && changes.isEmpty) }

  private var optionsSummary: String {
    ChatNewOptions.summary(rows: optionRows, agent: agent, reset: reset && changes.isEmpty)
  }

  private func optionRow(_ row: ChatNewOptions.Row) -> some View {
    HStack(spacing: 8) {
      Text(row.name).font(.chat(.subheadline)).foregroundStyle(TetherColors.textSecondary).lineLimit(1)
      Spacer(minLength: 8)
      Menu {
        Picker(row.name, selection: Binding(get: { row.selected }, set: { set(row, $0) })) {
          ForEach(row.choices, id: \.value) { Text($0.name).tag($0.value) }
        }
      } label: {
        HStack(spacing: 5) {
          Text(row.selectedName).font(.chat(.footnote)).foregroundStyle(TetherColors.textPrimary).lineLimit(1)
          Image(systemName: "chevron.up.chevron.down").font(.system(size: 8, weight: .semibold))
            .foregroundStyle(TetherColors.textFaint)
        }
        .padding(.horizontal, 8).frame(minHeight: 44)
        .background(TetherColors.surfaceRaised, in: RoundedRectangle(cornerRadius: 7))
        .overlay(
          RoundedRectangle(cornerRadius: 7)
            .strokeBorder(row.changed ? TetherColors.textSecondary : TetherColors.border, lineWidth: 1))
      }
      .accessibilityLabel("\(row.name), \(row.selectedName)")
      .accessibilityIdentifier("sshNewChatOption_\(row.id)")
    }
    .padding(.horizontal, 10).frame(minHeight: 44)
    .overlay(alignment: .top) { Rectangle().fill(TetherColors.border).frame(height: 0.5) }
  }

  private func set(_ row: ChatNewOptions.Row, _ value: String) {
    let opened = ChatNewOptions.rows(agent: agent, stored: stored, cached: cached, reset: reset)
      .first { $0.id == row.id }?.selected
    if value == opened { changes[row.id] = nil } else { changes[row.id] = value }
  }

  @ViewBuilder private var optionsFooter: some View {
    let resetNow = reset && changes.isEmpty
    let label: String? =
      resetNow ? "Starts on \(agent.label)'s own defaults"
      : !stored.isEmpty && !reset ? "From your last \(agent.label) chat"
      : !changes.isEmpty ? "Changed for this chat" : nil
    if let label {
      HStack(spacing: 4) {
        Text(label).foregroundStyle(TetherColors.textFaint)
        if resetNow {
          if !stored.isEmpty {
            Text("·").foregroundStyle(TetherColors.textFaint)
            Button("Undo") { reset = false }.foregroundStyle(TetherColors.textPrimary).frame(minHeight: 44)
          }
        } else {
          Text("·").foregroundStyle(TetherColors.textFaint)
          Button("Reset") { changes = [:]; reset = true }.foregroundStyle(TetherColors.textPrimary)
            .frame(minHeight: 44).accessibilityIdentifier("sshNewChatOptionsReset")
        }
        Spacer(minLength: 0)
      }
      .font(.chat(.caption))
      .padding(.horizontal, 10).padding(.vertical, 8)
      .overlay(alignment: .top) { Rectangle().fill(TetherColors.border).frame(height: 0.5) }
    }
  }

  // MARK: Access

  private var accessSummary: String {
    let folders = extraFolders.count, picked = pickedServers.count
    if folders == 0 && picked == 0 { return "This folder only" }
    return [folders > 0 ? "\(folders) more folder\(folders == 1 ? "" : "s")" : nil,
      picked > 0 ? "\(picked) MCP server\(picked == 1 ? "" : "s")" : nil].compactMap { $0 }.joined(separator: " · ")
  }

  private var accessBox: some View {
    VStack(spacing: 0) {
      Button { withAnimation(.easeInOut(duration: 0.18)) { accessOpen.toggle() } } label: {
        HStack(spacing: 8) {
          Text("Access").font(.chat(.footnote)).foregroundStyle(TetherColors.textSecondary)
          if !accessOpen {
            Text(accessSummary).font(.chat(.caption))
              .foregroundStyle(extraFolders.isEmpty && pickedServers.isEmpty ? TetherColors.textFaint : TetherColors.textPrimary)
              .lineLimit(1).truncationMode(.tail)
          }
          Spacer(minLength: 4)
          Image(systemName: accessOpen ? "chevron.down" : "chevron.right").font(.chat(.caption2).weight(.semibold))
            .foregroundStyle(TetherColors.textFaint)
        }
        .padding(.horizontal, 10).frame(minHeight: 44)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Access, \(accessSummary)")
      .accessibilityIdentifier("sshNewChatAccess")
      if accessOpen {
        accessHeading("More folders")
        ForEach(extraFolders, id: \.self) { path in
          accessRow {
            Image(systemName: "folder").font(.chat(.caption)).foregroundStyle(TetherColors.textFaint)
            Text(path).font(.chat(.footnote).monospaced()).foregroundStyle(TetherColors.textPrimary)
              .lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 4)
            removeButton("Remove \(path)") { extraFolders.removeAll { $0 == path } }
          }
        }
        accessRow {
          TextField("~/src/other-project", text: $newFolder)
            .font(.chat(.footnote).monospaced())
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .onSubmit(addFolder)
            .accessibilityIdentifier("sshNewChatExtraFolder")
          Button("Add", action: addFolder).font(.chat(.footnote).weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
            .disabled(newFolder.trimmingCharacters(in: .whitespaces).isEmpty)
            .frame(minHeight: 44)
        }
        if mcpStore != nil {
          accessHeading("MCP servers")
          ForEach(servers) { server in
            accessRow {
              Toggle(isOn: Binding(
                get: { pickedServers.contains(server.name) },
                set: { if $0 { pickedServers.insert(server.name) } else { pickedServers.remove(server.name) } })
              ) {
                VStack(alignment: .leading, spacing: 1) {
                  Text(server.name).font(.chat(.footnote)).foregroundStyle(TetherColors.textPrimary)
                  Text(URL(string: server.url)?.host ?? server.url).font(.chat(.caption2)).foregroundStyle(TetherColors.textFaint)
                }
              }
              .toggleStyle(.switch).controlSize(.mini)
              .accessibilityIdentifier("sshNewChatMCP_\(server.name)")
              removeButton("Delete \(server.name)") { remove(server) }
            }
          }
          accessRow {
            Button { addingServer = true } label: {
              Label("Add MCP server", systemImage: "plus").font(.chat(.footnote))
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(TetherColors.textPrimary)
            .accessibilityIdentifier("sshNewChatAddMCP")
          }
        }
      }
    }
    .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TetherColors.border, lineWidth: 0.5))
    .clipShape(RoundedRectangle(cornerRadius: 10))
  }

  private func accessHeading(_ text: String) -> some View {
    Text(text).font(.chat(.caption2).weight(.semibold)).foregroundStyle(TetherColors.textFaint)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 10).padding(.top, 8).padding(.bottom, 2)
      .overlay(alignment: .top) { Rectangle().fill(TetherColors.border).frame(height: 0.5) }
      .accessibilityAddTraits(.isHeader)
  }

  private func accessRow<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    HStack(spacing: 8, content: content).padding(.horizontal, 10).frame(minHeight: 44)
  }

  private func removeButton(_ label: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: "minus.circle").font(.chat(.footnote)).foregroundStyle(TetherColors.textFaint)
        .frame(minWidth: 32, minHeight: 44).contentShape(Rectangle())
    }
    .buttonStyle(.plain).accessibilityLabel(label)
  }

  private func addFolder() {
    let path = newFolder.trimmingCharacters(in: .whitespaces)
    guard !path.isEmpty else { return }
    if !extraFolders.contains(path), path != folder { extraFolders.append(path) }
    newFolder = ""
  }

  private func remove(_ server: ChatMCPServer) {
    servers.removeAll { $0.name == server.name }
    pickedServers.remove(server.name)
    mcpStore?.servers = servers
  }

  private func delete(_ session: ACPSavedSession) {
    guard let onDeleteSession, !deletingNow else { return }
    deletingNow = true
    let wanted = folder
    Task {
      defer { deletingNow = false }
      if let message = await onDeleteSession(wanted, session, agent) {
        failure = message
      } else if case let .loaded(sessions) = listing {
        listing = .loaded(sessions.filter { $0.id != session.id })
      }
    }
  }

  private var sessionList: some View {
    VStack(alignment: .leading, spacing: 0) {
      switch listing {
      case .idle, .loading:
        HStack(spacing: 8) {
          ProgressView().controlSize(.small).tint(TetherColors.textFaint)
          Text("Looking for earlier conversations…").font(.chat(.subheadline)).foregroundStyle(TetherColors.textSecondary)
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .accessibilityIdentifier("sshContinueLoading")
      case let .failed(message):
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(message).font(.chat(.caption)).foregroundStyle(TetherColors.warning)
            .fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 0)
          Button("Retry") { reloads += 1 }
            .frame(minHeight: 44).font(.chat(.subheadline).weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
            .buttonStyle(TetherPressStyle())
            .accessibilityIdentifier("sshContinueRetry")
        }
        .padding(.vertical, 8)
        .accessibilityIdentifier("sshContinueError")
      case let .loaded(sessions) where sessions.isEmpty:
        Text("No earlier \(agent.label) conversations in this folder").font(.chat(.subheadline)).foregroundStyle(TetherColors.textSecondary)
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
          Text(session.displayTitle).font(.chat(.subheadline)).foregroundStyle(TetherColors.textPrimary).lineLimit(1)
          Spacer(minLength: 4)
          if continuing == session.id {
            ProgressView().controlSize(.small).tint(TetherColors.textFaint)
          } else {
            Text(ChatContinueFormat.relative(session.updatedAt, now: now)).font(.chat(.caption))
              .foregroundStyle(TetherColors.textFaint).fixedSize()
          }
        }
        if ChatContinueFormat.isRecent(session.updatedAt, now: now) {
          Text(ChatContinueFormat.recentNote).font(.chat(.caption2)).foregroundStyle(TetherColors.warning)
            .lineLimit(2).fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(.horizontal, 12).padding(.vertical, 8)
      .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(TetherPressStyle())
    .disabled(continuing != nil || deletingNow)
    .contextMenu {
      if onDeleteSession != nil {
        Button(role: .destructive) { deleting = session } label: { MenuLabel("Delete conversation", systemImage: "trash") }
      }
    }
    .accessibilityAction(named: "Delete conversation") { if onDeleteSession != nil { deleting = session } }
    .accessibilityLabel("\(session.displayTitle), \(ChatContinueFormat.relative(session.updatedAt, now: now))")
    .accessibilityIdentifier("sshContinueRow_\(session.id)")
  }

  private func reload() async {
    guard mode == .resume else { return }
    let wanted = folder
    let wantedAgent = agent
    listing = .loading
    try? await Task.sleep(nanoseconds: 500_000_000)
    guard !Task.isCancelled else { return }
    let result = await loadSessions(wanted, wantedAgent)
    guard !Task.isCancelled, wanted == folder, agent == wantedAgent else { return }
    switch result {
    case let .loaded(sessions):
      listing = .loaded(sessions)
      #if DEBUG
      if ProcessInfo.processInfo.environment["TETHER_DEBUG_CHAT_FIXTURE"] == "continue-delete" { deleting = sessions.first }
      #endif
    case let .failed(message): listing = .failed(message)
    }
  }

  private func submitFolder() {
    if mode == .new { start() } else { focused = false; reloads += 1 }
  }

  private func start() {
    guard !starting, !creatingFolder, !checkingFolder, folderInfo?.ready == true else { return }
    starting = true
    failure = nil
    focused = false
    Task {
      defer { starting = false }
      failure = await onStart(folder, request)
    }
  }

  private func resume(_ session: ACPSavedSession) {
    guard continuing == nil, !creatingFolder, !checkingFolder, folderInfo?.ready == true else { return }
    continuing = session.id
    failure = nil
    focused = false
    Task {
      defer { continuing = nil }
      failure = await onContinue(folder, session, request)
    }
  }
}

/// Adds one HTTP MCP server to the host's saved list.
struct ChatMCPServerForm: View {
  let existing: [ChatMCPServer]
  let onSave: (ChatMCPServer) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  @State private var url = "https://"
  @State private var headers = ""
  @State private var problem: String?

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Name", text: $name).autocorrectionDisabled().textInputAutocapitalization(.never)
            .accessibilityIdentifier("mcpServerName")
          TextField("URL", text: $url).keyboardType(.URL).autocorrectionDisabled().textInputAutocapitalization(.never)
            .accessibilityIdentifier("mcpServerURL")
        } footer: {
          Text("An HTTP MCP server the agent connects to from the host.")
        }
        Section {
          TextEditor(text: $headers).font(.chat(.footnote).monospaced()).frame(minHeight: 72)
            .autocorrectionDisabled().textInputAutocapitalization(.never)
            .accessibilityIdentifier("mcpServerHeaders")
        } header: {
          Text("Headers")
        } footer: {
          Text("One per line, like Authorization: Bearer <token>. Kept in this device's Keychain.")
        }
        if let problem { Text(problem).foregroundStyle(TetherColors.warning) }
      }
      .scrollContentBackground(.hidden).background(TetherColors.background)
      .navigationTitle("Add MCP server").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) { Button("Save", action: save).accessibilityIdentifier("mcpServerSave") }
      }
    }
    .tint(TetherColors.accent)
  }

  private func save() {
    guard let parsed = ChatMCPServer.headers(from: headers) else {
      problem = "Write each header as Name: value."
      return
    }
    let server = ChatMCPServer(
      name: name.trimmingCharacters(in: .whitespaces), url: url.trimmingCharacters(in: .whitespaces), headers: parsed)
    if let found = server.problem(among: existing) {
      problem = found
      return
    }
    onSave(server)
    dismiss()
  }
}
