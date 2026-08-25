import SwiftUI

public struct PairingView: View {
  @Bindable public var store: SessionStore
  @State private var host = ""
  @State private var port = "8085"
  @State private var password = ""
  @State private var confirmPassword = ""
  @State private var displayName = ""

  public init(store: SessionStore) {
    self.store = store
  }

  public var body: some View {
    Form {
      Section("Server") {
        TextField("Host", text: $host)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .keyboardType(.URL)
        TextField("Port", text: $port)
          .keyboardType(.numberPad)
        Button("Probe server") {
          Task { await store.beginPairing(host: host, port: port) }
        }
        .disabled(host.isEmpty)
      }

      Section(store.pairingNeedsSetup ? "Create password" : "Enter password") {
        SecureField("Password", text: $password)
        if store.pairingNeedsSetup {
          SecureField("Confirm password", text: $confirmPassword)
        }
        TextField("Display name (optional)", text: $displayName)
      }

      if let error = store.errorMessage {
        Section {
          Text(error).foregroundStyle(TetherColors.danger)
        }
      }

      Section {
        Button(store.pairingNeedsSetup ? "Pair and save" : "Connect") {
          Task {
            await store.completePairing(
              host: host,
              port: port,
              password: password,
              confirmPassword: store.pairingNeedsSetup ? confirmPassword : password,
              displayName: displayName
            )
          }
        }
        .disabled(host.isEmpty || password.isEmpty || store.isLoading)
      }
    }
    .navigationTitle("Add host")
  }
}
