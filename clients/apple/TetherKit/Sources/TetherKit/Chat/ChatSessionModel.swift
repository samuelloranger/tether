import Foundation
import Observation

/// One chat: the exec channel, the `ACPClient` on it, and what the screen needs from both.
@MainActor
@Observable
final class ChatSessionModel {
  typealias Dial = (_ spawn: Bool) async throws -> any TerminalByteStream

  let chatName: String
  let cwd: String
  let readOnly: Bool

  private(set) var state = ChatState()
  private(set) var link = ChatLinkTracker()
  private(set) var outbox = ChatOutbox()
  var notice: String?

  /// UI updates stop at about 30 fps; the client already coalesces, so the newest state wins.
  static let frameInterval: Duration = .milliseconds(33)

  private let store: any ChatJournalStore
  private let dial: Dial
  private var client: ACPClient?
  private var forwardTask: Task<Void, Never>?
  private var settleTask: Task<Void, Never>?
  private var dialInFlight = false
  private var generation = 0
  private var left = false
  /// While a reconnect replays, the old transcript stays on screen and the rebuilt one waits here.
  private var held: ChatState?
  private var holdingForReplay = false

  init(chatName: String, cwd: String, readOnly: Bool, store: any ChatJournalStore, dial: @escaping Dial) {
    self.chatName = chatName
    self.cwd = cwd
    self.readOnly = readOnly
    self.store = store
    self.dial = dial
  }

  static func live(route: ChatRoute, config: SSHConnectionConfig, hostKeyStore: HostKeyStore) -> ChatSessionModel {
    let store: any ChatJournalStore =
      route.readOnly ? InMemoryChatJournalStore() : UserDefaultsChatJournalStore(name: route.name)
    return ChatSessionModel(chatName: route.name, cwd: route.cwd, readOnly: route.readOnly, store: store) { spawn in
      try await SSHConnector.connectExec(
        config: config, store: hostKeyStore,
        command: ACPHostCommand.attach(name: route.name, cwd: route.cwd, spawn: spawn))
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
    link.dialStarted()
    notice = nil
    holdingForReplay = !state.items.isEmpty
    held = nil
    let spawn = !readOnly && store.load().sessionId == nil
    let stream: any TerminalByteStream
    do {
      stream = try await dial(spawn)
    } catch {
      guard mine == generation else { return }
      dialInFlight = false
      fail(error)
      return
    }
    dialInFlight = false
    guard mine == generation, !left else {
      await stream.close()
      return
    }
    let fresh = ACPClient(stream: stream, store: store)
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
  func send(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, canSend else { return false }
    Task { await deliver(trimmed) }
    return true
  }

  func retry(_ id: UUID) {
    guard canSend, let text = outbox.text(for: id) else { return }
    outbox.discard(id)
    Task { await deliver(text) }
  }

  func discard(_ id: UUID) { outbox.discard(id) }

  func cancel() {
    guard canInteract, let client else { return }
    Task { try? await client.cancel() }
  }

  func approve(_ permission: ChatPermission, option: ACPPermissionOption) {
    guard canInteract, let client else { return }
    Task {
      do {
        try await client.answerPermission(requestId: permission.requestId, optionId: option.optionId)
      } catch {
        notice = "The answer didn't reach the agent. Reconnect to see if it is still waiting."
      }
    }
  }

  private func deliver(_ text: String) async {
    guard let client else {
      outbox.recordFailure(text)
      return
    }
    do {
      try await client.prompt(text: text)
    } catch {
      outbox.recordFailure(text)
    }
  }

  private func receive(_ next: ChatState, generation mine: Int) {
    guard mine == generation else { return }
    link.activity(at: .now)
    if next.connection == .lost {
      link.connectionLost()
      held = nil
      state = next
      return
    }
    if holdingForReplay && link.phase == .catchingUp {
      held = next
    } else {
      state = next
    }
    scheduleSettle()
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
    if let old { Task { await old.stop() } }
  }
}
