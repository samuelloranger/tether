import SwiftUI

/// Port of `apps/mobile/src/GitTabBar.tsx`.
public struct GitTabBar: View {
  public enum Tab: String, CaseIterable, Hashable {
    case changes
    case history
  }

  @Binding public var tab: Tab

  public init(tab: Binding<Tab>) {
    self._tab = tab
  }

  public var body: some View {
    HStack(spacing: 0) {
      tabButton(.changes, label: "Working tree")
      tabButton(.history, label: "History")
      Spacer(minLength: 0)
    }
    .background(TetherColors.surface)
    .overlay(alignment: .bottom) {
      Rectangle()
        .fill(TetherColors.background)
        .frame(height: 1)
    }
  }

  private func tabButton(_ value: Tab, label: String) -> some View {
    let selected = tab == value
    return Button {
      tab = value
    } label: {
      Text(label)
        .font(.subheadline.weight(selected ? .semibold : .regular))
        .foregroundStyle(selected ? TetherColors.accent : TetherColors.textSecondary)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .overlay(alignment: .bottom) {
          Rectangle()
            .fill(selected ? TetherColors.accent : Color.clear)
            .frame(height: 2)
        }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

/// Port of `apps/mobile/src/HistoryList.tsx`.
public struct GitHistoryListView: View {
  public var entries: [GitLogEntry]?
  public var onSelect: (GitLogEntry) -> Void

  public init(entries: [GitLogEntry]?, onSelect: @escaping (GitLogEntry) -> Void) {
    self.entries = entries
    self.onSelect = onSelect
  }

  public var body: some View {
    Group {
      if entries == nil {
        ProgressView()
          .tint(TetherColors.accent)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .accessibilityLabel("Loading commits")
      } else if let entries, entries.isEmpty {
        Text("No commits yet")
          .foregroundStyle(TetherColors.textSecondary)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if let entries {
        List(entries) { entry in
          Button {
            onSelect(entry)
          } label: {
            VStack(alignment: .leading, spacing: 2) {
              Text(entry.subject)
                .font(.subheadline)
                .foregroundStyle(TetherColors.textPrimary)
                .lineLimit(1)
              Text("\(entry.shortSha) · \(entry.author) · \(formattedDate(entry.date))")
                .font(.caption.monospaced())
                .foregroundStyle(TetherColors.textSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .listRowBackground(TetherColors.background)
          .accessibilityLabel("Commit \(entry.shortSha): \(entry.subject)")
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(TetherColors.background)
      }
    }
  }

  private func formattedDate(_ iso: String) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) {
      return date.formatted(date: .abbreviated, time: .omitted)
    }
    return iso
  }
}
