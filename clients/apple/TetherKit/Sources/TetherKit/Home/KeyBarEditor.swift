import SwiftUI

/// Reorder, remove and add the keys above the keyboard, and make macro keys.
struct KeyBarEditor: View {
  @Bindable var preferences: AppPreferences
  @State private var editingMacro: MacroKey?

  var body: some View {
    List {
      Section {
        ForEach(preferences.keyBar.items) { item in
          row(for: item)
        }
        .onMove { preferences.keyBar.items.move(fromOffsets: $0, toOffset: $1) }
        .onDelete { preferences.keyBar.items.remove(atOffsets: $0) }
      } header: {
        Text("In the bar")
      } footer: {
        if preferences.keyBar.items.isEmpty {
          Text("The bar is empty. Add keys below, or reset to the default.")
        }
      }
      Section("Add keys") {
        ForEach(preferences.keyBar.availableKeys) { key in
          Button {
            preferences.keyBar.add(key)
          } label: {
            Label {
              KeyDescription(label: key.label, detail: key.detail)
            } icon: {
              Image(systemName: "plus.circle.fill").foregroundStyle(.green)
            }
          }
          .tint(.primary)
        }
        Button {
          editingMacro = MacroKey(label: "", text: "")
        } label: {
          Label("New macro key…", systemImage: "plus.circle.fill")
        }
      }
      Section {
        Button("Reset to default", role: .destructive) {
          preferences.keyBar = .default
        }
        .disabled(preferences.keyBar == .default)
      }
    }
    .environment(\.editMode, .constant(.active))
    .navigationTitle("Key bar")
    .navigationBarTitleDisplayMode(.inline)
    .sheet(item: $editingMacro) { macro in
      MacroKeyEditor(macro: macro, isNew: !preferences.keyBar.items.contains(.macro(macro))) {
        preferences.keyBar.save($0)
      }
    }
  }

  @ViewBuilder
  private func row(for item: KeyBarItem) -> some View {
    switch item {
    case let .builtIn(key):
      KeyDescription(label: key.label, detail: key.detail)
    case let .macro(macro):
      Button {
        editingMacro = macro
      } label: {
        KeyDescription(label: macro.label, detail: MacroText.visible(MacroText.bytes(from: macro.text)), monospacedDetail: true)
      }
      .tint(.primary)
      .accessibilityHint("Edit macro key")
    }
  }
}

private struct KeyDescription: View {
  var label: String
  var detail: String?
  var monospacedDetail = false

  var body: some View {
    HStack(spacing: 10) {
      Text(label)
      if let detail {
        Text(detail)
          .font(monospacedDetail ? .system(.subheadline, design: .monospaced) : .subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
    }
  }
}

/// Label and text for one macro key, with a live view of the bytes it sends.
private struct MacroKeyEditor: View {
  @Environment(\.dismiss) private var dismiss
  @State var macro: MacroKey
  let isNew: Bool
  let onSave: (MacroKey) -> Void

  private var bytes: String { MacroText.bytes(from: macro.text) }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Label", text: $macro.label)
            .onChange(of: macro.label) { _, label in
              if label.count > MacroKey.maxLabelLength {
                macro.label = String(label.prefix(MacroKey.maxLabelLength))
              }
            }
          TextField("Text to send", text: $macro.text, axis: .vertical)
            .font(.system(.body, design: .monospaced))
        } footer: {
          Text("Labels fit \(MacroKey.maxLabelLength) characters.")
        }
        Section {
          Text(bytes.isEmpty ? " " : MacroText.visible(bytes))
            .font(.system(.body, design: .monospaced))
            .accessibilityLabel(bytes.isEmpty ? "Nothing" : MacroText.visible(bytes))
        } header: {
          Text("Sends")
        } footer: {
          Text(verbatim: "\\n or \\r for Return, \\t Tab, \\e Esc, \\cC for Ctrl-C, \\x1b for any byte, \\\\ for a backslash.")
        }
      }
      .textInputAutocapitalization(.never)
      .autocorrectionDisabled()
      .navigationTitle(isNew ? "New macro key" : "Macro key")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") {
            onSave(macro)
            dismiss()
          }
          .disabled(macro.label.trimmingCharacters(in: .whitespaces).isEmpty || bytes.isEmpty)
        }
      }
    }
  }
}
