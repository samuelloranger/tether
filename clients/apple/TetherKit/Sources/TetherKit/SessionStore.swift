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
  /// Mouse tracking mode from the local VT emulator (DECSET 1000/1002/1003).
  public private(set) var terminalMouseMode: MouseMode = .off
  /// SGR mouse encoding (DECSET 1006) from the local VT emulator.
  public private(set) var terminalMouseSgr: Bool = true
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
  /// Per-host Noise key material (device key + pinned server key). Used both to
  /// DERIVE a host's auth mode (`authMode(for:)`) and to drive the Noise
  /// transport. Injectable so tests can pass an in-memory fake.
  private let noiseKeyStore: NoiseKeyStore
  /// The Noise transport engine, sharing `noiseKeyStore` so the keys a host was
  /// paired with are the keys its reconnect uses.
  @ObservationIgnored private let noiseClient: NoiseSessionClient
  /// In-memory per-device REST token cache for Noise hosts. A Noise host has no
  /// password, so its REST `Authorization: Bearer` value is a token minted over
  /// the Noise channel (`mintNoiseToken`), cached until near expiry and
  /// re-minted on a 401. Lazy so the mint closure can capture `self` after init.
  @ObservationIgnored private lazy var noiseTokenCache = NoiseTokenCache(
    mint: { [weak self] hostId in
      guard let self else { throw NoiseClientError.notPaired }
      return try await self.mintNoiseToken(hostId: hostId)
    }
  )
  /// Owns the socket and the VT emulator on its OWN executor. See
  /// `TerminalPipeline` for why none of that may run on the main actor.
  @ObservationIgnored private let pipeline = TerminalPipeline()
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
  /// Coalesces drawer refreshes: N taps on the drawer button must produce ONE
  /// fetch, not N. See `refreshDrawerInBackground`.
  @ObservationIgnored private var drawerRefreshTask: Task<Void, Never>?
  @ObservationIgnored private var snapshotObserver: Task<Void, Never>?
  @ObservationIgnored private var eventObserver: Task<Void, Never>?
  /// Only `pullTerminalSnapshot` uses this now — the render path's own
  /// generation check lives inside `TerminalPipeline`.
  @ObservationIgnored private var lastRenderedGeneration: UInt64?

  public init(
    hostStore: HostStoreAdapter = HostStoreAdapter(),
    noiseKeyStore: NoiseKeyStore = KeychainNoiseKeyStore()
  ) {
    self.hostStore = hostStore
    self.noiseKeyStore = noiseKeyStore
    noiseClient = NoiseSessionClient(keyStore: noiseKeyStore)
    observePipeline()
  }

  /// Drains the pipeline's two streams onto the main actor.
  ///
  /// Snapshots come through a `bufferingNewest(1)` stream, so when the main
  /// actor is busy the intermediate grids are DROPPED rather than queued —
  /// a terminal only ever needs to draw the newest one. Events are unbounded
  /// because losing "the session list changed" would leave the UI stale.
  private func observePipeline() {
    let snapshots = pipeline.snapshots
    let events = pipeline.events
    snapshotObserver = Task { [weak self] in
      for await snapshot in snapshots {
        guard let self else { return }
        self.terminalSnapshot = snapshot
      }
    }
    eventObserver = Task { [weak self] in
      for await event in events {
        guard let self else { return }
        self.apply(event)
      }
    }
  }

  private func apply(_ event: TerminalPipelineEvent) {
    switch event {
    case let .mouseModes(mode, sgr):
      terminalMouseMode = mode
      terminalMouseSgr = sgr
    case .sessionsChanged:
      Task { await refreshSessions() }
    case let .error(message):
      errorMessage = message
    }
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

  /// The DERIVED auth mode for a host — see `HostAuthModeResolver`. Interim: a
  /// host is a Noise host iff a pinned Noise server key exists for it and it has
  /// no stored password.
  public func authMode(for hostId: String) -> HostAuthMode {
    // `try?` flattens the throwing `-> Data?` / `-> String?` to a single
    // optional (same idiom as `client(for:)`). Both Noise keys are required to
    // classify `.noise` — reconnect needs the device key too, so a host missing
    // it must fall back to the password path rather than fail mid-handshake.
    let pinned = try? noiseKeyStore.loadServerPublicKey(hostId: hostId)
    let device = try? noiseKeyStore.loadDevicePrivateKey(hostId: hostId)
    let password = try? hostStore.password(for: hostId)
    return HostAuthModeResolver.resolve(
      hasPinnedNoiseKey: (pinned ?? nil) != nil,
      hasDeviceKey: (device ?? nil) != nil,
      hasPassword: !((password ?? "").isEmpty)
    )
  }

  /// Persists a HostProfile for a device that paired over Noise — the
  /// password-less sibling of `createHost`.
  ///
  /// A Noise host has no password, so it cannot `probeIdentity` (authenticated
  /// GET /api/config) and must not `setPassword`. It is created straight through
  /// the pure `hostStore.create(...)`, then the Noise key material — which the
  /// pairing sheet stored under the throwaway `pairHostId` — is migrated onto the
  /// profile's real (FFI-generated) id so `authMode(for:)` and
  /// `NoiseSessionClient.reconnect` resolve it. Additive: the password path in
  /// `createHost` is untouched.
  @discardableResult
  public func createNoiseHost(
    name: String,
    host: String,
    port: String,
    pairHostId: String,
    color: String = "#89b4fa"
  ) throws -> HostProfileModel {
    let displayName = name.isEmpty ? host : name
    // Load BOTH paired keys up front — before creating any profile. If either is
    // missing, pairing did not complete; throw without persisting anything, so we
    // never leave a keyless profile that would silently reclassify as a password
    // host on the next launch. (`try?` on a throwing `-> Data?` yields `Data??`;
    // flatten with `?? nil`.)
    guard let device = (try? noiseKeyStore.loadDevicePrivateKey(hostId: pairHostId)) ?? nil,
          let server = (try? noiseKeyStore.loadServerPublicKey(hostId: pairHostId)) ?? nil
    else {
      throw NoiseHostError.missingPairedKeys
    }
    let profile = try hostStore.create(
      name: displayName,
      color: color.isEmpty ? "#89b4fa" : color,
      host: host,
      port: port,
      identityName: displayName
    )
    // Migrate the keys onto the profile id atomically: if either save fails, roll
    // the profile back so we don't persist an orphan mis-typed as a password host.
    do {
      try noiseKeyStore.saveDevicePrivateKey(device, hostId: profile.id)
      try noiseKeyStore.saveServerPublicKey(server, hostId: profile.id)
    } catch {
      try? hostStore.remove(id: profile.id)
      try? noiseKeyStore.clear(hostId: profile.id)
      throw error
    }
    // Both keys now live under the profile id; drop the throwaway pairing id.
    if pairHostId != profile.id {
      try? noiseKeyStore.clear(hostId: pairHostId)
    }
    reloadHosts()
    healthByHost[profile.id] = .reachable
    activeHostId = profile.id
    return profile
  }

  public func removeHost(id: String) {
    // Clear Noise key material FIRST — even if the profile remove throws, no
    // pinned server key or device key may survive to let a re-created host with
    // the same id masquerade as still-paired.
    try? noiseKeyStore.clear(hostId: id)
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
    // Concurrently, not one host after another. Each host costs two round
    // trips (`listSessions` + `testConnection`), so the serial version made
    // the drawer's refresh time the SUM over every host — and one unreachable
    // host held up every reachable one behind it.
    let ids = hosts.map(\.id)
    let nextSessions = await withTaskGroup(
      of: (String, [RemoteSession]).self,
      returning: [String: [RemoteSession]].self
    ) { group in
      for id in ids {
        group.addTask { @MainActor in
          (id, await self.fetchSessions(for: id))
        }
      }
      var collected: [String: [RemoteSession]] = [:]
      for await (id, list) in group {
        collected[id] = list
      }
      return collected
    }
    sessionsByHost = nextSessions
    if let activeHostId {
      sessions = nextSessions[activeHostId] ?? []
    }
  }

  /// Refreshes the drawer WITHOUT making the caller wait for the network.
  ///
  /// The drawer used to open only after `refreshDrawer()` returned, so the
  /// panel sat shut for as long as the slowest host took to answer — and since
  /// nothing coalesced the taps, every impatient tap queued another refresh
  /// that set `isPresented = true` when it landed, re-opening a drawer the
  /// user had since closed. The panel opens immediately now; the list fills in
  /// underneath it, and a refresh already in flight is reused.
  public func refreshDrawerInBackground() {
    guard drawerRefreshTask == nil else { return }
    drawerRefreshTask = Task { [weak self] in
      await self?.refreshDrawer()
      self?.drawerRefreshTask = nil
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
    guard let activeHostId else { return }
    await newTerminal(hostId: activeHostId)
  }

  /// Starts a terminal on a NAMED host and switches to it.
  ///
  /// The drawer lists every host, so "New terminal" cannot mean "on whichever
  /// host happens to be active" — reaching a second server took selecting one
  /// of its sessions first, which is impossible when it has none.
  public func newTerminal(hostId: String) async {
    if authMode(for: hostId) == .noise {
      await newNoiseTerminal(hostId: hostId)
      return
    }
    guard let client = client(for: hostId) else { return }
    // THIS host's list, fetched fresh, before an id is picked. A host the
    // drawer has never loaded has no `sessionsByHost` entry, so allocating
    // from the cache would pick `term-1` for a host that already runs one —
    // and `/api/sessions/start` returns the EXISTING session for a known id
    // (apps/server/src/server/pty.ts), so the button would silently attach to
    // a running terminal instead of opening a new one.
    let known = await fetchSessions(for: hostId)
    sessionsByHost[hostId] = known
    if activeHostId == hostId {
      sessions = known
    }
    let id = nextSessionId(among: known)
    // Explicit, so the cold-launch restore is spent — see `selectSession`.
    hasRestoredSession = true
    do {
      _ = try await client.startSession(id: id)
      if activeHostId != hostId || activeSessionId != id {
        await pipeline.sendFocus(focused: false)
      }
      activeHostId = hostId
      activeSessionId = id
      // Connect FIRST. Refreshing every host before opening the socket meant a
      // terminal started on a healthy host stayed disconnected for as long as
      // the slowest host took to time out.
      await connectTerminal(sessionId: id)
      refreshDrawerInBackground()
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  /// Opens a terminal on a Noise host. There is no REST `startSession` for a
  /// Noise host — the Noise `start` frame both spawns and attaches server-side —
  /// so the tab is synthesized locally and the session is created lazily by the
  /// pipeline's `sendStart`. Multiple concurrent Noise sessions are a future TODO;
  /// for now a Noise host drives one `term-1`.
  private func newNoiseTerminal(hostId: String) async {
    let known = sessionsByHost[hostId] ?? []
    let id = nextSessionId(among: known)
    let synthesized = RemoteSession(
      id: id, status: "running", lastOutputAt: nil, name: nil, autoTitle: nil, activity: nil
    )
    var next = known
    next.append(synthesized)
    sessionsByHost[hostId] = next
    hasRestoredSession = true
    if activeHostId != hostId || activeSessionId != id {
      await pipeline.sendFocus(focused: false)
    }
    activeHostId = hostId
    activeSessionId = id
    sessions = next
    await connectTerminal(sessionId: id)
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
        await pipeline.sendFocus(focused: false)
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
      await pipeline.forget(key: terminalKey(id))
      if activeSessionId == id {
        await pipeline.release()
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
      await pipeline.sendFocus(focused: true)
      return
    }
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    switch await pipeline.resumeAction(nowMs: now) {
    case .reconnect, .close:
      // Native has no onClose→backoff reconnect path, so both actions reconnect.
      await connectTerminal(sessionId: sessionId)
    case .none:
      await pipeline.sendFocus(focused: true)
    }
  }

  /// `{ type: "focus", focused }` — the server suppresses push while focused
  /// is true. Fire-and-forget: the repeat guard and the socket live in the
  /// pipeline. Call `await pipeline.sendFocus` directly from an async path that
  /// needs the frame ORDERED against a connect or a teardown.
  public func sendFocus(focused: Bool) {
    pipeline.outbound.yield(.focus(focused))
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
      // Awaited, not queued: this frame has to reach the OLD socket before
      // `connectTerminal` tears it down.
      await pipeline.sendFocus(focused: false)
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
    pipeline.outbound.yield(.resize(cols: cols, rows: rows))
  }

  /// Remembers the active session's title so a dropped connection does not
  /// erase it from the title bar.
  private func rememberSessionTitle() {
    if let title = activeSession?.displayTitle, !title.isEmpty {
      lastKnownSessionTitle = title
    }
  }

  /// Scrolls the local VT viewport through scrollback (not PTY PgUp/PgDn).
  ///
  /// Positive `lines` moves into history (older output); negative toward the
  /// live bottom.
  public func scrollViewport(lines: Int32) {
    guard lines != 0 else { return }
    Task { await pipeline.scrollViewport(lines: lines) }
  }

  /// Queues a keystroke on the pipeline's outbound stream.
  ///
  /// NOT `Task { await pipeline.send… }`: a task per keystroke has no defined
  /// enqueue order, so fast typing could reach the socket scrambled. Stream
  /// yields are FIFO and need no await, which is what a key handler wants.
  public func sendInput(_ text: String) {
    pipeline.outbound.yield(.input(text, key: activeTerminalKey))
  }

  /// The terminal a keystroke is being typed INTO, stamped on every outbound
  /// frame so a session switch cannot deliver it to the wrong session.
  private var activeTerminalKey: String? {
    guard let activeSessionId else { return nil }
    return terminalKey(activeSessionId)
  }

  public func sendInput(bytes: [UInt8]) {
    sendInput(String(decoding: bytes, as: UTF8.self))
  }

  /// Sends clipboard text as a paste rather than as typing.
  ///
  /// The emulator knows whether the program has bracketed paste on (DECSET
  /// 2004) and builds the payload: fenced in `ESC[200~`/`ESC[201~` when it
  /// does, with the clipboard's own fence markers stripped either way. Without
  /// the fence a shell treats every newline in the clipboard as Enter and runs
  /// the lines one by one, and editors lose the "this was pasted" signal they
  /// use to skip auto-indent.
  public func sendPaste(_ text: String) {
    guard !text.isEmpty else { return }
    pipeline.outbound.yield(.paste(text, key: activeTerminalKey))
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
    guard let profile = hosts.first(where: { $0.id == hostId }) else { return nil }
    // A Noise host has no password: its REST Bearer is a device token minted
    // over the Noise channel and cached (re-minted on 401). Additive — password
    // hosts are unchanged below.
    if authMode(for: hostId) == .noise {
      return NativeHostClient(
        profile: profile,
        bearerSource: NoiseTokenBearerSource(cache: noiseTokenCache, hostId: hostId)
      )
    }
    // `try?` on a throwing call that already returns String? flattens in
    // Swift 5+, so `password` binds as a non-optional String here — a second
    // `let` to unwrap it does not compile.
    guard
      let password = try? hostStore.password(for: hostId),
      !password.isEmpty
    else { return nil }
    return NativeHostClient(profile: profile, password: password)
  }

  /// Mint a REST device token for a Noise host over its Noise channel. Backs
  /// `noiseTokenCache`; resolves the host's Noise base URL and delegates to
  /// `NoiseSessionClient.requestToken`.
  private func mintNoiseToken(hostId: String) async throws -> (token: String, expiresAt: Date) {
    guard
      let host = hosts.first(where: { $0.id == hostId }),
      let url = SessionStore.noiseBaseURL(host: host.host, port: host.port)
    else {
      throw HostClientError.invalidURL
    }
    return try await noiseClient.requestToken(hostId: hostId, url: url)
  }

  private func fetchSessions(for hostId: String) async -> [RemoteSession] {
    // A Noise host has no Bearer credential and no REST session list — its
    // sessions live only over the Noise channel. Report it reachable and keep
    // whatever tabs were synthesized locally, so the 3-second poll neither marks
    // it auth-failed nor wipes an open Noise terminal out from under the stream.
    // TODO: a `GET /api/noise/sessions`-equivalent would let the drawer show a
    // Noise host's real server-side session list.
    if authMode(for: hostId) == .noise {
      // No Bearer credential + no REST list — probe reachability over the Noise
      // path (a reconnect handshake) instead of the password `/api/config`, which
      // would always 401 it. Throttled so the 3s poll doesn't hammer a handshake.
      // Keep the locally-synthesized tabs either way.
      await pingNoiseHealth(hostId)
      return sessionsByHost[hostId] ?? []
    }
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

  /// Last time each Noise host's reachability was probed, so the 3s session poll
  /// runs the (heavier) Noise handshake at most every 8s.
  private var lastNoisePingAt: [String: Date] = [:]

  /// Reachability for a Noise host: attempt the IK reconnect handshake. Success =
  /// up AND this device still authorized → `.reachable`; any failure (host down,
  /// or this device revoked) → `.unreachable`. Throttled to ~8s.
  private func pingNoiseHealth(_ hostId: String) async {
    let now = Date()
    if let last = lastNoisePingAt[hostId], now.timeIntervalSince(last) < 8 { return }
    lastNoisePingAt[hostId] = now

    guard let host = hosts.first(where: { $0.id == hostId }),
          let url = SessionStore.noiseBaseURL(host: host.host, port: host.port)
    else {
      markHostFailure(hostId)
      return
    }
    do {
      let channel = try await noiseClient.reconnect(hostId: hostId, url: url)
      await channel.close()
      healthByHost[hostId] = .reachable
    } catch {
      markHostFailure(hostId)
    }
  }

  /// Picks a free `term-N` against ONE host's session list.
  ///
  /// Ids are only unique per host, so the candidate list has to be that host's
  /// own sessions — measured against the active host's list, a new terminal on
  /// a second server could collide with an id that server already runs.
  private func nextSessionId(among known: [RemoteSession]) -> String {
    let existing = Set(known.map(\.id))
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
    // Disconnect first even when there is no usable client: leaving the old
    // socket open under a host that cannot be reached is how the server keeps
    // believing a session is on screen.
    await pipeline.disconnect()
    guard let hostId = activeHostId else { return }
    // Branch ONCE on the derived auth mode: a Noise host drives the sealed
    // channel, a password host drives the Bearer WebSocket. Both feed the same
    // emulator inside the pipeline.
    switch authMode(for: hostId) {
    case .noise:
      await connectTerminalNoise(hostId: hostId, sessionId: sessionId)
    case .password:
      guard let client = client(for: hostId) else { return }
      await pipeline.connect(
        client: client,
        sessionId: sessionId,
        key: terminalKey(sessionId),
        focused: isAppActive
      )
    }
  }

  /// Establishes the Noise transport for a session and hands the pipeline a live
  /// `NoiseChannel` to pump. The URL is `https://host:port`;
  /// `NoiseSessionClient.reconnect` maps it to `wss` and appends
  /// `/api/noise/session` itself.
  private func connectTerminalNoise(hostId: String, sessionId: String) async {
    guard
      let host = hosts.first(where: { $0.id == hostId }),
      let url = SessionStore.noiseBaseURL(host: host.host, port: host.port)
    else {
      errorMessage = HostClientError.invalidURL.localizedDescription
      return
    }
    await pipeline.connectNoise(
      client: noiseClient,
      hostId: hostId,
      url: url,
      sessionId: sessionId,
      key: terminalKey(sessionId)
    )
  }

  /// Base URL for the Noise handshake. Noise runs over TLS (`wss`), so this is
  /// `https://…`; the port is the host's stored port.
  static func noiseBaseURL(host: String, port: String) -> URL? {
    URL(string: "https://\(host):\(port)")
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
