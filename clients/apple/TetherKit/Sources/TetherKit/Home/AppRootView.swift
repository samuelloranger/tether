#if canImport(UIKit)
import SwiftUI

/// The v5 app root: SSH-first. Home is the hub; opening a machine pushes an
/// SSH terminal. A relaunch skips Home and redials the last machine directly.
public struct AppRootView: View {
  @State private var model: HomeModel
  @State private var controller: SSHTerminalController?
  @State private var didAutoConnect = false
  private let autoOpenFirst: Bool

  public init() {
    _model = State(initialValue: .live())
    autoOpenFirst = false
  }

  /// DEBUG entry: a seeded model that auto-opens its first machine, for driving
  /// the full connect path (network + host-key + auth + error UI) from a launch env.
  public init(demoModel: HomeModel) {
    _model = State(initialValue: demoModel)
    autoOpenFirst = true
  }

  public var body: some View {
    ZStack {
      if let controller {
        SSHTerminalView(controller: controller, onHome: leaveTerminal)
          .transition(.move(edge: .trailing))
      } else {
        HomeView(model: model, onOpen: open)
      }
    }
    .task {
      guard !didAutoConnect else { return }
      didAutoConnect = true
      if autoOpenFirst, let first = model.profiles.first { open(first) }
      else if let last = model.lastHostProfile { open(last) }
    }
  }

  private func open(_ profile: SSHHostProfile) {
    guard let config = model.connectionConfig(for: profile) else {
      model.errorMessage = "No credential for \(profile.name) — check its key or password."
      return
    }
    controller = SSHTerminalController(title: profile.name, config: config, hostKeyStore: model.hostKeyStore)
    model.rememberLastHost(profile.id)
  }

  private func leaveTerminal() {
    let leaving = controller
    controller = nil
    model.reload()
    Task { await leaving?.leave() }
  }
}
#endif
