import SwiftUI

/// Terminal appearance settings bound to AppPreferences.
struct TerminalSettingsSheet: View {
  @Bindable var preferences: AppPreferences
  var onDone: () -> Void

  var body: some View {
    NavigationStack {
      Form {
        Section("Appearance") {
          Picker("Theme", selection: $preferences.colorSchemePreference) {
            ForEach(AppPreferences.ColorSchemePreference.allCases) { Text($0.label).tag($0) }
          }
          .pickerStyle(.segmented)
        }
        Section("Terminal") {
          NavigationLink {
            TerminalThemePicker(preferences: preferences)
          } label: {
            HStack {
              Text("Color scheme")
              Spacer()
              Text(preferences.terminalTheme.name).foregroundStyle(.secondary)
            }
          }
          NavigationLink {
            TerminalFontPicker(preferences: preferences)
          } label: {
            HStack {
              Text("Font")
              Spacer()
              Text(preferences.terminalFont.label).foregroundStyle(.secondary)
            }
          }
          Stepper(value: $preferences.terminalFontSize, in: 8...24, step: 1) {
            HStack {
              Text("Size")
              Spacer()
              Text("\(Int(preferences.terminalFontSize)) pt").foregroundStyle(.secondary)
                .font(.system(.body, design: .monospaced))
            }
          }
          VStack(alignment: .leading, spacing: 6) {
            HStack {
              Text("Line spacing")
              Spacer()
              Text(String(format: "%.2f×", preferences.terminalLineSpacing))
                .foregroundStyle(.secondary)
                .font(.system(.body, design: .monospaced))
            }
            Slider(value: $preferences.terminalLineSpacing, in: TerminalLineSpacing.range, step: 0.05)
              .accessibilityLabel("Line spacing")
          }
          Stepper(value: $preferences.terminalPadding, in: TerminalGridInset.paddingRange, step: 2) {
            HStack {
              Text("Padding")
              Spacer()
              Text("\(Int(preferences.terminalPadding)) pt").foregroundStyle(.secondary)
                .font(.system(.body, design: .monospaced))
            }
          }
          HStack {
            Text("Preview").foregroundStyle(.secondary)
            Spacer()
            TerminalSettingsPreview(preferences: preferences)
          }
        }
      }
      .navigationTitle("Settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done", action: onDone) } }
    }
    .tint(TetherColors.accent)
  }
}

/// A few lines in the chosen font, colours, spacing and padding.
struct TerminalSettingsPreview: View {
  var preferences: AppPreferences

  var body: some View {
    let font = TerminalFonts.font(
      postScriptName: preferences.terminalFont.postScriptName,
      size: preferences.terminalFontSize,
      bold: false
    )
    Text("me@devbox ~ $ ls\nsrc  README.md")
      .font(Font(font))
      .lineSpacing(font.lineHeight * (preferences.terminalLineSpacing - 1))
      .foregroundStyle(Color(uiColor: TerminalTheme.uiColor(preferences.terminalTheme.foreground)))
      .padding(.horizontal, preferences.terminalPadding).padding(.vertical, 4)
      .background(preferences.terminalTheme.backgroundColor, in: RoundedRectangle(cornerRadius: 6))
  }
}
