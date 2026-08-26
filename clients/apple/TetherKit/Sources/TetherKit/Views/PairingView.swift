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
        Button {
          Task { await store.beginPairing(host: host, port: port) }
        } label: {
          HStack {
            Text("Probe server")
            if store.isPairing {
              Spacer()
              ProgressView()
            }
          }
        }
        .disabled(host.isEmpty || store.isPairing)

        // A probe that fails silently is indistinguishable from a dead button,
        // which is exactly how the first TestFlight build read. Always say what
        // happened.
        if store.isPairing {
          Text("Contacting \(host):\(port)…").foregroundStyle(TetherColors.textSecondary)
        } else if store.probeSucceeded {
          Label(
            store.pairingNeedsSetup
              ? "Reached the server — it has no password yet. Choose one below."
              : "Reached the server — enter its existing password below.",
            systemImage: "checkmark.circle"
          )
          .foregroundStyle(TetherColors.success)
        } else if store.errorMessage != nil {
          Label("Could not reach \(host):\(port).", systemImage: "exclamationmark.triangle")
            .foregroundStyle(TetherColors.danger)
        }
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
    .onChange(of: host) { store.probeSucceeded = false }
    .onChange(of: port) { store.probeSucceeded = false }
  }
}
