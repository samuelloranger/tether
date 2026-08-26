import Foundation
import Observation
import TetherFFIBindings

@Observable
@MainActor
public final class SessionStore {
  public private(set) var hosts: [HostProfileModel] = []
  /// Last title we saw for the active session.
  ///
  /// When health drops, the session list goes away and activeSession becomes
  /// nil, so the title bar fell back to "Tether" — the reader lost the name of
  /// the session whose output is still on screen, which tells them nothing and
  /// looks like the app forgot where it was.
  public private(set) var lastKnownSessionTitle: String?
  public private(set) var sessions: [RemoteSession] = []
  /// Sessions keyed by host id — populated by `refreshDrawer()` for the slide-over.
  public private(set) var sessionsByHost: [String: [RemoteSession]] = [:]
  public private(set) var healthByHost: [String: HostHealthModel] = [:]
  public var activeHostId: String? {
    didSet { ResumeMemory.rememberHost(activeHostId) }
  }
  public var activeSessionId: String? {
    didSet { ResumeMemory.rememberSession(activeSessionId, forHost: activeHostId) }
  }
  public var terminalSnapshot: Data?
  public var errorMessage: String?
  public var isLoading = false
  public var isPairing = false
  /// Whether the last probe reached a server, so the UI can confirm a success
  /// rather than leaving the button looking inert.
  public var probeSucceeded = false
  public var pairingNeedsSetup = false
  /// Whether the app scene is foreground — gates `{type:focus}` and resume.
  public private(set) var isAppActive = true
  /// Cold-launch restore is a one-shot; see `restoreSessionIfNeeded`.
  @ObservationIgnored private var hasRestoredSession = false

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
        // Must go through selectSession: setting the ids alone leaves the
        // session selected but NOT CONNECTED, so the title updates while every
        // keystroke is dropped by `sendInput`'s missing-socket guard.
        await self?.selectSession(hostId: hostId, sessionId: sessionId)
      }
    }
  )
  private var pollTask: Task<Void, Never>?
  private var socketTask: Task<Void, Never>?
  private var socket: URLSessionWebSocketTask?
  /// Tracks whether the active socket is usable (set false on cancel / read end).
  private var socketIsOpen = false
  /// Last inbound WS traffic (any frame, including ping), epoch ms — for resume stale check.
  private var lastTrafficMs: Int64 = 0
  private var lastRenderedGeneration: UInt64?
  /// The core's VT parser for the active session. Output bytes are fed in and
  /// packed TGRD grids come back out; this is what turns a byte stream into
  /// something the CoreText surface can draw.
  @ObservationIgnored private var emulator: FfiTerminalEmulator?
  /// Which session `emulator` holds the scrollback for, as a HOST-QUALIFIED key.
  /// A reconnect to the same session must reuse it; only a different session
  /// earns a fresh one. See `terminalKey` for why the host has to be in it.
  @ObservationIgnored private var emulatorKey: String?
  /// One source of truth for the grid size: the socket, the parser and any
  /// later resize must agree or the rendered grid will not match the PTY.
  private var terminalCols: UInt16 = 80
  private var terminalRows: UInt16 = 24

  public init(hostStore: HostStoreAdapter = HostStoreAdapter()) {
    self.hostStore = hostStore
    replayStore = FfiReplayStore()
  }

  public func bootstrap() async {
    #if DEBUG
    await seedDebugHostIfRequested()
    #endif
    do {
      hosts = try hostStore.list()
      for host in hosts {
        healthByHost[host.id] = .unknown
      }
      if activeHostId == nil {
        activeHostId = SessionResume.pickHost(
          remembered: ResumeMemory.rememberedHost(),
          available: hosts.map(\.id)
        )
      }
      startPolling()
      rememberSessionTitle()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  #if DEBUG
  /// Pairs a host from the launch environment, for driving the simulator.
  ///
  /// iOS refuses synthetic taps and keystrokes in a SecureField, so a scripted
  /// design or E2E pass could never get past the password on the pairing screen
  /// without a human at the keyboard. This lets the harness pass credentials in
  /// directly:
  ///
  ///   xcrun simctl launch --console booted <bundle> \
  ///     -TETHER_DEBUG_HOST 192.168.1.10 -TETHER_DEBUG_PORT 8097 \
  ///     -TETHER_DEBUG_PASSWORD hunter2
  ///
  /// DEBUG only, so it cannot exist in a Release build — which is what every
  /// TestFlight and App Store archive is. It also does nothing unless all three
  /// values are present, and it skips a host that is already paired.
  private func seedDebugHostIfRequested() async {
    let env = ProcessInfo.processInfo
    guard
      let host = env.environment["TETHER_DEBUG_HOST"]
        ?? UserDefaults.standard.string(forKey: "TETHER_DEBUG_HOST"),
      let password = env.environment["TETHER_DEBUG_PASSWORD"]
        ?? UserDefaults.standard.string(forKey: "TETHER_DEBUG_PASSWORD"),
      !host.isEmpty, !password.isEmpty
    else { return }
    let port = env.environment["TETHER_DEBUG_PORT"]
      ?? UserDefaults.standard.string(forKey: "TETHER_DEBUG_PORT") ?? "8085"

    let existing = (try? hostStore.list()) ?? []
    if existing.contains(where: { $0.host == host && $0.port == port }) { return }
    do {
      // TOFU: a server with no password yet rejects every authenticated call,
      // so the password has to be established first. `createHost` alone only
      // ever worked against a server that was already paired once — against a
      // fresh one it failed with 401, which made this look like an auth bug
      // rather than a missing setup step.
      if let status = try? await unauthenticatedStatus(host: host, port: port), status.needsSetup {
        try await setupPassword(host: host, port: port, password: password)
      }
      _ = try await createHost(name: "", host: host, port: port, password: password)
      print("[TETHER_DEBUG] paired \(host):\(port)")
    } catch {
      print("[TETHER_DEBUG] seed failed: \(error.localizedDescription)")
    }
  }
  #endif

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
    // Without this the flag stayed true after the first probe, so any UI gated
    // on it could never leave the probing state.
    defer { isPairing = false }
    do {
      let status = try await unauthenticatedStatus(host: host, port: port)
      pairingNeedsSetup = status.needsSetup
      probeSucceeded = true
    } catch {
      probeSucceeded = false
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
    rememberSessionTitle()
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
      await restoreSessionIfNeeded()
    }
  }

  /// Opens the terminal a cold launch should land on, once.
  ///
  /// It has to run here rather than in `bootstrap()`: at bootstrap the session
  /// list is still empty, because the first fetch is what this method waits for.
  ///
  /// The latch matters. Without it the 3-second poll would also re-open a
  /// terminal the moment the user killed the active one, turning "I closed that"
  /// into "it came back" — a different behaviour from the bug being fixed.
  private func restoreSessionIfNeeded() async {
    guard !hasRestoredSession, activeSessionId == nil, let hostId = activeHostId else { return }
    guard !sessions.isEmpty else { return }
    hasRestoredSession = true
    guard
      let id = SessionResume.pick(
        remembered: ResumeMemory.rememberedSession(forHost: hostId),
        available: SessionResume.restorable(sessions.map { ($0.id, $0.status) })
      )
    else { return }
    activeSessionId = id
    await connectTerminal(sessionId: id)
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
    // Explicit, so the cold-launch restore is spent — see `selectSession`.
    hasRestoredSession = true
    do {
      _ = try await client.startSession(id: id)
      await refreshSessions()
      if activeSessionId != id {
        sendFocus(focused: false)
      }
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
      replayStore.forget(sessionId: terminalKey(id))
      if activeSessionId == id {
        sendFocus(focused: false)
        releaseTerminal()
        activeSessionId = nil
      }
      await refreshSessions()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  /// Drive from `@Environment(\.scenePhase)` in `TetherIOSApp` (one place).
  public func handleAppLifecycle(_ phase: AppLifecyclePhase) {
    switch phase {
    case .active:
      isAppActive = true
      Task { await resumeFromForeground() }
    case .inactive:
      isAppActive = false
      sendFocus(focused: false)
    }
  }

  /// Re-evaluate the active socket after suspension (port of RN `onResumeActive`).
  public func resumeFromForeground() async {
    guard let sessionId = activeSessionId else {
      sendFocus(focused: true)
      return
    }
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    switch ResumeLogic.action(open: socketIsOpen, lastSeenMs: lastTrafficMs, nowMs: now) {
    case .reconnect, .close:
      // Native has no onClose→backoff reconnect path, so both actions reconnect.
      await connectTerminal(sessionId: sessionId)
    case .none:
      sendFocus(focused: true)
    }
  }

  /// `{ type: "focus", focused }` — server suppresses push while focused is true.
  /// Last value actually sent on the current socket, so a repeat is dropped.
  /// scenePhase reports .inactive and then .background for one transition, and
  /// both mean the same thing here.
  private var lastFocusSent: Bool?

  public func sendFocus(focused: Bool) {
    guard lastFocusSent != focused else { return }
    lastFocusSent = focused
    guard socketIsOpen, let socket else { return }
    guard
      let payload = try? JSONSerialization.data(
        withJSONObject: ["type": "focus", "focused": focused]),
      let frame = String(data: payload, encoding: .utf8)
    else { return }
    // The error was discarded here. Whatever else is losing keystrokes (see the
    // board task: ~5% of characters vanish under fast typing, while the same
    // synthetic input into a native TextField in this app loses none), a
    // swallowed send error guarantees the loss is silent — nothing on the
    // client or the server records that a keystroke never left the device.
    // Logged rather than surfaced: a transient send failure is not worth a
    // banner, but it must not be invisible to the next person measuring this.
    socket.send(.string(frame)) { error in
      #if DEBUG
      if let error {
        print("[Tether] input send failed: \(error.localizedDescription)")
      }
      #endif
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
    // The user has chosen a terminal, so the cold-launch restore has no more
    // work to do. Without this the latch could still be unspent — a launch whose
    // first fetch returned nothing never spends it — and killing this session
    // later would let the poll open another one, which is the "I closed that and
    // it came back" behaviour the latch exists to prevent.
    hasRestoredSession = true
    if activeSessionId != sessionId || activeHostId != hostId {
      sendFocus(focused: false)
    }
    activeHostId = hostId
    activeSessionId = sessionId
    await connectTerminal(sessionId: sessionId)
  }

  /// Adopts the grid the surface can actually display.
  ///
  /// Resizes the local emulator and tells the PTY, so the two agree and the
  /// shell wraps at the width the user can see.
  public func updateGrid(cols: UInt16, rows: UInt16) {
    guard cols != terminalCols || rows != terminalRows else { return }
    terminalCols = cols
    terminalRows = rows
    emulator?.resize(cols: cols, rows: rows)
    refreshTerminalSnapshot()
    sendResize(cols: cols, rows: rows)
  }

  /// Scrolls the local VT viewport through scrollback (not PTY PgUp/PgDn).
  ///
  /// Positive `lines` moves into history (older output); negative toward the
  /// live bottom. Lives next to `updateGrid` because `emulator` is private —
  /// an extension in another file cannot reach it.
  /// Remembers the active session's title so a dropped connection does not erase
  /// it from the title bar.
  private func rememberSessionTitle() {
    if let title = activeSession?.displayTitle, !title.isEmpty {
      lastKnownSessionTitle = title
    }
  }

  public func scrollViewport(lines: Int32) {
    guard lines != 0 else { return }
    emulator?.scrollViewport(lines: lines)
    refreshTerminalSnapshot()
  }

  private func sendResize(cols: UInt16, rows: UInt16) {
    guard let socket else { return }
    guard
      let payload = try? JSONSerialization.data(
        withJSONObject: ["type": "resize", "cols": Int(cols), "rows": Int(rows)]),
      let frame = String(data: payload, encoding: .utf8)
    else { return }
    socket.send(.string(frame)) { _ in }
  }

  public func sendInput(_ text: String) {
    guard let socket else { return }
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
    guard let client = client(for: hostId) else {
      // No usable password for this host. Returning early without touching
      // health left it at `.unknown`, which the drawer renders as
      // "connecting…" — so a host that could never connect looked identical to
      // one about to succeed, forever. Report it as an auth failure, which is
      // what it is, and which offers the user "Re-enter password".
      updateHealth(for: hostId, status: 401)
      return []
    }
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

  /// A cache key that includes the host.
  ///
  /// Session ids are only unique PER HOST — two servers both call their first
  /// session `default` — so anything remembered per session has to carry the
  /// host too. Keyed on the bare id, switching between two hosts whose sessions
  /// share an id looked like reconnecting to the same session: the emulator and
  /// its scrollback were reused, so the title bar showed the new host while the
  /// terminal showed the old host's output, and the replay cursor from one host
  /// was sent to the other — which can silently skip history rather than just
  /// showing the wrong thing.
  private func terminalKey(_ sessionId: String, hostId: String? = nil) -> String {
    "\(hostId ?? activeHostId ?? "-"):\(sessionId)"
  }

  private func connectTerminal(sessionId: String) async {
    disconnectTerminal()
    guard let client = await activeClient() else { return }
    // Rebuilding the emulator here while KEEPING the replay cursor threw away all
    // scrollback on every foreground resume: an empty grid plus a cursor at the
    // newest applied frame means the server replays only what arrived since, and
    // everything before it is gone for good. Reuse the emulator when reconnecting
    // the same session so `sinceId` resumes into the history it belongs to.
    let key = terminalKey(sessionId)
    if emulatorKey != key || emulator == nil {
      emulator = FfiTerminalEmulator(cols: terminalCols, rows: terminalRows)
      emulatorKey = key
      terminalSnapshot = nil
    }
    lastRenderedGeneration = nil
    let sinceId = replayStore.sinceId(sessionId: key)
    do {
      let task = try await client.openWebSocket(
        sessionId: sessionId, sinceId: sinceId,
        cols: terminalCols, rows: terminalRows)
      socket = task
      socketIsOpen = true
      lastTrafficMs = Int64(Date().timeIntervalSince1970 * 1000)
      task.resume()
      // Fresh connection is focused unless the app is known to be backgrounded
      // (matches RN sessionTransport.onSocketOpen).
      if isAppActive {
        sendFocus(focused: true)
      } else {
        sendFocus(focused: false)
      }
      // Capture the host-qualified key for this socket once. Reading
      // activeHostId again inside the frame handler races a host switch: a late
      // frame from host A would key under B, feed B's emulator, and advance B's
      // replay cursor — which can silently skip history.
      socketTask = Task { [weak self] in
        await self?.readSocket(key: key, task: task)
      }
    } catch {
      socketIsOpen = false
      errorMessage = error.localizedDescription
    }
  }

  /// Drops the emulator along with the socket — for leaving the terminal
  /// entirely, as opposed to reconnecting to the same session.
  private func releaseTerminal() {
    disconnectTerminal()
    emulator = nil
    emulatorKey = nil
    terminalSnapshot = nil
    lastRenderedGeneration = nil
  }

  private func disconnectTerminal() {
    defer { lastFocusSent = nil }
    // Order matters: sendFocus needs the socket, so the frame has to go out
    // before it is torn down. Switching sessions otherwise left the server
    // believing the old one was still on screen, and suppressing its pushes.
    sendFocus(focused: false)
    // Deliberately NOT clearing `emulator`: this runs at the top of every
    // connectTerminal, so dropping it here defeated reusing the scrollback on a
    // foreground reconnect. connectTerminal rebuilds it when the session
    // actually changes, and `releaseTerminal` clears it when there is no session.
    socketTask?.cancel()
    socketTask = nil
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    socketIsOpen = false
  }

  private func noteSocketTraffic() {
    lastTrafficMs = Int64(Date().timeIntervalSince1970 * 1000)
  }

  private func readSocket(key: String, task: URLSessionWebSocketTask) async {
    while !Task.isCancelled {
      do {
        let message = try await task.receive()
        switch message {
        case let .string(text):
          handleServerFrame(text, key: key)
        case let .data(data):
          if let text = String(data: data, encoding: .utf8) {
            handleServerFrame(text, key: key)
          }
        @unknown default:
          break
        }
      } catch {
        await MainActor.run {
          self.socketIsOpen = false
          if !Task.isCancelled {
            self.errorMessage = "Connection closed"
          }
        }
        break
      }
    }
    await MainActor.run {
      if self.socket === task {
        self.socketIsOpen = false
      }
    }
  }

  private func handleServerFrame(_ text: String, key: String) {
    // Stale socket: the active terminal moved on since this connection opened.
    // Do not re-derive the key from activeHostId — that is the race this guards.
    guard key == emulatorKey else { return }
    guard
      let data = text.data(using: .utf8),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let type = json["type"] as? String
    else { return }

    noteSocketTraffic()

    switch type {
    case "output":
      // The id advances the replay cursor; the chunk is the actual terminal
      // output and must reach the parser, or the surface stays blank however
      // much data arrives.
      // acceptOutput is the duplicate guard — it returns false for a frame
      // already applied. Discarding that answer and feeding anyway makes a
      // repeated frame reach the parser twice, which renders as doubled
      // characters ("abc" typed, "aabbcc" on screen).
      if let id = json["id"] as? UInt64,
        !replayStore.acceptOutput(sessionId: key, id: id)
      {
        return
      }
      if let chunk = json["chunk"] as? String, let bytes = chunk.data(using: .utf8) {
        emulator?.feed(bytes: bytes)
        refreshTerminalSnapshot()
      }
    case "reset":
      replayStore.reset(sessionId: key)
      // A reset means the client's history has a hole; rebuild the grid rather
      // than letting the old contents linger under the replayed tail. This is the
      // one case where a same-session rebuild is right.
      emulator = FfiTerminalEmulator(cols: terminalCols, rows: terminalRows)
      emulatorKey = key
      lastRenderedGeneration = nil
      terminalSnapshot = nil
    case "ping":
      break
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
    // A bounded timeout matters here: URLSession's 60s default made a blocked or
    // unroutable host look like a dead button rather than a failure.
    var request = URLRequest(url: url)
    request.timeoutInterval = 10
    let (data, response) = try await URLSession.shared.data(for: request)
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
