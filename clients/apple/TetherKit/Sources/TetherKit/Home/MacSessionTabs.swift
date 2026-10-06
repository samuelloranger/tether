import SwiftUI
import UIKit

/// The Mac terminal screen's sessions: one tab per zmx session on the host, one
/// `SSHTerminalController` (its own SSH connection and PTY) per tab that has been opened.
@MainActor
@Observable
public final class MacSessionTabs {
  typealias Factory = @MainActor (_ attach: String, _ choosesInitial: Bool, _ pushIdentity: PushRegistrar.PushIdentity?)
    -> SSHTerminalController

  private(set) var state = SessionTabState()
  private(set) var controllers: [String: SSHTerminalController] = [:]
  /// Holds the connection while the host has no session, and until the first tab is adopted.
  private(set) var bare: SSHTerminalController?
  private(set) var listed: [ZmxSession] = []
  /// Non-nil while the strip shows its inline new-session field.
  var draftName: String?

  private let make: Factory
  private var refreshing = false
  private var refreshQueued = false
  private var left = false
  @ObservationIgnored private var sceneObserver: NSObjectProtocol?

  init(attach: String?, pushIdentity: PushRegistrar.PushIdentity?, make: @escaping Factory) {
    self.make = make
    let boot = make(attach ?? SSHTerminalController.defaultAttach, attach == nil, pushIdentity)
    track(boot)
    bare = boot
    // Closing the window leaves no UI to hold the connections, and nothing detaches on its own here.
    sceneObserver = NotificationCenter.default.addObserver(
      forName: UIScene.didDisconnectNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.leaveAll() }
    }
  }

  /// Starts the controller's network watch and keeps background tabs off the pasteboard.
  private func track(_ controller: SSHTerminalController) {
    controller.startNetworkWatch()
    let write = controller.writeClipboard
    controller.writeClipboard = { [weak self, weak controller] text in
      guard let self, let controller, self.activeController === controller else { return }
      write(text)
    }
  }

  var activeController: SSHTerminalController? {
    state.active.flatMap { controllers[$0] } ?? bare
  }

  /// Any live controller can answer host-wide reads; the active one is preferred.
  private var reader: SSHTerminalController? {
    let candidates = [activeController, bare] + Array(controllers.values)
    return candidates.compactMap { $0 }.first { $0.status == .connected }
  }

  var agentStatuses: [String: AgentStatus] { reader?.agentStatuses ?? [:] }

  func start() async {
    guard let boot = bare else { return }
    await boot.connect()
    await refresh()
  }

  func refresh() async {
    guard !left else { return }
    if refreshing {
      refreshQueued = true
      return
    }
    refreshing = true
    defer { refreshing = false }
    repeat {
      refreshQueued = false
      await refreshOnce()
    } while refreshQueued && !left
  }

  private func refreshOnce() async {
    adoptBareIfAttached()
    guard let reader else { return }
    await reader.refreshSessions()
    guard !left else { return }
    listed = reader.sessions
    apply(state.reconcile(listed: listed))
    adoptBareIfAttached()
    if state.names.isEmpty, bare == nil { await restartBare() }
  }

  /// The bootstrap controller already attached a session on connect.
  private func adoptBareIfAttached() {
    guard let boot = bare, boot.status == .connected, boot.hasSession else { return }
    bare = nil
    guard state.active == nil, controllers[boot.attach] == nil else {
      Task { await boot.leave() }
      return
    }
    controllers[boot.attach] = boot
    teardown(state.open(boot.attach))
  }

  private func restartBare() async {
    guard !left else { return }
    let fresh = make(SSHTerminalController.defaultAttach, true, nil)
    track(fresh)
    bare = fresh
    await fresh.connect()
  }

  private func apply(_ change: SessionTabState.Change) {
    teardown(change.removed + change.evicted)
    if let active = change.newActive { ensureController(for: active) }
  }

  private func teardown(_ names: [String]) {
    for name in names {
      guard let controller = controllers.removeValue(forKey: name) else { continue }
      Task { await controller.leave() }
    }
  }

  private func ensureController(for name: String) {
    guard controllers[name] == nil else { return }
    if let boot = bare, !boot.hasSession || boot.status == .connecting {
      bare = nil
      controllers[name] = boot
      Task { await boot.switchSession(to: name) }
      return
    }
    let controller = make(name, false, nil)
    track(controller)
    controllers[name] = controller
    Task { await controller.connect() }
  }

  func select(_ name: String) {
    guard state.names.contains(name) else { return }
    teardown(state.select(name))
    ensureController(for: name)
  }

  func selectIndex(_ index: Int) {
    if let name = state.name(at: index) { select(name) }
  }

  func step(_ offset: Int) {
    if let name = state.neighbour(offset: offset) { select(name) }
  }

  func noteBell(_ name: String) { state.noteBell(name) }

  func beginNewSession() {
    draftName = SessionTabState.newSessionName(existing: state.names)
  }

  func cancelNewSession() { draftName = nil }

  func commitNewSession() {
    let name = (draftName ?? "").trimmingCharacters(in: .whitespaces)
    draftName = nil
    guard !name.isEmpty else { return }
    if state.names.contains(name) {
      select(name)
      return
    }
    teardown(state.open(name))
    ensureController(for: name)
    Task {
      try? await Task.sleep(nanoseconds: 1_500_000_000)
      await refresh()
    }
  }

  /// Never recreates: killing the last session leaves the empty state.
  func kill(_ name: String) {
    guard let victim = controllers[name] else {
      state.markKilled(name)
    if let reader { Task { await reader.killSession(name); await refresh() } }
      return
    }
    if state.names.count <= 1 {
      controllers[name] = nil
      state.remove(name)
      state.markKilled(name)
      if let old = bare { Task { await old.leave() } }
      bare = victim
      Task { await victim.killSession(name); await refresh() }
      return
    }
    state.markKilled(name)
    let next = state.remove(name)
    controllers[name] = nil
    if let next { select(next) }
    let survivor = reader
    Task {
      if let survivor {
        await victim.leave()
        await survivor.killSession(name)
      } else {
        await victim.killSession(name)
        await victim.leave()
      }
      await refresh()
    }
  }

  func enterForeground() {
    for controller in allControllers { Task { await controller.enterForeground() } }
  }

  var allControllers: [SSHTerminalController] {
    Array(controllers.values) + (bare.map { [$0] } ?? [])
  }

  func controller(for session: String) -> SSHTerminalController? { controllers[session] }

  func leaveAll() {
    left = true
    if let sceneObserver { NotificationCenter.default.removeObserver(sceneObserver) }
    sceneObserver = nil
    let all = allControllers
    controllers = [:]
    bare = nil
    Task { for controller in all { await controller.leave() } }
  }
}

enum MacWindowTitle {
  static func set(_ title: String) {
    for scene in UIApplication.shared.connectedScenes {
      (scene as? UIWindowScene)?.title = title
    }
  }
}
