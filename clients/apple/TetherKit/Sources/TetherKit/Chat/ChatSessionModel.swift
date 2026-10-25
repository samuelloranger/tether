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
  /// The output of `tether-notify acp answers <name>`, or nil when the host can't say.
  typealias HostAnswers = @Sendable () async -> String?

  let chatName: String
  let cwd: String
  let readOnly: Bool

  private(set) var state = ChatState()
  private(set) var link = ChatLinkTracker()
  private(set) var outbox = ChatOutbox()
  /// Permission cards whose last answer did not reach the agent; they stay answerable.
  private(set) var answerFailures: Set<ACPID> = []
  var notice: String?
  /// Option changes in flight or refused, by option id; the shown value only changes once the agent confirms.
  private(set) var optionChanges: [String: OptionChange] = [:]

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
  private let inspect: Inspect?
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

  init(
    chatName: String, cwd: String, readOnly: Bool, store: any ChatJournalStore, titleStore: ChatTitleStore? = nil,
    hostAnswers: HostAnswers? = nil, snapshots: (any ChatSnapshotStore)? = nil, inspect: Inspect? = nil,
    dial: @escaping Dial
  ) {
    self.snapshots = snapshots
    self.inspect = inspect
    self.titleStore = titleStore
    self.hostAnswers = hostAnswers
    self.chatName = chatName
    self.cwd = cwd
    self.readOnly = readOnly
    self.store = store
    self.dial = dial
  }

  static func live(route: ChatRoute, config: SSHConnectionConfig, hostKeyStore: HostKeyStore) -> ChatSessionModel {
    let store: any ChatJournalStore =
      route.readOnly ? InMemoryChatJournalStore() : UserDefaultsChatJournalStore(name: route.name)
    let files = ChatLocalFiles(scope: ChatTitleStore.scope(for: config))
    return ChatSessionModel(chatName: route.name, cwd: route.cwd, readOnly: route.readOnly, store: store,
      titleStore: ChatTitleStore(config: config),
      hostAnswers: { await ACPHostAnswers.read(name: route.name, config: config, store: hostKeyStore) },
      snapshots: files.snapshots(route.name),
      inspect: { await ACPHostInspect.summary(name: route.name, config: config, store: hostKeyStore) }
    ) { spawn, from in
      try await SSHConnector.connectExec(
        config: config, store: hostKeyStore,
        command: ACPHostCommand.attach(name: route.name, cwd: route.cwd, spawn: spawn, from: from))
    }
  }

  var title: String { state.title ?? ChatFormat.folderName(cwd) }

  /// Send, Stop and Approve wait for the replay: until then the transcript may still be partial
  /// and a pending permission may already have been answered.
  var canInteract: Bool { link.allowsInteraction && !readOnly }
  var canSend: Bool { canInteract && state.turn == .idle }

  func connect() async {
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
    let spawn = !readOnly && journal.sessionId == nil
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
    let fresh = ACPClient(stream: stream, store: store, resume: resume, snapshots: snapshots)
    if resume == nil, snapshots != nil { learnIdentity(of: fresh, from: inspectRead, retry: spawn) }
    if let answersOutput { await fresh.adoptHostAnswers(ACPAnswerCommand.parseAnswers(answersOutput)) }
    client = fresh
    link.dialSucceeded(at: .now)
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
      if readOnly { await fresh.startReading() } else { try await fresh.start(cwd: cwd) }
    } catch {
      guard mine == generation else { return }
      fail(error)
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
    outbox.discard(id)
    Task { await deliver(entry.text, entry.images) }
  }

  func setOption(id: String, value: String) {
    guard canInteract, let client else { return }
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
        optionChanges[id] = nil
        receive(await client.state, generation: mine)
      } catch {
        optionChanges[id] = .failed(value: value, message: Self.describe(error))
      }
    }
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

  func discard(_ id: UUID) { outbox.discard(id) }

  func cancel() {
    guard canInteract, let client else { return }
    Task {
      do {
        try await client.cancel()
      } catch {
        notice = "Stop didn't reach the agent. Try again."
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

  private func adoptHostAnswer(for requestId: ACPID, on client: ACPClient) async -> Bool {
    guard let output = await hostAnswers?() else { return false }
    let answers = ACPAnswerCommand.parseAnswers(output)
    guard answers[requestId] != nil else { return false }
    await client.adoptHostAnswers(answers)
    receive(await client.state, generation: generation)
    return true
  }

  private func deliver(_ text: String, _ images: [ChatImageAttachment]) async {
    guard let client else {
      outbox.recordFailure(text, images: images)
      return
    }
    do {
      try await client.prompt(text: text, images: images)
    } catch {
      outbox.recordFailure(text, images: images)
    }
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
    case .ended, .lost:
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
  }

  private func fail(_ error: Error) {
    link.dialFailed()
    flushHeld()
    notice = "Couldn't reach the host: \(error.localizedDescription)"
  }

  private func detachClient() {
    forwardTask?.cancel()
    settleTask?.cancel()
    forwardTask = nil
    settleTask = nil
    let old = client
    client = nil
    if let old { stopping = Task { await old.stop() } }
  }
}
