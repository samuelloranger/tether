import SwiftUI

/// Every bundled terminal theme, each drawn as a tiny prompt in its own colors.
struct TerminalThemePicker: View {
  @Bindable var preferences: AppPreferences
  @State private var query = ""

  private var themes: [TerminalTheme] {
    let trimmed = query.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return TerminalTheme.catalog }
    return TerminalTheme.catalog.filter { $0.name.localizedCaseInsensitiveContains(trimmed) }
  }

  var body: some View {
    List(themes) { theme in
      Button { preferences.terminalTheme = theme } label: {
        HStack(spacing: 12) {
          TerminalThemeSwatch(theme: theme, fontName: preferences.terminalFont.postScriptName)
          VStack(alignment: .leading, spacing: 2) {
            Text(theme.name).foregroundStyle(TetherColors.textPrimary)
            Text(theme.isLight ? "Light" : "Dark").font(.caption).foregroundStyle(TetherColors.textSecondary)
          }
          Spacer()
          if theme.id == preferences.terminalTheme.id {
            Image(systemName: "checkmark").foregroundStyle(TetherColors.accent).fontWeight(.semibold)
          }
        }
      }
      .accessibilityLabel(theme.name)
      .accessibilityAddTraits(theme.id == preferences.terminalTheme.id ? .isSelected : [])
    }
    .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
    .navigationTitle("Color scheme")
    .navigationBarTitleDisplayMode(.inline)
  }
}

struct TerminalThemeSwatch: View {
  let theme: TerminalTheme
  var fontName: String

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 0) {
        Text("~ ").foregroundStyle(color(theme.ansi[4]))
        Text("git ").foregroundStyle(color(theme.foreground))
        Text("main").foregroundStyle(color(theme.ansi[2]))
      }
      .font(.custom(fontName, size: 11))
      HStack(spacing: 3) {
        ForEach(1..<7, id: \.self) { index in
          Circle().fill(color(theme.ansi[index])).frame(width: 7, height: 7)
        }
      }
    }
    .padding(.horizontal, 8).padding(.vertical, 6)
    .frame(width: 92, alignment: .leading)
    .background(theme.backgroundColor, in: RoundedRectangle(cornerRadius: 6))
    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(TetherColors.border))
    .accessibilityHidden(true)
  }

  private func color(_ argb: UInt32) -> Color { Color(uiColor: TerminalTheme.uiColor(argb)) }
}
