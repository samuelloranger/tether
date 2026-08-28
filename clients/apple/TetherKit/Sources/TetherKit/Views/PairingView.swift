import SwiftUI

public struct PairingView: View {
  @Bindable public var store: SessionStore
  /// Called once the host has actually been created.
  ///
  /// The view cannot dismiss itself: it is presented inside a sheet the caller
  /// owns, and `@Environment(\.dismiss)` would close that sheet without the
  /// caller's `showPairing` flag ever going false, leaving a flag that says the
  /// sheet is up over a screen where it is not.
  public var onDone: () -> Void
  @State private var host = ""
  @State private var port = "8085"
  @State private var password = ""
  @State private var confirmPassword = ""
  @State private var displayName = ""

  public init(store: SessionStore, onDone: @escaping () -> Void = {}) {
    self.store = store
    self.onDone = onDone
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
        .buttonStyle(PairingActionStyle(prominent: false))
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
            // Only on success. A wrong password has to leave the form up with
            // its error, or the reader is dropped back to a terminal with no
            // idea what went wrong.
            if await store.completePairing(
              host: host,
              port: port,
              password: password,
              confirmPassword: store.pairingNeedsSetup ? confirmPassword : password,
              displayName: displayName
            ) {
              onDone()
            }
          }
        }
        .buttonStyle(PairingActionStyle(prominent: true))
        .disabled(host.isEmpty || password.isEmpty || store.isLoading)
      }
    }
    .navigationTitle("Add host")
    .listRowSeparatorTint(TetherColors.textSecondary.opacity(0.2))
    .onChange(of: host) { store.probeSucceeded = false }
    .onChange(of: port) { store.probeSucceeded = false }
  }
}


/// Gives a Form row that is an ACTION a shape a field never has.
///
/// Both the probe and the submit row used to render as plain grey text inside a
/// grouped list, so a disabled action looked exactly like an empty placeholder
/// and the primary action was invisible. A capsule reads as pressable whether or
/// not it is currently available.
private struct PairingActionStyle: ButtonStyle {
  let prominent: Bool
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.subheadline.weight(.semibold))
      .frame(maxWidth: .infinity)
      .padding(.vertical, 9)
      .background(background)
      .foregroundStyle(foreground)
      .clipShape(Capsule())
      .opacity(configuration.isPressed ? 0.75 : 1)
  }

  private var background: Color {
    guard isEnabled else { return TetherColors.textSecondary.opacity(0.14) }
    return prominent ? TetherColors.accent : TetherColors.accent.opacity(0.16)
  }

  private var foreground: Color {
    guard isEnabled else { return TetherColors.textSecondary }
    return prominent ? TetherColors.onAccent : TetherColors.accent
  }
}
