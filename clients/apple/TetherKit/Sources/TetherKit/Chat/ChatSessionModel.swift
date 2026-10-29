import Foundation
import Observation

/// One chat: the exec channel, the `ACPClient` on it, and what the screen needs from both.
@MainActor
@Observable
final class ChatSessionModel {
  /// `from` is the log offset to attach at; a snapshot resume passes its own, anything else 0.
  typealias Dial = (_ spawn: Bool, _ from: Int) async throws -> any TerminalByteStream
  /// The host's `acp ls` row for this chat, or nil when it can't say.
  typealias Inspect = @Sendable () async -> ACPChatSummary?
  /// The output of `tether acp answers <name>`, or nil when the host can't say.
  typealias HostAnswers = @Sendable () async -> String?
  /// The output of the file listing in the chat's folder, or nil when the host can't say.
  typealias ListFiles = @Sendable () async -> String?
  /// The words a running turn may show (see `ChatVerbs`).
  typealias SpinnerVerbs = @Sendable () async -> [String]
  /// The output of `tether acp workflows` for a session id, or nil when the host can't say.
  typealias Workflows = @Sendable (_ sessionId: String) async -> String?

  let chatName: String
  let cwd: String
  let readOnly: Bool
  /// Another client started the chat on a holder that takes several: no spawn and no handshake.
  let join: Bool
  /// The earlier conversation this chat loads instead of starting a session.
  let loadSessionId: String?
  /// What the host is called in messages about it; the connection's host name.
  let hostLabel: String
  /// The agent the chat runs; nil for one this app does not know (no defaults, no Claude words).
  let agent: ChatAgentProfile?
  /// The New chat sheet's option picks for this chat: nil applies the stored defaults, `[:]` nothing.
  private let optionPicks: [String: String]?
  private let changedPicks: Set<String>

  private(set) var state = ChatState()
  private(set) var link = ChatLinkTracker()
  private(set) var outbox = ChatOutbox()
  /// Permission cards whose last answer did not reach the agent; they stay answerable.
  private(set) var answerFailures: Set<ACPID> = []
  var notice: String?
  /// Option changes in flight or refused, by option id; the shown value only changes once the agent confirms.
  private(set) var optionChanges: [String: OptionChange] = [:]
  /// The folder's files for `@` mentions; loaded when the palette first opens.
  private(set) var fileIndex = ChatFileIndex()
  private var loadingFiles = false
  /// The Workflow runs the host reports; empty until a poll answers, and never persisted.
  private(set) var workflowTracker = ChatWorkflowTracker()

  enum SignInRetry: Equatable { case idle, checking, stillSignedOut }

  private(set) var signInRetry: SignInRetry = .idle

  enum OptionChange: Equatable {
    case pending(value: String)
    case failed(value: String, message: String)
  }

  /// UI updates stop at about 30 fps; the client already coalesces, so the newest state wins.
  static let frameInterval: Duration = .milliseconds(33)

  private let store: any ChatJournalStore
  private let titleStore: ChatTitleStore?
  private let dial: Dial
  private let hostAnswers: HostAnswers?
  private let snapshots: (any ChatSnapshotStore)?
  private let outboxStore: (any ChatOutboxStore)?
  private let inspect: Inspect?
  private let listFiles: ListFiles?
  private let spinnerVerbs: SpinnerVerbs?
  private let workflows: Workflows?
  private let workflowInterval: Duration
  private var workflowTask: Task<Void, Never>?
  private var verbsAsked = false
  /// Empty until the host answered; Tether's own words stand in meanwhile.
  private(set) var verbs: [String] = []
  /// The chat's picture files and how to show them; nil where nothing is kept.
  let imageLibrary: ChatImageLibrary?
  private var client: ACPClient?
  private var forwardTask: Task<Void, Never>?
  private var settleTask: Task<Void, Never>?
  private var dialInFlight = false
  private var generation = 0
  private var left = false
  /// While a reconnect replays, the old transcript stays on screen and the rebuilt one waits here.
  private var held: ChatState?
  private var holdingForReplay = false
  private var attempt: ChatResume.Attempt?
  private var skipSnapshot = false
  private var stopping: Task<Void, Never>?
  private let optionDefaults: ChatOptionDefaultsStore?
  private let optionsCache: ChatOptionsCache?
  private var lastCachedOptions: [ACPConfigOption] = []
  private var userTouchedOptions = Set<String>()

