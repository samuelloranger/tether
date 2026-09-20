#if canImport(UIKit)
import SwiftUI

struct ZmxSessionDrawer: View {
  @Bindable var controller: SSHTerminalController
  var onDone: () -> Void

  @State private var newName = ""
  @State private var loading = true

  public var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 10) {
          if loading && controller.sessions.isEmpty {
            ProgressView().tint(TetherColors.accent).frame(maxWidth: .infinity).padding(.top, 30)
          } else if controller.sessions.isEmpty {
            Text("No zmx sessions yet. Create one below.")
              .font(.system(size: 13)).foregroundStyle(TetherColors.textSecondary)
              .padding(.top, 10)
          }
          ForEach(controller.sessions) { session in
            sessionRow(session)
          }
          newSessionRow
        }
        .padding(16)
      }
      .background(TetherColors.background)
      .navigationTitle("zmx sessions")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done", action: onDone) } }
      .task {
        await controller.refreshSessions()
        loading = false
      }
    }
  }

  private func sessionRow(_ session: ZmxSession) -> some View {
    let isCurrent = session.name == controller.attach
    return Button {
      Task { await controller.switchSession(to: session.name); onDone() }
    } label: {
      HStack(spacing: 10) {
        Circle().fill(isCurrent ? TetherColors.success : TetherColors.textFaint)
          .frame(width: 8, height: 8)
        VStack(alignment: .leading, spacing: 3) {
          Text(session.name).font(.system(size: 15, weight: .semibold))
            .foregroundStyle(TetherColors.textPrimary)
          Text(session.displayCwd).font(.system(size: 11, design: .monospaced))
            .foregroundStyle(TetherColors.textFaint).lineLimit(1).truncationMode(.head)
        }
        Spacer()
        if session.clients > 0 {
          Text("\(session.clients) live").font(.system(size: 9.5, weight: .semibold, design: .monospaced))
            .padding(.horizontal, 7).padding(.vertical, 3)
            .foregroundStyle(TetherColors.success)
            .background(TetherColors.success.opacity(0.12), in: Capsule())
        }
        if isCurrent {
          Text("current").font(.system(size: 9.5, weight: .semibold, design: .monospaced))
            .foregroundStyle(TetherColors.accent)
        }
      }
      .padding(.horizontal, 14).padding(.vertical, 12)
      .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 14))
      .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(isCurrent ? TetherColors.accent.opacity(0.4) : TetherColors.border))
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("zmxSession_\(session.name)")
  }

  private var newSessionRow: some View {
    HStack(spacing: 9) {
      TextField("new session name", text: $newName)
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .font(.system(size: 13, design: .monospaced)).foregroundStyle(TetherColors.textPrimary)
        .padding(10).background(TetherColors.input, in: RoundedRectangle(cornerRadius: 11))
        .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(TetherColors.border))
      Button {
        let name = newName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        Task { await controller.switchSession(to: name); onDone() }
      } label: {
        Text("Create").font(.system(size: 13, weight: .semibold))
          .padding(.horizontal, 14).padding(.vertical, 10)
          .background(TetherColors.accent, in: RoundedRectangle(cornerRadius: 11))
          .foregroundStyle(TetherColors.onAccent)
      }
      .disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty)
    }
    .padding(.top, 6)
  }
}
#endif
