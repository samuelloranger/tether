import SwiftUI

/// One tab per zmx session, directly under the terminal header. Scrolls sideways, never wraps.
struct MacSessionStrip: View {
  var tabs: MacSessionTabs
  var onKill: (String) -> Void
  @FocusState private var draftFocused: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 3) {
          ForEach(tabs.state.names, id: \.self) { name in
            MacSessionTab(tabs: tabs, name: name, onKill: onKill).id(name)
          }
          if tabs.draftName != nil { draftField.id("__draft") }
          addButton.id("__add")
        }
        .padding(3)
      }
      .background(TetherColors.input, in: RoundedRectangle(cornerRadius: 12))
      .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(TetherColors.border))
      .padding(.horizontal, 10).padding(.vertical, 6)
      .onChange(of: tabs.state.active) { _, name in
        guard let name else { return }
        withAnimation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion)) { proxy.scrollTo(name) }
      }
      .onChange(of: tabs.draftName == nil) { _, closed in
        if !closed { proxy.scrollTo("__draft") }
      }
    }
    .background(TetherColors.surface)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("macSessionStrip")
  }

  private var addButton: some View {
    Button { tabs.beginNewSession() } label: {
      Image(systemName: "plus").font(.footnote.weight(.semibold))
        .foregroundStyle(TetherColors.textSecondary)
        .padding(.horizontal, 10).padding(.vertical, 8)
        .contentShape(Rectangle())
    }
    .buttonStyle(TetherPressStyle())
    .accessibilityLabel("New session")
    .accessibilityIdentifier("macNewSession")
  }

  private var draftField: some View {
    TextField("session name", text: Binding(get: { tabs.draftName ?? "" }, set: { tabs.draftName = $0 }))
      .textInputAutocapitalization(.never).autocorrectionDisabled()
      .font(.footnote.monospaced()).foregroundStyle(TetherColors.textPrimary)
      .focused($draftFocused)
      .onSubmit { tabs.commitNewSession() }
      .onKeyPress(.escape) {
        tabs.cancelNewSession()
        return .handled
      }
      .padding(.horizontal, 10).padding(.vertical, 6)
      .frame(width: 150)
      .background(TetherColors.surfaceRaised, in: RoundedRectangle(cornerRadius: 9))
      .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(TetherColors.accent.opacity(0.5)))
      .accessibilityLabel("New session name")
      .accessibilityIdentifier("macNewSessionField")
      .onAppear { draftFocused = true }
  }
}

private struct MacSessionTab: View {
  var tabs: MacSessionTabs
  let name: String
  var onKill: (String) -> Void

  private var controller: SSHTerminalController? { tabs.controller(for: name) }
  private var selected: Bool { tabs.state.active == name }

  private var directory: String? {
    guard let cwd = controller?.terminalReport.cwd, !cwd.isEmpty else { return nil }
    let last = cwd.split(separator: "/").last.map(String.init)
    return last ?? "/"
  }

  var body: some View {
    let agent = tabs.agentStatuses[name]
    let attention = tabs.state.attention.contains(name)
    Button { tabs.select(name) } label: {
      HStack(spacing: 6) {
        if attention {
          Circle().fill(TetherColors.warning).frame(width: 7, height: 7).accessibilityHidden(true)
        }
        Text(name).font(.footnote.weight(.semibold)).lineLimit(1)
          .foregroundStyle(selected ? TetherColors.textPrimary : TetherColors.textSecondary)
        if let directory {
          Text(directory).font(.caption2.monospaced()).lineLimit(1)
            .foregroundStyle(TetherColors.textFaint)
        }
        if let agent {
          TimelineView(.periodic(from: .now, by: 60)) { context in
            AgentStatusTag(status: agent, now: context.date)
          }
        }
      }
      .padding(.horizontal, 10).padding(.vertical, 8)
      .background {
        if selected { RoundedRectangle(cornerRadius: 9).fill(TetherColors.surfaceRaised) }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(TetherPressStyle())
    .contextMenu {
      Button(role: .destructive) { onKill(name) } label: { Label("Kill session…", systemImage: "xmark.circle") }
    }
    .onChange(of: controller?.bellRings) { old, new in
      if old != nil, new != nil { tabs.noteBell(name) }
    }
    .accessibilityLabel(accessibilityText(agent: agent, attention: attention))
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier("zmxSession_\(name)")
  }

  private func accessibilityText(agent: AgentStatus?, attention: Bool) -> String {
    var parts = [name, selected ? "selected" : "tab"]
    if let agent { parts.append("agent \(AgentStatusTag.label(for: agent, now: Date()))") }
    if attention { parts.append("rang the bell") }
    return parts.joined(separator: ", ")
  }
}