  init(
    chatName: String, cwd: String, readOnly: Bool, join: Bool = false, store: any ChatJournalStore,
    titleStore: ChatTitleStore? = nil,
    hostAnswers: HostAnswers? = nil, snapshots: (any ChatSnapshotStore)? = nil, inspect: Inspect? = nil,
    outbox outboxStore: (any ChatOutboxStore)? = nil, hostLabel: String = "the host", loadSessionId: String? = nil,
    listFiles: ListFiles? = nil, spinnerVerbs: SpinnerVerbs? = nil, workflows: Workflows? = nil, workflowInterval: Duration = ChatWorkflowTracker.pollInterval, images: ChatImageStore? = nil,
    optionDefaults: ChatOptionDefaultsStore? = nil, agent: ChatAgentProfile? = ChatAgents.claude,
    optionPicks: [String: String]? = nil, changedPicks: Set<String> = [], optionsCache: ChatOptionsCache? = nil, dial: @escaping Dial
  ) {
    self.agent = agent
    self.optionPicks = optionPicks
    self.changedPicks = changedPicks
    self.optionsCache = optionsCache
    self.optionDefaults = optionDefaults
    self.imageLibrary = images.map(ChatImageLibrary.init)
    self.loadSessionId = loadSessionId
    self.listFiles = listFiles
    self.spinnerVerbs = spinnerVerbs
    self.workflows = workflows
    self.workflowInterval = workflowInterval
    self.hostLabel = hostLabel
    self.outboxStore = outboxStore
    self.outbox = ChatOutbox(restoring: outboxStore?.load() ?? [])
    self.snapshots = snapshots
    self.inspect = inspect
    self.titleStore = titleStore
    self.hostAnswers = hostAnswers
    self.chatName = chatName
    self.cwd = cwd
    self.readOnly = readOnly
    self.join = join
    self.store = store
    self.dial = dial
  }

  static func live(route: ChatRoute, config: SSHConnectionConfig, hostKeyStore: HostKeyStore) -> ChatSessionModel {
    let store: any ChatJournalStore =
      route.readOnly ? InMemoryChatJournalStore() : UserDefaultsChatJournalStore(name: route.name)
    let files = ChatLocalFiles(scope: ChatTitleStore.scope(for: config))
    let titleStore = ChatTitleStore(config: config)
    let agent = ChatAgents.profile(forKey: route.agentKey)
    if let recorded = route.agentToRecord { titleStore.setAgent(recorded.key, for: route.name) }
    var clientId: String?
    if route.multiClient, !route.readOnly {
      var journal = store.load()
      if journal.clientId == nil {
        journal.clientId = ChatRoute.newClientId()
        store.save(journal)
      }
      clientId = journal.clientId
    }
    return ChatSessionModel(
      chatName: route.name, cwd: route.cwd, readOnly: route.readOnly, join: route.join, store: store,
      titleStore: titleStore,
      hostAnswers: { await ACPHostAnswers.read(name: route.name, config: config, store: hostKeyStore) },
      snapshots: files.snapshots(route.name),
      inspect: { await ACPHostInspect.summary(name: route.name, config: config, store: hostKeyStore) },
      outbox: files.outbox(route.name), hostLabel: config.host, loadSessionId: route.loadSessionId,
      listFiles: {
        await ACPHostExec.run(
          command: ChatFileList.command(cwd: route.cwd), config: config, store: hostKeyStore, deadline: 15)
      },
      spinnerVerbs: { await ChatVerbCache.shared.verbs(config: config, store: hostKeyStore) },
      workflows: { id in
        await ACPHostExec.run(command: ChatWorkflowListing.command(sessionId: id), config: config, store: hostKeyStore)
      },
      images: files.images(route.name), optionDefaults: ChatOptionDefaultsStore(), agent: agent,
      optionPicks: route.optionPicks, changedPicks: route.changedPicks, optionsCache: ChatOptionsCache(config: config)
    ) { spawn, from in
      try await SSHConnector.connectExec(
        config: config, store: hostKeyStore,
        command: ACPHostCommand.attach(name: route.name, cwd: route.cwd, spawn: spawn, from: from, client: clientId,
          spawnCommand: agent?.spawn ?? ACPHostCommand.spawnCommand))
    }
  }

