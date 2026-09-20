import SwiftUI

/// Add-server form: destination, auth choice, and a vault key picker with a
/// trust-on-first-use note about the host key that will be pinned.
struct AddServerSheet: View {
  @Bindable var model: HomeModel
  var onDone: () -> Void

  @State private var name = ""
  @State private var host = ""
  @State private var port = "22"
  @State private var username = ""
  @State private var usesPassword = false
  @State private var password = ""
  @State private var keyId: String?

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          field("Name") { input($name, placeholder: "homelab") }
          field("Host and port") {
            HStack(spacing: 9) {
              input($host, placeholder: "192.168.50.30")
              input($port, placeholder: "22").frame(width: 76)
            }
          }
          field("User") { input($username, placeholder: "sam") }
          field("Authentication") { authSegment }
          if usesPassword {
            field("Password") { secureInput($password) }
          } else {
            field("Key") { keyPicker }
          }
          tofuNote
          Button(action: save) {
            Text("Save server").font(.system(size: 14, weight: .semibold))
              .frame(maxWidth: .infinity).padding(.vertical, 13)
              .background(canSave ? TetherColors.accent : TetherColors.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
              .foregroundStyle(canSave ? TetherColors.onAccent : TetherColors.textFaint)
          }
          .disabled(!canSave)
          .accessibilityIdentifier("addServerSave")
          .padding(.top, 4)
        }
        .padding(16)
      }
      .background(TetherColors.background)
      .navigationTitle("Add a server")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onDone) } }
      .onAppear { if keyId == nil { keyId = model.keys.first?.id } }
    }
  }

  private var canSave: Bool {
    !name.isEmpty && !host.isEmpty && !username.isEmpty && (usesPassword ? !password.isEmpty : keyId != nil)
  }

  private func save() {
    let auth: SSHAuthMethod = usesPassword ? .password : .key(keyId: keyId ?? "")
    model.addServer(
      name: name, host: host, port: Int(port) ?? 22, username: username,
      auth: auth, password: usesPassword ? password : nil
    )
    onDone()
  }

  private var authSegment: some View {
    HStack(spacing: 3) {
      segment("Password", selected: usesPassword) { usesPassword = true }
      segment("Private key", selected: !usesPassword) { usesPassword = false }
    }
    .padding(3)
    .background(TetherColors.input, in: RoundedRectangle(cornerRadius: 11))
    .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(TetherColors.border))
  }

  private func segment(_ label: String, selected: Bool, action: @escaping () -> Void) -> some View {
    Text(label).font(.system(size: 12, weight: .semibold))
      .frame(maxWidth: .infinity).padding(.vertical, 7)
      .foregroundStyle(selected ? TetherColors.onAccent : TetherColors.textSecondary)
      .background { if selected { RoundedRectangle(cornerRadius: 8).fill(TetherColors.accent) } }
      .contentShape(Rectangle()).onTapGesture(perform: action)
  }

  @ViewBuilder
  private var keyPicker: some View {
    if model.keys.isEmpty {
      Text("No keys in the vault — generate or paste one first.")
        .font(.system(size: 11, design: .monospaced)).foregroundStyle(TetherColors.textFaint)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10).background(TetherColors.input, in: RoundedRectangle(cornerRadius: 11))
    } else {
      Menu {
        ForEach(model.keys) { key in
          Button(key.name) { keyId = key.id }
        }
      } label: {
        HStack {
          Text(model.keyName(keyId ?? "") ?? "Select a key")
            .foregroundStyle(TetherColors.accent)
          Spacer()
          Text("Change").foregroundStyle(TetherColors.textFaint)
        }
        .font(.system(size: 12, design: .monospaced))
        .padding(10).background(TetherColors.input, in: RoundedRectangle(cornerRadius: 11))
        .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(TetherColors.border))
      }
    }
  }

  private var tofuNote: some View {
    Text("First connect pins this host's key. A later change is refused.")
      .font(.system(size: 10, design: .monospaced)).foregroundStyle(TetherColors.textFaint)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(10)
      .background(TetherColors.success.opacity(0.06), in: RoundedRectangle(cornerRadius: 9))
      .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(TetherColors.success.opacity(0.2)))
  }

  private func field(_ label: String, @ViewBuilder _ control: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(label).font(.system(size: 11, weight: .medium)).foregroundStyle(TetherColors.textSecondary)
      control()
    }
  }

  private func input(_ text: Binding<String>, placeholder: String) -> some View {
    TextField(placeholder, text: text)
      .textInputAutocapitalization(.never).autocorrectionDisabled()
      .font(.system(size: 12.5, design: .monospaced)).foregroundStyle(TetherColors.textPrimary)
      .padding(10).background(TetherColors.input, in: RoundedRectangle(cornerRadius: 11))
      .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(TetherColors.border))
  }

  private func secureInput(_ text: Binding<String>) -> some View {
    SecureField("password", text: text)
      .font(.system(size: 12.5, design: .monospaced)).foregroundStyle(TetherColors.textPrimary)
      .padding(10).background(TetherColors.input, in: RoundedRectangle(cornerRadius: 11))
      .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(TetherColors.border))
  }
}

