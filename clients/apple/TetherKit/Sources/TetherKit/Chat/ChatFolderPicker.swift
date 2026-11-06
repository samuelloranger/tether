import SwiftUI

struct ChatFolderPicker: View {
  @Binding var folder: String
  @Binding var folderInfo: ChatFolder?
  @Binding var checkingFolder: Bool
  @Binding var creatingFolder: Bool
  @Binding var browsing: Bool
  var focused: FocusState<Bool>.Binding
  var disabled: Bool
  let checkFolder: (String, Bool) async -> ChatFolder
  let onSubmit: () -> Void
  @State private var folderReloads = 0

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Working folder on the host").font(.caption).foregroundStyle(TetherColors.textSecondary)
      TextField("Folder on the host", text: $folder)
        .font(.callout.monospaced()).foregroundStyle(TetherColors.textPrimary)
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .focused(focused).submitLabel(.go).onSubmit(onSubmit)
        .padding(10).background(TetherColors.input, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TetherColors.border))
        .accessibilityLabel("Working folder for the new chat")
        .accessibilityIdentifier("sshNewChatFolder")
        .disabled(disabled || creatingFolder)
      folderControls
    }
    .task(id: "\(folder)|\(folderReloads)") { await inspectFolder() }
    .onChange(of: folder) { _, _ in folderInfo = nil; checkingFolder = true }
  }

  private var folderControls: some View {
    VStack(alignment: .leading, spacing: 6) {
      ViewThatFits(in: .horizontal) {
        HStack {
          browseButton
          createButton
          Spacer(minLength: 0)
          if checkingFolder { ProgressView().accessibilityLabel("Checking folder") }
        }
        VStack(alignment: .leading, spacing: 4) {
          browseButton
          createButton
          if checkingFolder { ProgressView().accessibilityLabel("Checking folder") }
        }
      }
      .font(.subheadline)
      .buttonStyle(.bordered)
      .disabled(disabled || creatingFolder)
      if let message = folderInfo?.message, !checkingFolder {
        Text(message).font(.caption).foregroundStyle(TetherColors.warning)
          .fixedSize(horizontal: false, vertical: true)
      }
      if browsing || (focused.wrappedValue && !(folderInfo?.children.isEmpty ?? true)) {
        if browsing {
          Button { folder = folderInfo?.parent ?? "~" } label: {
            Label("Parent folder", systemImage: "arrow.up")
              .frame(minHeight: 44)
          }
          .disabled(checkingFolder || disabled || creatingFolder)
        }
        if let info = folderInfo {
          if info.children.isEmpty && !checkingFolder {
            Text("No matching subfolders").font(.caption).foregroundStyle(TetherColors.textSecondary)
          }
          ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
              ForEach(info.children, id: \.self) { path in
                Button { folder = path } label: {
                  Label((path as NSString).lastPathComponent, systemImage: "folder")
                    .font(.callout).lineLimit(2).multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(path)
                .foregroundStyle(TetherColors.textPrimary)
              }
            }
          }
          .frame(maxHeight: 132)
          .disabled(disabled || creatingFolder)
          if info.children.count >= 200 {
            Text("First 200 folders shown. Type to narrow the list.")
              .font(.caption).foregroundStyle(TetherColors.textSecondary)
          }
        }
      }
    }
  }

  private var browseButton: some View {
    Button {
      browsing.toggle()
      focused.wrappedValue = false
      folderReloads += 1
    } label: {
      Text(browsing ? "Hide folders" : "Browse folders").frame(minHeight: 44)
    }
    .accessibilityIdentifier("sshNewChatBrowse")
  }

  @ViewBuilder private var createButton: some View {
    if folderInfo?.missing == true {
      Button(action: createFolder) {
        Text(creatingFolder ? "Creating…" : "Create folder").frame(minHeight: 44)
      }
      .accessibilityIdentifier("sshNewChatCreateFolder")
    }
  }

  private func inspectFolder() async {
    let text = folder
    checkingFolder = true
    do { try await Task.sleep(for: .milliseconds(350)) } catch { return }
    let info = await checkFolder(text, false)
    guard !Task.isCancelled, folder == text, !creatingFolder else { return }
    folderInfo = info
    checkingFolder = false
  }

  private func createFolder() {
    guard folderInfo?.missing == true, !creatingFolder, !disabled else { return }
    let text = folder
    creatingFolder = true
    Task {
      let info = await checkFolder(text, true)
      guard folder == text else { creatingFolder = false; return }
      folderInfo = info
      checkingFolder = false
      creatingFolder = false
      folderReloads += 1
    }
  }
}
