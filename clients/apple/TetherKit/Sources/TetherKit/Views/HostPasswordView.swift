import SwiftUI

/// Attaches a password to a host that already exists.
///
/// Distinct from `PairingView`, which creates a NEW host. Without this there is
/// no route to authenticate a host restored from storage without a credential —
/// selecting it simply did nothing, because every authenticated request failed
/// before it was made.
public struct HostPasswordView: View {
  @Bindable public var store: SessionStore
  public let hostId: String
  public let hostLabel: String
  public var onDone: () -> Void

  @State private var password = ""

  public init(
    store: SessionStore,
    hostId: String,
    hostLabel: String,
    onDone: @escaping () -> Void
  ) {
    self.store = store
    self.hostId = hostId
    self.hostLabel = hostLabel
    self.onDone = onDone
  }

  public var body: some View {
    Form {
      Section("Password for \(hostLabel)") {
        SecureField("Shared server password", text: $password)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
      }

      if let error = store.errorMessage {
        Section {
          Text(error).foregroundStyle(TetherColors.danger)
        }
      }

      Section {
        Button("Connect") {
          Task {
            await store.savePassword(password, for: hostId)
            onDone()
          }
        }
        .disabled(password.isEmpty || store.isLoading)
      }
    }
    .navigationTitle("Connect")
  }
}