/// Generate a fresh ed25519 key, or paste an existing PEM + public key.
struct KeyEntrySheet: View {
  enum Mode { case generate, paste }

  @Bindable var model: HomeModel
  let mode: Mode
  var onDone: () -> Void

  @State private var name = ""
  @State private var pem = ""
  @State private var publicKey = ""

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          labeled("Name") {
            TextField(mode == .generate ? "phone" : "work-laptop", text: $name)
              .textInputAutocapitalization(.never).autocorrectionDisabled()
              .font(.system(size: 12.5, design: .monospaced))
              .padding(10).background(TetherColors.input, in: RoundedRectangle(cornerRadius: 11))
              .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(TetherColors.border))
          }
          if mode == .paste {
            labeled("Private key (PEM)") { editor($pem, "-----BEGIN PRIVATE KEY-----") }
            labeled("Public key (OpenSSH)") { editor($publicKey, "ssh-ed25519 AAAA…") }
          } else {
            Text("A new ed25519 key is created in the Keychain. Only its public half is shown — paste that into the host's authorized_keys.")
              .font(.system(size: 12)).foregroundStyle(TetherColors.textSecondary)
          }
          Button(action: commit) {
            Text(mode == .generate ? "Generate key" : "Save key").font(.system(size: 14, weight: .semibold))
              .frame(maxWidth: .infinity).padding(.vertical, 13)
              .background(canCommit ? TetherColors.accent : TetherColors.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
              .foregroundStyle(canCommit ? TetherColors.onAccent : TetherColors.textFaint)
          }
          .disabled(!canCommit)
          .accessibilityIdentifier("keyEntryCommit")
        }
        .padding(16)
      }
      .background(TetherColors.background)
      .navigationTitle(mode == .generate ? "Generate key" : "Paste key")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onDone) } }
    }
  }

  private var canCommit: Bool {
    switch mode {
    case .generate: return !name.isEmpty
    case .paste: return !name.isEmpty && pem.contains("PRIVATE KEY") && publicKey.hasPrefix("ssh-")
    }
  }

  private func commit() {
    switch mode {
    case .generate:
      model.generateKey(name: name)
    case .paste:
      model.importKey(name: name, privatePEM: pem, publicKey: publicKey.trimmingCharacters(in: .whitespacesAndNewlines), origin: .pasted)
    }
    onDone()
  }

  private func labeled(_ label: String, @ViewBuilder _ control: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(label).font(.system(size: 11, weight: .medium)).foregroundStyle(TetherColors.textSecondary)
      control()
    }
  }

  private func editor(_ text: Binding<String>, _ placeholder: String) -> some View {
    TextEditor(text: text)
      .frame(height: 90).font(.system(size: 11, design: .monospaced))
      .foregroundStyle(TetherColors.textPrimary).scrollContentBackground(.hidden)
      .padding(8).background(TetherColors.input, in: RoundedRectangle(cornerRadius: 11))
      .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(TetherColors.border))
      .overlay(alignment: .topLeading) {
        if text.wrappedValue.isEmpty {
          Text(placeholder).font(.system(size: 11, design: .monospaced))
            .foregroundStyle(TetherColors.textFaint).padding(14).allowsHitTesting(false)
        }
      }
  }
}
