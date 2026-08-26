import SwiftUI

public struct HostListView: View {
  @Bindable public var store: SessionStore
  public var onAddHost: () -> Void
  public var onSelectHost: (String) -> Void

  public init(store: SessionStore, onAddHost: @escaping () -> Void, onSelectHost: @escaping (String) -> Void) {
    self.store = store
    self.onAddHost = onAddHost
    self.onSelectHost = onSelectHost
  }

  public var body: some View {
    List {
      Section("Hosts") {
        ForEach(store.hosts) { host in
          Button {
            onSelectHost(host.id)
          } label: {
            HStack(spacing: 12) {
              Circle()
                .fill(Color(hex: host.color))
                .frame(width: 10, height: 10)
              VStack(alignment: .leading, spacing: 2) {
                Text(host.name)
                  .foregroundStyle(TetherColors.textPrimary)
                Text("\(host.host):\(host.port)")
                  .font(.caption)
                  .foregroundStyle(TetherColors.textSecondary)
              }
              Spacer()
              healthBadge(for: host.id)
            }
          }
        }
        .onDelete { indexSet in
          for index in indexSet {
            store.removeHost(id: store.hosts[index].id)
          }
        }
      }
    }
    .scrollContentBackground(.hidden)
    .background(TetherColors.background)
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button("Add host", systemImage: "plus", action: onAddHost)
      }
    }
  }

  @ViewBuilder
  private func healthBadge(for hostId: String) -> some View {
    switch store.healthByHost[hostId] ?? .unknown {
    case .reachable:
      Image(systemName: "checkmark.circle.fill")
        .foregroundStyle(.green)
        .accessibilityLabel("Reachable")
    case .unauthorized:
      Image(systemName: "lock.fill")
        .foregroundStyle(.orange)
        .accessibilityLabel("Unauthorized")
    case .unreachable:
      Image(systemName: "wifi.exclamationmark")
        .foregroundStyle(TetherColors.danger)
        .accessibilityLabel("Unreachable")
    case .unknown:
      Image(systemName: "questionmark.circle")
        .foregroundStyle(TetherColors.textSecondary)
        .accessibilityLabel("Unknown")
    }
  }
}
