import SwiftUI

/// Picks the app font or the chat font; the chat list adds "Same as app".
struct ReadingFontPicker: View {
  @Binding var selection: String
  /// Offered as the first row with an empty id.
  var followsApp: ReadingFont?
  private let fonts = ReadingFont.available

  var body: some View {
    List {
      Group {
        if let followsApp {
          Section { row(id: "", label: "Same as app", font: followsApp, note: followsApp.label) }
        }
        ForEach(ReadingFont.Group.allCases, id: \.self) { group in
          Section(group.rawValue) {
            ForEach(fonts.filter { $0.group == group }) { font in
              row(id: font.id, label: font.label, font: font, note: font.note)
            }
          }
        }
      }
      .themedRow()
    }
    .themedList()
    .navigationTitle(followsApp == nil ? "App font" : "Chat font")
    .navigationBarTitleDisplayMode(.inline)
  }

  private func row(id: String, label: String, font: ReadingFont, note: String?) -> some View {
    Button { selection = id } label: {
      HStack {
        VStack(alignment: .leading, spacing: 2) {
          Text(label).font(font.font(.body)).foregroundStyle(TetherColors.textPrimary)
          if let note { Text(note).font(font.font(.caption)).foregroundStyle(TetherColors.textSecondary) }
        }
        Spacer()
        if id == selection {
          Image(systemName: "checkmark").foregroundStyle(TetherColors.accent).fontWeight(.semibold)
        }
      }
    }
    .accessibilityLabel(label)
    .accessibilityAddTraits(id == selection ? .isSelected : [])
  }
}
