import SwiftUI

struct ChatFolderPicker: View {
  @Binding var folder: String
  @Binding var folderInfo: ChatFolder?
  @Binding var checkingFolder: Bool
  @Binding var creatingFolder: Bool
  @Binding var browsing: Bool
  var focused: FocusState<Bool>.Binding
  var disabled: Bool
  var hostName = ""
  let checkFolder: (String, Bool) async -> ChatFolder
  let onSubmit: () -> Void
  @State private var folderReloads = 0
  @State private var home = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(hostName.isEmpty ? "Working folder on the host" : "Folder on \(hostName)")
        .font(.caption).foregroundStyle(TetherColors.textSecondary)
      HStack(spacing: 8) {
        Image(systemName: "folder").foregroundStyle(TetherColors.textFaint).accessibilityHidden(true)
        TextField("Folder on the host", text: $folder)
          .font(.callout.monospaced()).foregroundStyle(TetherColors.textPrimary)
          .textInputAutocapitalization(.never).autocorrectionDisabled()
          .focused(focused).submitLabel(.go).onSubmit(onSubmit)
          .accessibilityLabel("Working folder for the new chat")
          .accessibilityIdentifier("sshNewChatFolder")
        Button {
          focused.wrappedValue = false
          browsing = true
        } label: {
          Image(systemName: "folder.badge.gearshape").frame(minWidth: 44, minHeight: 44)
        }
        .buttonStyle(.plain).foregroundStyle(TetherColors.accent)
        .accessibilityLabel("Choose folder")
        .accessibilityIdentifier("sshNewChatBrowse")
      }
      .padding(.leading, 10)
      .background(TetherColors.input, in: RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TetherColors.border))
      .disabled(disabled || creatingFolder)
      HStack(spacing: 8) {
        if checkingFolder || creatingFolder {
          ProgressView().controlSize(.small)
          Text(creatingFolder ? "Creating folder…" : "Checking folder…")
        } else if let info = folderInfo {
          if let message = info.message {
            Text(message).foregroundStyle(TetherColors.warning)
          } else {
            Label("Folder ready", systemImage: "checkmark.circle").foregroundStyle(TetherColors.textSecondary)
          }
          if info.missing {
            Button("Create folder", action: createFolder)
              .frame(minHeight: 44).disabled(disabled)
              .accessibilityIdentifier("sshNewChatCreateFolder")
          } else if !info.ready {
            Button("Retry") { folderReloads += 1 }.frame(minHeight: 44).disabled(disabled)
          }
        }
      }
      .font(.caption).fixedSize(horizontal: false, vertical: true)
      .accessibilityElement(children: .contain)
    }
    .task {
      let info = await checkFolder("~", false)
      guard !Task.isCancelled, info.ready else { return }
      home = info.path
      // Only the prefilled path is shortened: rewriting typed text would turn "/home/dev" into "~" mid-word.
      if !focused.wrappedValue { folder = ChatFolders.abbreviated(folder, home: home) }
    }
    .task(id: "\(folder)|\(folderReloads)") { await inspectFolder() }
    .onChange(of: folder) { _, _ in folderInfo = nil; checkingFolder = true }
    .sheet(isPresented: $browsing) {
      ChatFolderBrowser(initialFolder: folderInfo?.path ?? folder, home: home, hostName: hostName,
        checkFolder: checkFolder) { info in
          folder = ChatFolders.abbreviated(info.path, home: home)
          folderInfo = info
          browsing = false
        }
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

private struct ChatFolderBrowser: View {
  let initialFolder: String
  let home: String
  let hostName: String
  let checkFolder: (String, Bool) async -> ChatFolder
  let onUse: (ChatFolder) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var location = ""
  @State private var info: ChatFolder?
  @State private var loading = true
  @State private var reloads = 0
  @State private var filter = ""
  @State private var naming = false
  @State private var name = ""
  @State private var creating = false
  @State private var createError: String?
  @FocusState private var nameFocused: Bool

  private var locked: Bool { naming || creating }

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 12) {
        if !hostName.isEmpty {
          Text("On \(hostName)").font(.caption).foregroundStyle(TetherColors.textSecondary)
        }
        ScrollView(.horizontal) {
          HStack(spacing: 4) {
            ForEach(ChatFolders.breadcrumbs(info?.path ?? location), id: \.self) { path in
              if path != "/" { Image(systemName: "chevron.right").font(.caption2).accessibilityHidden(true) }
              Button(path == "/" ? "/" : (path as NSString).lastPathComponent) { navigate(path) }
                .font(.subheadline).frame(minHeight: 44).disabled(locked || loading)
                .accessibilityLabel(path)
            }
          }
        }
        .scrollIndicators(.hidden)
        HStack {
          Image(systemName: "magnifyingglass").foregroundStyle(TetherColors.textFaint)
          TextField("Filter folders", text: $filter)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .accessibilityIdentifier("sshFolderFilter")
        }
        .padding(.horizontal, 10).frame(minHeight: 44)
        .background(TetherColors.input, in: RoundedRectangle(cornerRadius: 10))
        if naming { nameEntry }
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 0) {
            if loading {
              ProgressView("Loading folders…").frame(maxWidth: .infinity, minHeight: 44)
            } else if let info {
              if let message = info.message {
                Text(message).font(.callout).foregroundStyle(TetherColors.warning)
                Button("Retry") { reloads += 1 }.frame(minHeight: 44).disabled(locked)
              }
              if info.path != "/", info.path.hasPrefix("/") {
                directoryRow("Parent folder", icon: "arrow.up", path: info.parent)
              }
              let children = ChatFolders.matchingChildren(info.children, filter: filter)
              ForEach(children, id: \.self) { path in
                directoryRow((path as NSString).lastPathComponent, icon: "folder", path: path)
              }
              if children.isEmpty, info.ready {
                Text(filter.isEmpty ? "No subfolders in this folder." : "No matching folders.")
                  .font(.callout).foregroundStyle(TetherColors.textSecondary).padding(.vertical, 12)
              }
              if info.children.count >= 200 {
                Text("First 200 folders shown.").font(.caption).foregroundStyle(TetherColors.textSecondary)
              }
            }
          }
        }
        .scrollDismissesKeyboard(.interactively)
      }
      .padding(.horizontal, 16)
      .background(TetherColors.background.ignoresSafeArea())
      .safeAreaInset(edge: .bottom) { footer }
      .navigationTitle("Choose folder").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button { dismiss() } label: { Label("Back", systemImage: "chevron.backward") }
            .disabled(creating)
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            naming = true; name = ""; createError = nil; nameFocused = true
          } label: { Label("New folder", systemImage: "folder.badge.plus") }
            .disabled(locked || loading || info?.ready != true)
            .accessibilityIdentifier("sshFolderNew")
        }
      }
    }
    .tint(TetherColors.accent)
    .interactiveDismissDisabled(creating)
    .task(id: "\(location)|\(reloads)") { await load() }
  }

  private var nameEntry: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text("New folder name").font(.caption).foregroundStyle(TetherColors.textSecondary)
      TextField("Folder name", text: $name)
        .textInputAutocapitalization(.never).autocorrectionDisabled().focused($nameFocused)
        .padding(10).background(TetherColors.input, in: RoundedRectangle(cornerRadius: 8))
        .disabled(creating).submitLabel(.done).onSubmit(createChild)
        .accessibilityIdentifier("sshFolderName")
      if let createError { Text(createError).font(.caption).foregroundStyle(TetherColors.warning) }
      HStack {
        Spacer()
        Button("Cancel") { naming = false; createError = nil }.disabled(creating)
        Button(creating ? "Creating…" : "Create", action: createChild)
          .disabled(creating || ChatFolders.childPath(name: name, parent: info?.path ?? "") == nil)
      }
      .buttonStyle(.plain).foregroundStyle(TetherColors.accent).frame(minHeight: 44)
    }
  }

  private var footer: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(ChatFolders.abbreviated(info?.path ?? location, home: home))
        .font(.caption.monospaced()).foregroundStyle(TetherColors.textSecondary)
        .lineLimit(2).truncationMode(.middle)
      Button {
        guard let info, info.ready, !locked, !loading else { return }
        onUse(info)
      } label: {
        Text("Use this folder").font(.subheadline.weight(.semibold))
          .frame(maxWidth: .infinity, minHeight: 44)
          .foregroundStyle(TetherColors.onAccent)
          .background(TetherColors.accent, in: RoundedRectangle(cornerRadius: 10))
      }
      .buttonStyle(.plain)
      .disabled(locked || loading || info?.ready != true)
      .opacity(locked || loading || info?.ready != true ? 0.45 : 1)
      .accessibilityIdentifier("sshFolderUse")
    }
    .padding(16).background(TetherColors.background)
  }

  private func directoryRow(_ title: String, icon: String, path: String) -> some View {
    Button { navigate(path) } label: {
      HStack(spacing: 10) {
        Image(systemName: icon).foregroundStyle(TetherColors.textSecondary)
        Text(title).foregroundStyle(TetherColors.textPrimary).multilineTextAlignment(.leading)
        Spacer()
        Image(systemName: "chevron.right").font(.caption).foregroundStyle(TetherColors.textFaint)
      }
      .frame(minHeight: 44).contentShape(Rectangle())
    }
    .buttonStyle(.plain).disabled(locked || loading).accessibilityLabel(path)
  }

  private func navigate(_ path: String) {
    guard !locked, !loading else { return }
    location = path; filter = ""; info = nil; loading = true
  }

  private func load() async {
    let wanted = location
    loading = true
    var result = await checkFolder(wanted.isEmpty ? initialFolder : wanted, false)
    // Missing typed paths open at their nearest usable ancestor without changing the form.
    if wanted.isEmpty {
      while !result.ready, result.path.hasPrefix("/"), result.path != "/", result.status != "" {
        guard !Task.isCancelled else { return }
        result = await checkFolder(result.parent, false)
      }
    }
    guard !Task.isCancelled, location == wanted else { return }
    info = result; loading = false
  }

  private func createChild() {
    guard !creating, let parent = info, parent.ready,
      let path = ChatFolders.childPath(name: name, parent: parent.path) else { return }
    creating = true
    createError = nil
    nameFocused = false
    Task {
      let result = await checkFolder(path, true)
      creating = false
      guard result.ready else { createError = result.message; return }
      naming = false; name = ""; filter = ""
      location = result.path; info = result
    }
  }
}
