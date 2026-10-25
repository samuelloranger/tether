import SwiftUI

/// A chat shown in the terminal screen's main area. Its own connection, so the terminal stays attached.
struct EmbeddedChat: View {
  let onSessions: () -> Void
  @State private var model: ChatSessionModel

  init(route: ChatRoute, controller: SSHTerminalController, onSessions: @escaping () -> Void) {
    self.onSessions = onSessions
    _model = State(initialValue: controller.makeChatModel(route: route))
  }

  var body: some View {
    NavigationStack {
      ChatView(model: model, onSessions: onSessions)
    }
    .tint(TetherColors.accent)
  }
}

/// The working-folder step of a new chat, opened from the drawer's "+" menu.
struct NewChatSheet: View {
  let initialFolder: String
  /// Resolves the folder and opens the chat; false leaves the sheet up with its message.
  let onStart: (String) async -> Bool
  let onCancel: () -> Void

  @State private var folder = ""
  @State private var starting = false
  @State private var failed = false
  @FocusState private var focused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack {
        Text("New chat").font(.footnote.weight(.semibold)).foregroundStyle(TetherColors.textSecondary)
          .accessibilityAddTraits(.isHeader)
        Spacer()
        Button("Cancel", action: onCancel).font(.subheadline).foregroundStyle(TetherColors.accent)
          .buttonStyle(TetherPressStyle())
      }
      VStack(alignment: .leading, spacing: 6) {
        Text("Working folder").font(.caption).foregroundStyle(TetherColors.textSecondary)
        TextField("Folder on the host", text: $folder)
          .font(.callout.monospaced()).foregroundStyle(TetherColors.textPrimary)
          .textInputAutocapitalization(.never).autocorrectionDisabled()
          .focused($focused).submitLabel(.go).onSubmit(start)
          .padding(10).background(TetherColors.input, in: RoundedRectangle(cornerRadius: 10))
          .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TetherColors.border))
          .accessibilityLabel("Working folder for the new chat")
          .accessibilityIdentifier("sshNewChatFolder")
        if failed {
          Text("Couldn't read the host's home folder.").font(.caption).foregroundStyle(TetherColors.warning)
        }
      }
      Button(action: start) {
        Group {
          if starting { ProgressView().tint(TetherColors.onAccent) } else {
            Text("Start chat").font(.subheadline.weight(.semibold))
          }
        }
        .frame(maxWidth: .infinity).frame(height: 36)
        .foregroundStyle(TetherColors.onAccent)
        .background(TetherColors.accent, in: RoundedRectangle(cornerRadius: 10))
        .padding(.vertical, 4).contentShape(Rectangle())
      }
      .buttonStyle(TetherPressStyle())
      .disabled(starting)
      .accessibilityIdentifier("sshNewChatStart")
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 16).padding(.top, 16)
    .background(TetherColors.background.ignoresSafeArea())
    .presentationDetents([.height(222)])
    .onAppear { if folder.isEmpty { folder = initialFolder } }
  }

  private func start() {
    guard !starting else { return }
    starting = true
    failed = false
    focused = false
    Task {
      defer { starting = false }
      if await !onStart(folder) { failed = true }
    }
  }
}