  var title: String { state.title ?? ChatFormat.folderName(cwd) }

  /// Send, Stop and Approve wait for the replay: until then the transcript may still be partial
  /// and a pending permission may already have been answered.
  var canInteract: Bool { link.allowsInteraction && !readOnly }
  /// A message can be sent at any time a turn is running too: the agent queues it.
  var canSend: Bool { canInteract && !needsSignIn }
  /// The agent refused to start for want of a login on the host, so there is no session to talk to yet.
  var needsSignIn: Bool {
    guard state.sessionId == nil, case .signedOut? = state.items.last?.kind else { return false }
    return true
  }
  var isWorking: Bool { state.turn == .working }
  /// The agent is gone for good: the transcript stays readable, nothing can be sent and nothing redials.
  var hasEnded: Bool { link.phase == .ended }

  func connect() async {
    if !verbsAsked, let spinnerVerbs, agent?.usesClaudeVerbs == true {
      verbsAsked = true
      Task { verbs = await spinnerVerbs() }
    }
    guard !dialInFlight, !left, client == nil || link.phase == .lost else { return }
    dialInFlight = true
    generation += 1
    let mine = generation
    detachClient()
    await stopping?.value
    link.dialStarted()
    notice = nil
    held = nil
    let journal = store.load()
    let spawn = !readOnly && !join && journal.sessionId == nil
    // Asked alongside the dial; the replay can't start before the answers are in the journal.
    let answersRead = Task { await self.hostAnswers?() }
    let inspectRead = Task { await self.inspect?() }
    let candidate = skipSnapshot || spawn ? nil : snapshots?.load()
    skipSnapshot = false
    var resume: ChatSnapshot?
    if let candidate {
      let summary = await inspectRead.value
      resume = ChatResume.usable(candidate, journal: journal, summary: summary)
      if resume == nil, summary != nil { snapshots?.clear() }
    }
    guard mine == generation, !left else {
      answersRead.cancel()
      inspectRead.cancel()
      dialInFlight = false
      return
    }
    attempt = resume.map { .init(offset: $0.offset, identity: $0.identity) }
    holdingForReplay = !state.items.isEmpty && resume == nil
    let stream: any TerminalByteStream
    do {
      stream = try await dial(spawn, resume?.offset ?? 0)
    } catch {
      inspectRead.cancel()
      answersRead.cancel()
      guard mine == generation else { return }
      dialInFlight = false
      fail(error)
      return
    }
    let answersOutput = await answersRead.value
    dialInFlight = false
    guard mine == generation, !left else {
      await stream.close()
      return
    }
    let fresh = ACPClient(
      stream: stream, store: store, resume: resume, snapshots: snapshots, images: imageLibrary?.store)
    if resume == nil, snapshots != nil { learnIdentity(of: fresh, from: inspectRead, retry: spawn) }
    if let answersOutput { await fresh.adoptHostAnswers(ACPAnswerCommand.parseAnswers(answersOutput)) }
    client = fresh
    link.dialSucceeded(at: .now)
    startWorkflowPolling(generation: mine)
    let updates = await fresh.updates()
    forwardTask = Task { [weak self] in
      for await next in updates {
        guard let self, !Task.isCancelled else { return }
        self.receive(next, generation: mine)
        try? await Task.sleep(for: Self.frameInterval)
      }
    }
    scheduleSettle()
    do {
      if readOnly {
        await fresh.startReading()
      } else if join {
        await fresh.startJoining()
      } else {
        if try await fresh.start(cwd: cwd, loadSessionId: loadSessionId) { await applyStoredDefaults(fresh, generation: mine) }
      }
    } catch {
      guard mine == generation else { return }
      if case let .agent(_, message)? = error as? ACPClientError, loadSessionId != nil, !ChatAuthError.matches(error) {
        notice = "Couldn't load that conversation" + (message.isEmpty ? "." : ": \(message)")
        return
      }
      // The transcript already carries the sign-in row; the link itself is fine.
      if !ChatAuthError.matches(error) { fail(error, started: true) }
    }
  }

