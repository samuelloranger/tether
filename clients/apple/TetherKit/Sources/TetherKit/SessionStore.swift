import Foundation
import Observation
import TetherFFIBindings

@Observable
@MainActor
public final class SessionStore {
  public private(set) var hosts: [HostProfileModel] = []
  public private(set) var sessions: [RemoteSession] = []
  /// Sessions keyed by host id — populated by `refreshDrawer()` for the slide-over.
  public private(set) var sessionsByHost: [String: [RemoteSession]] = [:]
  public private(set) var healthByHost: [String: HostHealthModel] = [:]
  public var activeHostId: String?
  public var activeSessionId: String?
  public var terminalSnapshot: Data?
  public var errorMessage: String?
  public var isLoading = false
  public var isPairing = false
  public var pairingNeedsSetup = false

  private let hostStore: HostStoreAdapter
  private let replayStore: FfiReplayStore
  /// `lazy` + `@ObservationIgnored`: the coordinator's closures capture `self`,
  /// which cannot happen inside `init` before every stored property is
  /// initialized. Building it on first use sidesteps that. It is internal
  /// plumbing rather than view state, so Observation should not track it.
  @ObservationIgnored private lazy var deepLinks: DeepLinkCoordinator = .init(
    profilesProvider: { [weak self] in self?.hosts ?? [] },
    onSession: { [weak self] hostId, sessionId in
      Task { @MainActor in
        self?.activeHostId = hostId
        self?.activeSessionId = sessionId
      }
    }
  )
  private var pollTask: Task<Void, Never>?
  private var socketTask: Task<Void, Never>?
  private var socket: URLSessionWebSocketTask?
  private var lastRenderedGeneration: UInt64?
  /// The core's VT parser for the active session. Output bytes are fed in and
  /// packed TGRD grids come back out; this is what turns a byte stream into
  /// something the CoreText surface can draw.
  @ObservationIgnored private var emulator: FfiTerminalEmulator?
  /// One source of truth for the grid size: the socket, the parser and any
  /// later resize must agree or the rendered grid will not match the PTY.
  private let terminalCols: UInt16 = 120
  private let terminalRows: UInt16 = 40

  public init(hostStore: HostStoreAdapter = HostStoreAdapter()) {
    self.hostStore = hostStore
    replayStore = FfiReplayStore()
  }

