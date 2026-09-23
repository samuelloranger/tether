import SwiftUI

/// Terminal appearance settings — theme, font, size — bound to AppPreferences.
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
          Picker("Font", selection: $preferences.terminalFont) {
            ForEach(AppPreferences.TerminalFont.allCases) { Text($0.label).tag($0) }
          }
          Stepper(value: $preferences.terminalFontSize, in: 8...24, step: 1) {
            HStack {
              Text("Size")
              Spacer()
              Text("\(Int(preferences.terminalFontSize)) pt").foregroundStyle(.secondary)
                .font(.system(.body, design: .monospaced))
            }
          }
          HStack {
            Text("Preview").foregroundStyle(.secondary)
            Spacer()
            Text("samuelloranger@homelab")
              .font(.custom(preferences.terminalFont.postScriptName, size: preferences.terminalFontSize))
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
