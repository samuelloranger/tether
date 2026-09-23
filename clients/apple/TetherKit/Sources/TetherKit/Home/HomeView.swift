import SwiftUI

public struct HomeView: View {
  @Bindable var model: HomeModel
  var onOpen: (SSHHostProfile) -> Void
  var onClose: (() -> Void)?

  @State private var tab: Tab
  @State private var showAdd = false
  @State private var keyEntry: KeyEntry?
  /// Removing a machine or a key is unrecoverable, so both route through a
  /// confirmation instead of firing straight off a context menu.
  @State private var pendingServerRemoval: SSHHostProfile?
  @State private var pendingKeyDeletion: SSHKeyRecord?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @ScaledMetric(relativeTo: .title3) private var addButtonSize: CGFloat = 32
  @ScaledMetric(relativeTo: .body) private var keyActionIconSize: CGFloat = 22

  public enum Tab: String { case machines, keys }

  public init(
    model: HomeModel,
    initialTab: Tab = .machines,
    onOpen: @escaping (SSHHostProfile) -> Void,
    onClose: (() -> Void)? = nil
  ) {
    self.model = model
    self.onOpen = onOpen
    self.onClose = onClose
    _tab = State(initialValue: initialTab)
  }

  public var body: some View {
    ZStack(alignment: .top) {
      TetherColors.background.ignoresSafeArea()
      auroraGlow
      VStack(spacing: 0) {
        header
        tabs
        ZStack { content.id(tab).transition(TetherMotion.screenTransition(reduceMotion: reduceMotion)) }
          .animation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion), value: tab)
      }
    }
    .sheet(isPresented: $showAdd) {
      AddServerSheet(model: model) { showAdd = false }
    }
    .sheet(item: $keyEntry) { entry in
      KeyEntrySheet(model: model, mode: entry.mode) { keyEntry = nil }
    }
    .alert(
      "Something went wrong",
      isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })
    ) {
      Button("OK", role: .cancel) { model.errorMessage = nil }
    } message: {
      Text(model.errorMessage ?? "")
    }
    .destructiveConfirmation(
      $pendingServerRemoval,
      title: { "Remove \($0.name)?" },
      actionLabel: "Remove machine",
      message: "Its sessions keep running on the host — only this phone forgets it."
    ) { model.removeServer(id: $0.id) }
    .destructiveConfirmation(
      $pendingKeyDeletion,
      title: { "Delete key \($0.name)?" },
      actionLabel: "Delete key",
      message: "The private key leaves the Keychain and cannot be recovered."
    ) { model.deleteKey(id: $0.id) }
  }

  private var auroraGlow: some View {
    RadialGradient(
      colors: [TetherColors.accent.opacity(0.28), TetherColors.success.opacity(0.14), .clear],
      center: .top, startRadius: 4, endRadius: 240
    )
    .frame(height: 220)
    .blur(radius: 18)
    .offset(y: -40)
    .allowsHitTesting(false)
    .ignoresSafeArea()
  }

  private var header: some View {
    HStack(alignment: .bottom) {
      VStack(alignment: .leading, spacing: 3) {
        Text("Home").font(.largeTitle.weight(.bold)).foregroundStyle(TetherColors.textPrimary)
        Text(summary)
          .font(.caption2.monospaced())
          .foregroundStyle(TetherColors.textFaint)
      }
      Spacer()
      if let onClose {
        Button(action: onClose) {
          Image(systemName: "xmark").font(.footnote.weight(.semibold))
        }
        .foregroundStyle(TetherColors.textSecondary)
        .padding(.trailing, 6)
        .accessibilityLabel("Close home")
      }
      Button { showAdd = true } label: {
        Image(systemName: "plus").font(.title3.weight(.medium))
          .frame(width: addButtonSize, height: addButtonSize)
          .background(TetherColors.surfaceRaised, in: RoundedRectangle(cornerRadius: 9))
          .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(TetherColors.border))
      }
      .foregroundStyle(TetherColors.accent)
      .buttonStyle(TetherPressStyle())
      .accessibilityIdentifier("homeAddServer")
      .accessibilityLabel("Add a machine")
    }
    .padding(.horizontal, 18)
    .padding(.top, 20)
    .padding(.bottom, 8)
  }

  private var summary: String {
    switch tab {
    case .machines:
      return model.profiles.isEmpty ? "no machines yet" : "\(model.profiles.count) machine\(model.profiles.count == 1 ? "" : "s")"
    case .keys:
      return "\(model.keys.count) key\(model.keys.count == 1 ? "" : "s") · Keychain"
    }
  }

  private var tabs: some View {
    HStack(spacing: 3) {
      tabButton(.machines, "Machines")
      tabButton(.keys, "Keys")
    }
    .padding(3)
    .background(TetherColors.input, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(TetherColors.border))
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
  }

  private func tabButton(_ value: Tab, _ label: String) -> some View {
    let selected = tab == value
    return Button {
      withAnimation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion)) { tab = value }
    } label: {
      Text(label)
        .font(.footnote.weight(.semibold))
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .foregroundStyle(selected ? TetherColors.textPrimary : TetherColors.textSecondary)
        .background {
          if selected {
            RoundedRectangle(cornerRadius: 9).fill(TetherColors.surfaceRaised)
          }
        }
        .contentShape(Rectangle())
    }
      .buttonStyle(TetherPressStyle())
      .animation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion), value: selected)
      .accessibilityIdentifier("homeTab_\(value.rawValue)")
  }

  @ViewBuilder
  private var content: some View {
    switch tab {
    case .machines:
      if model.profiles.isEmpty { emptyMachines } else { machineList }
    case .keys:
      keysTab
    }
  }

  private var emptyMachines: some View {
    VStack(spacing: 10) {
      Spacer()
      Image(systemName: "point.3.connected.trianglepath.dotted")
        .font(.system(.largeTitle, design: .default, weight: .light))
        .foregroundStyle(TetherColors.accent)
      Text("No machines tethered yet").font(.title3.weight(.semibold))
        .foregroundStyle(TetherColors.textPrimary)
      Text("Add a server to open a shell that stays alive between visits.")
        .font(.footnote).foregroundStyle(TetherColors.textSecondary)
        .multilineTextAlignment(.center).frame(maxWidth: 240)
      Button { showAdd = true } label: {
        Text("Add a server").font(.subheadline.weight(.semibold))
          .padding(.horizontal, 20).padding(.vertical, 11)
          .background(TetherColors.accent, in: RoundedRectangle(cornerRadius: 12))
          .foregroundStyle(TetherColors.onAccent)
      }
      .padding(.top, 6)
      .buttonStyle(TetherPressStyle())
      Spacer()
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(.horizontal, 26)
  }

  private var machineList: some View {
    ScrollView {
      LazyVStack(spacing: 10) {
        ForEach(model.profiles) { profile in
          MachineCardView(profile: profile, authLabel: model.authLabel(for: profile), onOpen: { onOpen(profile) })
            .contextMenu {
              Button(role: .destructive) { pendingServerRemoval = profile } label: {
                Label("Remove", systemImage: "trash")
              }
            }
        }
      }
      .padding(.horizontal, 12).padding(.vertical, 2)
    }
  }

  private var keysTab: some View {
    VStack(spacing: 0) {
      ScrollView {
        LazyVStack(spacing: 10) {
          ForEach(model.keys) { key in
            KeyCardView(record: key, usedBy: model.machinesUsing(keyId: key.id))
              .contextMenu {
                Button { UIPasteboard.general.string = key.publicKey } label: {
                  Label("Copy public key", systemImage: "doc.on.doc")
                }
                Button(role: .destructive) { pendingKeyDeletion = key } label: {
                  Label("Delete key", systemImage: "trash")
                }
              }
          }
          if model.keys.isEmpty {
            Text("No keys yet. Generate one, or paste an existing key.")
              .font(.footnote).foregroundStyle(TetherColors.textSecondary)
              .multilineTextAlignment(.center).padding(.top, 40).frame(maxWidth: 240)
          }
        }
        .padding(.horizontal, 12).padding(.vertical, 2)
      }
      keyActions
    }
  }

  private var keyActions: some View {
    HStack(spacing: 9) {
      keyActionButton("Generate", "plus", prime: true) { keyEntry = KeyEntry(mode: .generate) }
      keyActionButton("Import", "square.and.arrow.down", prime: false) { keyEntry = KeyEntry(mode: .importFile) }
      keyActionButton("Paste", "doc.on.clipboard", prime: false) { keyEntry = KeyEntry(mode: .paste) }
    }
    .fixedSize(horizontal: false, vertical: true)
    .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 14)
  }

  private func keyActionButton(_ label: String, _ icon: String, prime: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      VStack(spacing: 6) {
        // SF Symbols differ in height; a fixed icon box keeps the three buttons level.
        Image(systemName: icon).font(.body.weight(.semibold))
          .frame(height: keyActionIconSize)
        Text(label).font(.caption.weight(.semibold))
          .lineLimit(2).minimumScaleFactor(0.75).multilineTextAlignment(.center)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity).padding(.vertical, 12)
      .background(prime ? TetherColors.accent : TetherColors.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
      .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(prime ? .clear : TetherColors.border))
      .foregroundStyle(prime ? TetherColors.onAccent : TetherColors.textPrimary)
    }
    .buttonStyle(TetherPressStyle())
    .accessibilityIdentifier("homeKey_\(label)")
  }

  private struct KeyEntry: Identifiable {
    let id = UUID()
    let mode: KeyEntrySheet.Mode
  }
}