  /// After signing in on the host: asks the agent for a session again on the same connection.
  func retrySignIn() {
    guard canInteract, needsSignIn, signInRetry != .checking, let client else { return }
    signInRetry = .checking
    let mine = generation
    Task {
      do {
        let created = try await client.start(cwd: cwd, loadSessionId: loadSessionId)
        guard mine == generation else { return }
        if created { await applyStoredDefaults(client, generation: mine) }
        signInRetry = .idle
      } catch {
        guard mine == generation else { return }
        if ChatAuthError.matches(error) {
          signInRetry = .stillSignedOut
        } else {
          signInRetry = .idle
          notice = "Couldn't reach the agent: \(Self.describe(error))"
        }
      }
    }
  }

  /// The log's identity comes from `acp ls`; a chat the dial just spawned may not be listed yet.
  private func learnIdentity(of client: ACPClient, from first: Task<ACPChatSummary?, Never>, retry: Bool) {
    guard let inspect else { return }
    Task {
      var summary = await first.value
      var tries = retry ? 3 : 0
      while summary == nil, tries > 0 {
        try? await Task.sleep(for: .seconds(1.5))
        summary = await inspect()
        tries -= 1
      }
      if let summary { await client.setSnapshotIdentity(ChatResume.identity(of: summary)) }
    }
  }

  func sceneBecameActive() {
    guard ChatReconnectPolicy.shouldReconnect(phase: link.phase, dialInFlight: dialInFlight, left: left) else { return }
    Task { await connect() }
  }

  /// The socket would be reaped while suspended; dropping it now makes the return a clean redial.
  func sceneEnteredBackground() {
    guard !left, client != nil else { return }
    generation += 1
    detachClient()
    flushHeld()
    link.connectionLost()
  }

  func reconnect() {
    sceneBecameActive()
  }

  func leave() {
    left = true
    generation += 1
    detachClient()
  }

  @discardableResult
  func send(_ text: String) -> Bool { send(text: text, images: []) }

