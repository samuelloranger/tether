import SwiftUI

/// Built-in faces, downloaded Google Fonts families, and a field to fetch another.
struct TerminalFontPicker: View {
  @Bindable var preferences: AppPreferences
  @State private var link = ""
  @State private var downloading: String?
  @State private var failure: String?
  @FocusState private var linkFocused: Bool

  private var suggestions: [String] {
    let have = Set(preferences.downloadedFonts.map(\.family))
    return GoogleFonts.suggestions.filter { !have.contains($0) }
  }

  var body: some View {
    List {
      Section("Built in") {
        ForEach(TerminalFont.builtIn) { row($0) }
      }
      if !preferences.downloadedFonts.isEmpty {
        Section("Downloaded") {
          ForEach(preferences.downloadedFonts) { font in
            row(font.terminalFont, proportional: !font.isMonospaced)
          }
          .onDelete { offsets in
            for index in offsets { preferences.removeDownloadedFont(preferences.downloadedFonts[index]) }
          }
        }
      }
      Section {
        HStack {
          TextField("fonts.google.com link or family name", text: $link)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.URL)
            .submitLabel(.go)
            .focused($linkFocused)
            .onSubmit { download(link) }
            .accessibilityIdentifier("googleFontLink")
          if downloading != nil {
            ProgressView()
          } else {
            Button("Add") { download(link) }
              .disabled(GoogleFonts.family(from: link) == nil)
          }
        }
        if let failure {
          Label(failure, systemImage: "exclamationmark.triangle").font(.footnote)
            .foregroundStyle(TetherColors.danger)
        }
      } header: {
        Text("Add from Google Fonts")
      } footer: {
        Text("Paste a family’s page from fonts.google.com. Tether downloads its regular and bold faces from Google.")
      }
      if !suggestions.isEmpty {
        Section("Monospace families on Google Fonts") {
          ForEach(suggestions, id: \.self) { family in
            Button { download(family) } label: {
              HStack {
                Text(family).foregroundStyle(TetherColors.textPrimary)
                Spacer()
                if downloading == family { ProgressView() } else {
                  Image(systemName: "arrow.down.circle").foregroundStyle(TetherColors.accent)
                }
              }
            }
            .disabled(downloading != nil)
          }
        }
      }
    }
    .navigationTitle("Font")
    .navigationBarTitleDisplayMode(.inline)
  }

  private func row(_ font: TerminalFont, proportional: Bool = false) -> some View {
    Button { preferences.terminalFontID = font.id } label: {
      HStack {
        VStack(alignment: .leading, spacing: 2) {
          Text(font.label).font(.custom(font.postScriptName, size: 17)).foregroundStyle(TetherColors.textPrimary)
          if proportional {
            Text("Proportional — letters are spaced to the grid").font(.caption)
              .foregroundStyle(TetherColors.textSecondary)
          }
        }
        Spacer()
        if font.id == preferences.terminalFontID {
          Image(systemName: "checkmark").foregroundStyle(TetherColors.accent).fontWeight(.semibold)
        }
      }
    }
    .accessibilityLabel(font.label)
    .accessibilityAddTraits(font.id == preferences.terminalFontID ? .isSelected : [])
  }

  private func download(_ input: String) {
    guard downloading == nil, let family = GoogleFonts.family(from: input) else {
      failure = GoogleFontsError.notALink.errorDescription
      return
    }
    downloading = family
    failure = nil
    linkFocused = false
    Task {
      do {
        try await preferences.downloadFont(input)
        link = ""
      } catch {
        failure = error.localizedDescription
      }
      downloading = nil
    }
  }
}
