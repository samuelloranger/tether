import SwiftUI

/// Terminal appearance settings bound to AppPreferences.
struct TerminalSettingsSheet: View {
  @Bindable var preferences: AppPreferences
  var onDone: () -> Void
  @State private var appIcon = AppIconChoice.primary

  var body: some View {
    NavigationStack {
      Form {
        Section("Appearance") {
          Picker("Theme", selection: $preferences.colorSchemePreference) {
            ForEach(AppPreferences.ColorSchemePreference.allCases) { Text($0.label).tag($0) }
          }
          .pickerStyle(.segmented)
          NavigationLink {
            AppIconPicker(current: $appIcon)
          } label: {
            HStack {
              Text("App icon")
              Spacer()
              Text(appIcon.name).foregroundStyle(.secondary)
            }
          }
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
          Picker("Cursor", selection: $preferences.cursorShape) {
            ForEach(TerminalCursorStyle.Shape.allCases) { Text($0.label).tag($0) }
          }
          Toggle("Blink cursor", isOn: $preferences.cursorBlink)
          HStack {
            Text("Preview").foregroundStyle(.secondary)
            Spacer()
            TerminalSettingsPreview(preferences: preferences)
          }
        }
        Section {
          NavigationLink {
            KeyBarEditor(preferences: preferences)
          } label: {
            HStack {
              Text("Key bar")
              Spacer()
              Text("\(preferences.keyBar.items.count) keys").foregroundStyle(.secondary)
            }
          }
          Picker("Key size", selection: $preferences.compactKeys) {
            Text("Regular").tag(false)
            Text("Compact").tag(true)
          }
          Picker("Bell", selection: $preferences.bellMode) {
            ForEach(BellMode.allCases) { Text($0.label).tag($0) }
          }
        } header: {
          Text("Keyboard")
        } footer: {
          Text("The bell is what a program rings when it wants your attention. Only the session on screen rings.")
        }
      }
      .onAppear { appIcon = .current(alternateName: UIApplication.shared.alternateIconName) }
      .navigationTitle("Settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done", action: onDone) } }
    }
    .tint(TetherColors.accent)
  }
}

/// A few lines in the chosen font, colours, spacing, padding and cursor.
struct TerminalSettingsPreview: View {
  var preferences: AppPreferences

  var body: some View {
    let font = TerminalFonts.font(
      postScriptName: preferences.terminalFont.postScriptName,
      size: preferences.terminalFontSize,
      bold: false
    )
    let theme = preferences.terminalTheme
    let cell = CGRect(
      x: 0, y: 0,
      width: ("M" as NSString).size(withAttributes: [.font: font]).width,
      height: font.lineHeight
    )
    let cursor = preferences.terminalCursorStyle.frame(inCell: cell)
    VStack(alignment: .leading, spacing: font.lineHeight * (preferences.terminalLineSpacing - 1)) {
      Text("me@devbox ~ $ ls")
      Text("src  README.md")
      HStack(spacing: 0) {
        Text("me@devbox ~ $ ")
        Color(uiColor: TerminalTheme.uiColor(theme.cursor, alpha: preferences.cursorShape == .block ? 0.4 : 1))
          .frame(width: cursor.width, height: cursor.height)
          .frame(width: cell.width, height: cell.height, alignment: preferences.cursorShape == .underline ? .bottomLeading : .topLeading)
          .accessibilityHidden(true)
      }
    }
    .font(Font(font))
    .foregroundStyle(Color(uiColor: TerminalTheme.uiColor(theme.foreground)))
    .padding(.horizontal, preferences.terminalPadding).padding(.vertical, 4)
    .background(theme.backgroundColor, in: RoundedRectangle(cornerRadius: 6))
  }
}