  @discardableResult
  func send(text: String, images: [ChatImageAttachment] = []) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty || !images.isEmpty, canSend else { return false }
    Task { await deliver(trimmed, images) }
    return true
  }

  func retry(_ id: UUID) {
    guard canSend, let entry = outbox.entry(for: id) else { return }
    guard entry.canRetry else { return }
    outbox.discard(id)
    Task { await deliver(entry.text, entry.images, imagesLost: entry.imagesLost) }
  }

  /// One after the other, each picked from the options as the last answer left them; a refusal is
  /// dropped quietly and keeps the stored value. An option the user touched is left alone. The New
  /// chat sheet's picks stand in for the stored defaults, and what the agent confirms is stored.
  private func applyStoredDefaults(_ client: ACPClient, generation mine: Int) async {
    guard let optionDefaults, let agent else { return }
    let stored = optionPicks ?? optionDefaults.stored(agent: agent.key)
    var tried = Set<String>()
    while mine == generation,
      let call = ChatOptionDefaults.next(
        stored: stored, offered: await client.state.configOptions, skipping: tried.union(userTouchedOptions),
        remembered: agent.rememberedIds)
    {
      tried.insert(call.id)
      do {
        try await client.setConfigOption(id: call.id, value: call.value)
        if changedPicks.contains(call.id) {
          optionDefaults.remember(agent: agent.key, id: call.id, value: call.value)
        }
      } catch {}
    }
    for id in ChatOptionDefaults.alreadySet(picks: stored, changed: changedPicks, offered: await client.state.configOptions)
    where !userTouchedOptions.contains(id) {
      if let value = stored[id] { optionDefaults.remember(agent: agent.key, id: id, value: value) }
    }
    if !tried.isEmpty, mine == generation { receive(await client.state, generation: mine) }
  }

  func setOption(id: String, value: String) {
    guard canInteract, let client else { return }
    userTouchedOptions.insert(id)
    if case .pending = optionChanges[id] { return }
    guard state.option(id: id)?.currentValue != value else {
      optionChanges[id] = nil
      return
    }
    optionChanges[id] = .pending(value: value)
    let mine = generation
    Task {
      do {
        try await client.setConfigOption(id: id, value: value)
        if let agent { optionDefaults?.remember(agent: agent.key, id: id, value: value) }
        optionChanges[id] = nil
        receive(await client.state, generation: mine)
      } catch {
        optionChanges[id] = .failed(value: value, message: Self.describe(error))
      }
    }
  }

  /// Called when the `@` palette opens: lists the folder again when the cached list is over a minute old.
  /// A failed listing keeps what was there and is retried the next time the palette opens.
  func loadMentionFiles(now: Date = .now) async {
    guard let listFiles, !loadingFiles, fileIndex.isStale(at: now) else { return }
    loadingFiles = true
    defer { loadingFiles = false }
    guard let output = await listFiles() else { return }
    fileIndex.store(ChatFileList.parse(output), at: .now)
  }

  func dismissOptionFailure(id: String) {
    if case .failed = optionChanges[id] { optionChanges[id] = nil }
  }

  private static func describe(_ error: Error) -> String {
    switch error as? ACPClientError {
    case let .agent(_, message)? where !message.isEmpty: return message
    case .agent?: return "The agent refused the change."
    default: return "The change didn't reach the agent."
    }
  }

  func discard(_ id: UUID) {
    outbox.discard(id)
    persistOutbox()
  }

  private func persistOutbox() { outboxStore?.save(outbox.persisted) }

  /// Stop drops what was waiting; as in Claude Code, it goes out next instead.
  func cancel() {
    guard canInteract, let client else { return }
    Task {
      let waiting: (text: String, images: Int)
      do {
        waiting = try await client.cancel()
      } catch {
        notice = "Stop didn't reach the agent. Try again."
        return
      }
      // Not through `send`: the composer's gate is for what the user types, and this was sent already.
      if !waiting.text.isEmpty { await deliver(waiting.text, []) }
      if waiting.images > 0 {
        notice = "The waiting messages went out again without their \(ChatComposerRule.imageLabel(waiting.images))."
      }
    }
  }

  func approve(_ permission: ChatPermission, option: ACPPermissionOption) {
    guard canInteract, let client else { return }
    answerFailures.remove(permission.requestId)
    Task {
      do {
        try await client.answerPermission(requestId: permission.requestId, optionId: option.optionId)
      } catch {
        // The host may have taken an answer from the lock screen first: then the card is
        // simply resolved, and there is nothing to report.
        if await adoptHostAnswer(for: permission.requestId, on: client) { return }
        answerFailures.insert(permission.requestId)
        receive(await client.state, generation: generation)
      }
    }
  }

  /// Answers, declines or cancels a pending question; on a failed write the card stays answerable.
  func answerQuestion(
    _ question: ChatQuestion, action: ChatQuestionAction, content: [String: ChatQuestionValue] = [:]
  ) {
    guard canInteract, let client else { return }
    answerFailures.remove(question.requestId)
    Task {
      do {
        try await client.answerQuestion(requestId: question.requestId, action: action, content: content)
      } catch {
        if await adoptHostAnswer(for: question.requestId, on: client) { return }
        answerFailures.insert(question.requestId)
        receive(await client.state, generation: generation)
      }
    }
  }

  private func adoptHostAnswer(for requestId: ACPID, on client: ACPClient) async -> Bool {
    guard let output = await hostAnswers?() else { return false }
    let answers = ACPAnswerCommand.parseAnswers(output)
    guard answers[requestId] != nil else { return false }
    await client.adoptHostAnswers(answers)
    receive(await client.state, generation: generation)
    return true
  }

  /// A retry takes the entry out of memory first but the stored copy only changes with the
  /// outcome, so a message is never lost between the tap and the answer.
  private func deliver(_ text: String, _ images: [ChatImageAttachment], imagesLost: Int = 0) async {
    guard let client else {
      outbox.recordFailure(text, images: images, imagesLost: imagesLost)
      persistOutbox()
      return
    }
    do {
      try await client.prompt(text: text, images: images)
    } catch {
      outbox.recordFailure(text, images: images, imagesLost: imagesLost)
    }
    persistOutbox()
  }

  private func receive(_ next: ChatState, generation mine: Int) {
    guard mine == generation else { return }
    link.activity(at: .now)
    if next.connection == .lost {
      let first = link.phase != .lost
      link.connectionLost()
      held = nil
      state = next
      persistTitle()
      if first { Task { await resolveLoss(generation: mine) } }
      return
    }
    if holdingForReplay && link.phase == .catchingUp {
      held = next
    } else {
      state = next
      persistTitle()
    }
    scheduleSettle()
  }

  /// A stream that ends is either a dropped connection, a resume the host could not serve, or a
  /// chat that has ended: only the host's own listing tells them apart.
  private func resolveLoss(generation mine: Int) async {
    guard let lost = client, !left else { return }
    let received = await lost.receivedBytes
    let failed = await lost.failedDecoding
    let summary = await inspect?()
    guard mine == generation, !left else { return }
    switch ChatResume.afterLoss(attempt: attempt, receivedBytes: received, failedDecoding: failed, summary: summary) {
    case .replayFromZero:
      snapshots?.clear()
      skipSnapshot = true
      await connect()
    case .ended:
      link.ended()
    case .lost:
      break
    }
  }

  private func scheduleSettle() {
    settleTask?.cancel()
    guard link.phase == .catchingUp else { return }
    settleTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(ChatLinkTracker.settleWindow))
      guard !Task.isCancelled, let self else { return }
      if self.link.settleIfQuiet(at: .now) {
        self.holdingForReplay = false
        self.flushHeld()
      } else {
        self.scheduleSettle()
      }
    }
  }

  private func flushHeld() {
    holdingForReplay = false
    if let held { state = held }
    held = nil
    persistTitle()
  }

  private func persistTitle() {
    if let title = state.title { titleStore?.set(title, for: chatName) }
    persistOptions()
  }

  /// The choices the New chat sheet offers come from the agent's latest session.
  private func persistOptions() {
    guard let agent, let optionsCache, !state.configOptions.isEmpty, state.configOptions != lastCachedOptions else { return }
    lastCachedOptions = state.configOptions
    optionsCache.save(state.configOptions, agent: agent)
  }

  private func fail(_ error: Error, started: Bool = false) {
    link.dialFailed()
    flushHeld()
    notice = ACPClientError.hostFailureText(error, started: started)
  }

  private var workflowCalls: [ChatToolCall] {
    state.items.compactMap {
      if case let .tool(call) = $0.kind, call.isWorkflow == true { return call }
      return nil
    }
  }

  /// The transcript with each Workflow row as the host reports it (see `ChatWorkflowTracker`).
  var displayItems: [ChatItem] { hasEnded ? state.items : workflowTracker.display(state.items) }

  /// Running workflows for the strip; a chat that has ended shows none.
  var runningWorkflows: [ChatWorkflowRun] { hasEnded ? [] : workflowTracker.running }

  /// Asks the host every few seconds while a Workflow call is not known to be over. A host that
  /// answers like one without the command is left alone, and the rows keep what ACP said.
  private func startWorkflowPolling(generation mine: Int) {
    workflowTask?.cancel()
    guard let workflows else { return }
    workflowTask = Task { [weak self] in
      while !Task.isCancelled {
        guard let self, mine == self.generation else { return }
        if let id = self.state.sessionId, !self.hasEnded, self.workflowTracker.needsPolling(calls: self.workflowCalls) {
          let output = await workflows(id)
          guard !Task.isCancelled, mine == self.generation else { return }
          self.workflowTracker.apply(output: output, calls: self.workflowCalls)
        }
        try? await Task.sleep(for: self.workflowInterval)
      }
    }
  }

  private func detachClient() {
    workflowTask?.cancel()
    workflowTask = nil
    forwardTask?.cancel()
    settleTask?.cancel()
    forwardTask = nil
    settleTask = nil
    let old = client
    client = nil
    if let old { stopping = Task { await old.stop() } }
  }
}