  public func bootstrap() async {
    do {
      hosts = try hostStore.list()
      for host in hosts {
        healthByHost[host.id] = .unknown
      }
      if activeHostId == nil {
        activeHostId = hosts.first?.id
      }
      startPolling()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  public func reloadHosts() {
    do {
      hosts = try hostStore.list()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  public func createHost(
    name: String,
    host: String,
    port: String,
    password: String,
    color: String = "#89b4fa"
  ) async throws -> HostProfileModel {
    let identity = try await probeIdentity(host: host, port: port, password: password)
    let profile = try hostStore.create(
      name: name.isEmpty ? identity.name : name,
      color: color.isEmpty ? identity.color : color,
      host: host,
      port: port,
      identityName: identity.name
    )
    try hostStore.setPassword(password, for: profile.id)
    reloadHosts()
    healthByHost[profile.id] = .reachable
    activeHostId = profile.id
    return profile
  }

  public func removeHost(id: String) {
    do {
      try hostStore.remove(id: id)
      healthByHost[id] = nil
      reloadHosts()
      if activeHostId == id {
        activeHostId = hosts.first?.id
      }
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  public func beginPairing(host: String, port: String) async {
    isPairing = true
    pairingNeedsSetup = false
    errorMessage = nil
    do {
      let status = try await unauthenticatedStatus(host: host, port: port)
      pairingNeedsSetup = status.needsSetup
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  public func completePairing(
    host: String,
    port: String,
    password: String,
    confirmPassword: String,
    displayName: String
  ) async {
    guard password == confirmPassword else {
      errorMessage = "Passwords do not match"
      return
    }
    isLoading = true
    defer { isLoading = false }
    do {
      if pairingNeedsSetup {
        try await setupPassword(host: host, port: port, password: password)
      }
      _ = try await createHost(name: displayName, host: host, port: port, password: password)
      isPairing = false
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  public func refreshSessions() async {
    guard let hostId = activeHostId else { return }
    await refreshHost(hostId: hostId)
  }

  /// Refreshes every host's session list and health for the session drawer.
  public func refreshDrawer() async {
    isLoading = true
    defer { isLoading = false }
    var nextSessions: [String: [RemoteSession]] = [:]
    for host in hosts {
      nextSessions[host.id] = await fetchSessions(for: host.id)
    }
    sessionsByHost = nextSessions
    if let activeHostId {
      sessions = nextSessions[activeHostId] ?? []
    }
  }

  /// Re-checks one host after Retry or password save.
  public func refreshHost(hostId: String) async {
    isLoading = true
    defer { isLoading = false }
    let list = await fetchSessions(for: hostId)
    sessionsByHost[hostId] = list
    if activeHostId == hostId {
      sessions = list
    }
  }

  public func newTerminal() async {
    guard activeHostId != nil else { return }
    let id = nextSessionId()
    await startSession(named: id)
  }

  public var activeSession: RemoteSession? {
    guard let activeSessionId else { return nil }
    return sessions.first(where: { $0.id == activeSessionId })
  }

  public var activeHost: HostProfileModel? {
    guard let activeHostId else { return nil }
    return hosts.first(where: { $0.id == activeHostId })
  }

  public func connectionStatus(for hostId: String) -> ConnectionStatus {
    switch healthByHost[hostId] ?? .unknown {
    case .reachable:
      .online
    case .unauthorized:
      .authFailed
    case .unknown:
      .connecting
    case .unreachable:
      .offline
    }
  }

  public enum ConnectionStatus: Equatable, Sendable {
    case online
    case connecting
    case offline
    case authFailed
  }

  public func startSession(named id: String) async {
    guard let client = await activeClient() else { return }
    do {
      _ = try await client.startSession(id: id)
      await refreshSessions()
      activeSessionId = id
      await connectTerminal(sessionId: id)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  public func killSession(id: String) async {
    guard let client = await activeClient() else { return }
    do {
      try await client.killSession(id: id)
      replayStore.forget(sessionId: id)
      if activeSessionId == id {
        disconnectTerminal()
        activeSessionId = nil
        terminalSnapshot = nil
      }
      await refreshSessions()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  public func renameSession(id: String, name: String) async {
    guard let client = await activeClient() else { return }
    do {
      try await client.renameSession(id: id, name: name)
      await refreshSessions()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  /// Whether a password is already stored for this host.
  ///
  /// A host can exist without one — restored from storage, or created before
  /// pairing completed — and in that state every authenticated request will
  /// fail. The UI needs to know so it can ask, rather than silently doing
  /// nothing when the host is selected.
  public func hasPassword(hostId: String) -> Bool {
    guard let password = try? hostStore.password(for: hostId) else { return false }
    return !(password ?? "").isEmpty
  }

  /// Stores a password for an existing host and immediately re-checks the host.
  ///
  /// Distinct from pairing, which CREATES a host. This attaches a credential to
  /// one that is already saved.
  public func savePassword(_ password: String, for hostId: String) async {
    do {
      try hostStore.setPassword(password, for: hostId)
      errorMessage = nil
      await refreshSessions()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  public func selectSession(hostId: String, sessionId: String) async {
    activeHostId = hostId
    activeSessionId = sessionId
    await connectTerminal(sessionId: sessionId)
  }

  public func sendInput(_ text: String) {
    guard let socket else {
      NSLog("TETHERDBG sendInput dropped: no socket (session=%@)", activeSessionId ?? "nil")
      return
    }
    NSLog("TETHERDBG sendInput sending %d bytes", text.utf8.count)
    guard
      let payload = try? JSONSerialization.data(withJSONObject: ["type": "input", "text": text]),
      let frame = String(data: payload, encoding: .utf8)
    else { return }
    socket.send(.string(frame)) { _ in }
  }

  public func sendInput(bytes: [UInt8]) {
    sendInput(String(decoding: bytes, as: UTF8.self))
  }

  public func sendRawKey(_ bytes: [UInt8]) {
    sendInput(bytes: bytes)
  }

  public func handleDeepLink(_ url: URL) {
    let result = deepLinks.handle(url.absoluteString)
    switch result {
    case let .matched(hostId, sessionId):
      Task {
        await selectSession(hostId: hostId, sessionId: sessionId)
      }
    case let .unknownHost(identityName):
      errorMessage = "No host profile for \"\(identityName)\""
    case .invalid:
      errorMessage = "Invalid deep link"
    case .queued:
      break
    }
  }

  /// Publishes a new grid only when the visible contents actually changed.
  ///
  /// `generation` is why this is cheap: it is compared before pulling the
  /// packed bytes, so a burst of output that does not alter the viewport costs
  /// nothing beyond the counter read.
  private func refreshTerminalSnapshot() {
    guard let emulator else { return }
    let generation = emulator.generation()
    guard generation != lastRenderedGeneration else { return }
    lastRenderedGeneration = generation
    terminalSnapshot = emulator.snapshot()
  }

  /// Pulls a grid snapshot from the core when terminal FFI is wired. Until then, no-op.
  public func pullTerminalSnapshot(from provider: () -> Data?) {
    guard let bytes = provider() else { return }
    if let header = try? GridSnapshotDecoder.decode(bytes).0,
       header.generation == lastRenderedGeneration
    {
      return
    }
    if let header = try? GridSnapshotDecoder.decode(bytes).0 {
      lastRenderedGeneration = header.generation
    }
    terminalSnapshot = bytes
  }

  private func activeClient() async -> NativeHostClient? {
    guard let hostId = activeHostId else { return nil }
    return client(for: hostId)
  }

  private func client(for hostId: String) -> NativeHostClient? {
    // `try?` on a throwing call that already returns String? flattens in
    // Swift 5+, so `password` binds as a non-optional String here — a second
    // `let` to unwrap it does not compile.
    guard
      let profile = hosts.first(where: { $0.id == hostId }),
      let password = try? hostStore.password(for: hostId),
      !password.isEmpty
    else { return nil }
    return NativeHostClient(profile: profile, password: password)
  }

  private func fetchSessions(for hostId: String) async -> [RemoteSession] {
    guard let client = client(for: hostId) else { return [] }
    do {
      let list = try await client.listSessions()
      let status = try await client.testConnection()
      updateHealth(for: hostId, status: UInt16(status))
      return list
    } catch HostClientError.unauthorized {
      updateHealth(for: hostId, status: 401)
      if activeHostId == hostId {
        errorMessage = HostClientError.unauthorized.localizedDescription
      }
      return []
    } catch {
      markHostFailure(hostId)
      if activeHostId == hostId {
        errorMessage = error.localizedDescription
      }
      return []
    }
  }

  private func nextSessionId() -> String {
    let existing = Set(sessions.map(\.id))
    var index = 1
    while existing.contains("term-\(index)") {
      index += 1
    }
    return "term-\(index)"
  }

  private func startPolling() {
    pollTask?.cancel()
    pollTask = Task { [weak self] in
      while !Task.isCancelled {
        await self?.refreshSessions()
        try? await Task.sleep(for: .seconds(3))
      }
    }
  }

  private func connectTerminal(sessionId: String) async {
    disconnectTerminal()
    guard let client = await activeClient() else { return }
    emulator = FfiTerminalEmulator(cols: terminalCols, rows: terminalRows)
    lastRenderedGeneration = nil
    terminalSnapshot = nil
    let sinceId = replayStore.sinceId(sessionId: sessionId)
    do {
      let task = try await client.openWebSocket(
        sessionId: sessionId, sinceId: sinceId,
        cols: terminalCols, rows: terminalRows)
      socket = task
      task.resume()
      socketTask = Task { [weak self] in
        await self?.readSocket(sessionId: sessionId, task: task)
      }
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func disconnectTerminal() {
    emulator = nil
    socketTask?.cancel()
    socketTask = nil
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
  }

  private func readSocket(sessionId: String, task: URLSessionWebSocketTask) async {
    while !Task.isCancelled {
      do {
        let message = try await task.receive()
        switch message {
        case let .string(text):
          handleServerFrame(text, sessionId: sessionId)
        case let .data(data):
          if let text = String(data: data, encoding: .utf8) {
            handleServerFrame(text, sessionId: sessionId)
          }
        @unknown default:
          break
        }
      } catch {
        if !Task.isCancelled {
          await MainActor.run {
            self.errorMessage = "Connection closed"
          }
        }
        break
      }
    }
  }

  private func handleServerFrame(_ text: String, sessionId: String) {
    guard
      let data = text.data(using: .utf8),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let type = json["type"] as? String
    else { return }

    switch type {
    case "output":
      // The id advances the replay cursor; the chunk is the actual terminal
      // output and must reach the parser, or the surface stays blank however
      // much data arrives.
      if let id = json["id"] as? UInt64 {
        _ = replayStore.acceptOutput(sessionId: sessionId, id: id)
      }
      if let chunk = json["chunk"] as? String, let bytes = chunk.data(using: .utf8) {
        emulator?.feed(bytes: bytes)
        refreshTerminalSnapshot()
      }
    case "reset":
      replayStore.reset(sessionId: sessionId)
      // A reset means the client's history has a hole; rebuild the grid rather
      // than letting the old contents linger under the replayed tail.
      emulator = FfiTerminalEmulator(cols: terminalCols, rows: terminalRows)
      lastRenderedGeneration = nil
      terminalSnapshot = nil
    case "title", "activity", "exit":
      Task { await refreshSessions() }
    default:
      break
    }
  }

  private func updateHealth(for hostId: String, status: UInt16) {
    let current = healthByHost[hostId] ?? .unknown
    healthByHost[hostId] = HostHealthLogic.afterResponse(current, status: status)
  }

  private func markHostFailure(_ hostId: String) {
    let current = healthByHost[hostId] ?? .unknown
    healthByHost[hostId] = HostHealthLogic.afterFailure(current)
  }

  private func probeIdentity(host: String, port: String, password: String) async throws -> ServerIdentity {
    let profile = HostProfileModel(
      FfiHostProfile(
        id: "probe",
        name: host,
        color: "#89b4fa",
        host: host,
        port: port,
        identityName: host,
        order: 0
      )
    )
    let client = NativeHostClient(profile: profile, password: password)
    return try await client.loadIdentity()
  }

  private func unauthenticatedStatus(host: String, port: String) async throws -> ServerStatus {
    guard let url = URL(string: "http://\(host):\(port)/api/status") else {
      throw HostClientError.invalidURL
    }
    let (data, response) = try await URLSession.shared.data(from: url)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else { throw HostClientError.httpStatus(status) }
    guard let decoded = try? JSONDecoder().decode(ServerStatus.self, from: data) else {
      throw HostClientError.decodeFailed
    }
    return decoded
  }

  private func setupPassword(host: String, port: String, password: String) async throws {
    guard let url = URL(string: "http://\(host):\(port)/api/setup") else {
      throw HostClientError.invalidURL
    }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode(["password": password])
    let (_, response) = try await URLSession.shared.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else { throw HostClientError.httpStatus(status) }
  }
}
