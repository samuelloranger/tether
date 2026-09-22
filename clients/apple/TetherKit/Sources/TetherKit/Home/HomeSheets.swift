import SwiftUI
import UniformTypeIdentifiers

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
            Text("Save server").font(.subheadline.weight(.semibold))
              .frame(maxWidth: .infinity).padding(.vertical, 13)
              .background(canSave ? TetherColors.accent : TetherColors.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
              .foregroundStyle(canSave ? TetherColors.onAccent : TetherColors.textFaint)
          }
          .disabled(!canSave)
          .accessibilityIdentifier("addServerSave")
          .accessibilityHint(saveBlocker ?? "")
          .padding(.top, 4)
          if let saveBlocker {
            Text(saveBlocker).font(.caption).foregroundStyle(TetherColors.textFaint)
              .frame(maxWidth: .infinity, alignment: .center)
              .accessibilityHidden(true)
          }
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

  private var saveBlocker: String? {
    FormReadiness.serverBlocker(
      name: name, host: host, username: username,
      usesPassword: usesPassword, password: password, hasKey: keyId != nil)
  }

  private var canSave: Bool { saveBlocker == nil }

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
    Text(label).font(.caption.weight(.semibold))
      .frame(maxWidth: .infinity).padding(.vertical, 7)
      .foregroundStyle(selected ? TetherColors.onAccent : TetherColors.textSecondary)
      .background { if selected { RoundedRectangle(cornerRadius: 8).fill(TetherColors.accent) } }
      .contentShape(Rectangle()).onTapGesture(perform: action)
  }

  @ViewBuilder
  private var keyPicker: some View {
    if model.keys.isEmpty {
      Text("No keys in the vault — generate or paste one first.")
        .font(.caption2.monospaced()).foregroundStyle(TetherColors.textFaint)
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
        .font(.caption.monospaced())
        .padding(10).background(TetherColors.input, in: RoundedRectangle(cornerRadius: 11))
        .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(TetherColors.border))
      }
    }
  }

  private var tofuNote: some View {
    Text("First connect pins this host's key. A later change is refused.")
      .font(.caption2.monospaced()).foregroundStyle(TetherColors.textFaint)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(10)
      .background(TetherColors.success.opacity(0.06), in: RoundedRectangle(cornerRadius: 9))
      .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(TetherColors.success.opacity(0.2)))
  }

  private func field(_ label: String, @ViewBuilder _ control: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(label).font(.caption2.weight(.medium)).foregroundStyle(TetherColors.textSecondary)
      control()
    }
  }

  private func input(_ text: Binding<String>, placeholder: String) -> some View {
    TextField(placeholder, text: text)
      .textInputAutocapitalization(.never).autocorrectionDisabled()
      .font(.caption.monospaced()).foregroundStyle(TetherColors.textPrimary)
      .padding(10).background(TetherColors.input, in: RoundedRectangle(cornerRadius: 11))
      .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(TetherColors.border))
  }

  private func secureInput(_ text: Binding<String>) -> some View {
    SecureField("password", text: text)
      .font(.caption.monospaced()).foregroundStyle(TetherColors.textPrimary)
      .padding(10).background(TetherColors.input, in: RoundedRectangle(cornerRadius: 11))
      .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(TetherColors.border))
  }
}

struct KeyEntrySheet: View {
  enum Mode { case generate, paste, importFile }

  @Bindable var model: HomeModel
  let mode: Mode
  var onDone: () -> Void

  @State private var name = ""
  @State private var pem = ""
  @State private var publicKey = ""
  @State private var showImporter = false

  private var title: String {
    switch mode {
    case .generate: return "Generate key"
    case .paste: return "Paste key"
    case .importFile: return "Import key"
    }
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          labeled("Name") {
            TextField(mode == .generate ? "phone" : "work-laptop", text: $name)
              .textInputAutocapitalization(.never).autocorrectionDisabled()
              .font(.caption.monospaced())
              .padding(10).background(TetherColors.input, in: RoundedRectangle(cornerRadius: 11))
              .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(TetherColors.border))
          }
          if mode == .generate {
            Text("A new ed25519 key is created in the Keychain. Only its public half is shown — paste that into the host's authorized_keys.")
              .font(.caption).foregroundStyle(TetherColors.textSecondary)
          } else {
            if mode == .importFile {
              Button { showImporter = true } label: {
                Label("Load private key file…", systemImage: "folder")
                  .font(.caption.weight(.semibold)).foregroundStyle(TetherColors.accent)
                  .frame(maxWidth: .infinity).padding(.vertical, 10)
                  .background(TetherColors.surfaceRaised, in: RoundedRectangle(cornerRadius: 11))
                  .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(TetherColors.border))
              }
            }
            labeled("Private key (PEM)") { editor($pem, "-----BEGIN PRIVATE KEY-----") }
            labeled("Public key (OpenSSH)") { editor($publicKey, "ssh-ed25519 AAAA…") }
          }
          Button(action: commit) {
            Text(mode == .generate ? "Generate key" : "Save key").font(.subheadline.weight(.semibold))
              .frame(maxWidth: .infinity).padding(.vertical, 13)
              .background(canCommit ? TetherColors.accent : TetherColors.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
              .foregroundStyle(canCommit ? TetherColors.onAccent : TetherColors.textFaint)
          }
          .disabled(!canCommit)
          .accessibilityIdentifier("keyEntryCommit")
          .accessibilityHint(commitBlocker ?? "")
          if let commitBlocker {
            Text(commitBlocker).font(.caption).foregroundStyle(TetherColors.textFaint)
              .frame(maxWidth: .infinity, alignment: .center)
              .accessibilityHidden(true)
          }
        }
        .padding(16)
      }
      .background(TetherColors.background)
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onDone) } }
      .fileImporter(isPresented: $showImporter, allowedContentTypes: [.data, .text]) { result in
        if case let .success(url) = result { loadPrivateKey(from: url) }
      }
    }
  }

  private var canCommit: Bool {
    commitBlocker == nil
  }

  private var commitBlocker: String? {
    FormReadiness.keyBlocker(name: name, needsMaterial: mode != .generate, pem: pem, publicKey: publicKey)
  }

  private func commit() {
    switch mode {
    case .generate:
      model.generateKey(name: name)
    case .paste:
      model.importKey(name: name, privatePEM: pem, publicKey: publicKey.trimmingCharacters(in: .whitespacesAndNewlines), origin: .pasted)
    case .importFile:
      model.importKey(name: name, privatePEM: pem, publicKey: publicKey.trimmingCharacters(in: .whitespacesAndNewlines), origin: .imported)
    }
    onDone()
  }

  private func loadPrivateKey(from url: URL) {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    guard let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8) else { return }
    pem = text
    if name.isEmpty { name = url.deletingPathExtension().lastPathComponent }
  }

  private func labeled(_ label: String, @ViewBuilder _ control: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(label).font(.caption2.weight(.medium)).foregroundStyle(TetherColors.textSecondary)
      control()
    }
  }

  private func editor(_ text: Binding<String>, _ placeholder: String) -> some View {
    TextEditor(text: text)
      .frame(height: 90).font(.caption2.monospaced())
      .foregroundStyle(TetherColors.textPrimary).scrollContentBackground(.hidden)
      .padding(8).background(TetherColors.input, in: RoundedRectangle(cornerRadius: 11))
      .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(TetherColors.border))
      .overlay(alignment: .topLeading) {
        if text.wrappedValue.isEmpty {
          Text(placeholder).font(.caption2.monospaced())
            .foregroundStyle(TetherColors.textFaint).padding(14).allowsHitTesting(false)
        }
      }
  }
}
