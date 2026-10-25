import SwiftUI

/// A document-style transcript: the agent's prose at full width, everything else quiet.
struct ChatView: View {
  @Bindable var model: ChatSessionModel

  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.dismiss) private var dismiss
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var draft = ""
  @State private var expanded: Set<Int> = []
  @State private var userScrolledUp = false
  @State private var bottomEdge: CGFloat = 0
  @State private var viewportHeight: CGFloat = 0
  @State private var reviewing: ChatPermission?

  private let bottomID = "chat-bottom"
  private static let space = "chat-scroll"

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 14) {
          if model.state.items.isEmpty { emptyState }
          ForEach(visibleItems) { item in
            ChatItemRow(item: item, cwd: model.cwd, expanded: expanded.contains(item.id)) {
              withAnimation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion)) {
                if expanded.contains(item.id) { expanded.remove(item.id) } else { expanded.insert(item.id) }
              }
            }
            .equatable()
          }
          ForEach(model.outbox.failed) { message in
            FailedMessageRow(
              message: message, canRetry: model.canSend,
              retry: { model.retry(message.id) }, discard: { model.discard(message.id) })
          }
          if model.state.turn == .working && model.state.pendingPermissions.isEmpty { WorkingIndicator() }
          Color.clear.frame(height: 1).id(bottomID)
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(Self.space)).maxY } action: { bottomEdge = $0 }
            .onDisappear { bottomEdge = .infinity }
        }
        .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 16)
      }
      .coordinateSpace(name: Self.space)
      .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewportHeight = $0 }
      .defaultScrollAnchor(.bottom)
      .scrollDismissesKeyboard(.interactively)
      .simultaneousGesture(
        DragGesture(minimumDistance: 14).onChanged { drag in
          if drag.translation.height > 24, !nearBottom { userScrolledUp = true }
        })
      .onChange(of: bottomEdge) { _, _ in if nearBottom { userScrolledUp = false } }
      .onChange(of: model.state.tailSignature) { _, _ in
        if !userScrolledUp { proxy.scrollTo(bottomID, anchor: .bottom) }
      }
      .overlay(alignment: .bottomTrailing) {
        if userScrolledUp {
          Button {
            userScrolledUp = false
            withAnimation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion)) {
              proxy.scrollTo(bottomID, anchor: .bottom)
            }
          } label: {
            Label("Jump to latest", systemImage: "arrow.down")
              .font(.caption.weight(.semibold))
              .tetherPill()
          }
          .buttonStyle(TetherPressStyle())
          .padding(.trailing, 14).padding(.bottom, 10)
          .transition(.opacity)
        }
      }
      .animation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion), value: userScrolledUp)
    }
    .background(TetherColors.background.ignoresSafeArea())
    .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
    .navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(TetherColors.background, for: .navigationBar)
    .toolbarBackground(.visible, for: .navigationBar)
    .navigationBarBackButtonHidden(true)
    .overlay(alignment: .top) { contextHairline }
    .toolbar {
      ToolbarItem(placement: .topBarLeading) { backButton }
      ToolbarItem(placement: .principal) { titleBlock }
      ToolbarItem(placement: .topBarTrailing) { connectionBadge }
    }
    .task { await model.connect() }
    .onChange(of: scenePhase) { _, phase in
      switch phase {
      case .active: model.sceneBecameActive()
      case .background: model.sceneEnteredBackground()
      default: break
      }
    }
    .onDisappear { model.leave() }
    .sensoryFeedback(.impact(weight: .light), trigger: model.state.pendingPermissions.first?.requestId)
    .sheet(item: Binding(get: { reviewing }, set: { reviewing = $0 })) { permission in
      PermissionReviewSheet(permission: permission, cwd: model.cwd)
    }
  }

  /// An unanswered permission lives in the card, not in the scroll.
  private var visibleItems: [ChatItem] {
    model.state.items.filter {
      if case let .permission(permission) = $0.kind { return permission.resolvedOptionId != nil }
      return true
    }
  }

  private var nearBottom: Bool { bottomEdge <= viewportHeight + 48 }

  private var emptyState: some View {
    VStack(spacing: 8) {
      Image(systemName: "text.bubble").font(.title).foregroundStyle(TetherColors.textFaint)
      Text(model.readOnly ? "Nothing here yet" : "Ask the agent anything")
        .font(.subheadline).foregroundStyle(TetherColors.textSecondary)
      Text(model.cwd).font(.caption.monospaced()).foregroundStyle(TetherColors.textFaint)
        .lineLimit(1).truncationMode(.head)
    }
    .frame(maxWidth: .infinity)
    .padding(.top, 80)
    .accessibilityElement(children: .combine)
  }

  // MARK: Header

  private var backButton: some View {
    Button { dismiss() } label: {
      Image(systemName: "chevron.backward")
        .font(.system(size: 28, weight: .regular))
        .foregroundStyle(TetherColors.accent)
        .frame(width: 44, height: 44, alignment: .leading)
        .contentShape(Rectangle())
    }
    .accessibilityLabel("Chats")
    .accessibilityIdentifier("chatBack")
  }

  private var titleBlock: some View {
    VStack(spacing: 1) {
      Text(model.title).font(.headline).foregroundStyle(TetherColors.textPrimary).lineLimit(1)
      Text(ChatFormat.folderName(model.cwd)).font(.caption).foregroundStyle(TetherColors.textFaint)
        .lineLimit(1)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(model.title), \(model.cwd)")
  }

  /// Context usage as a 3pt line under the header instead of a third fact in the subtitle.
  @ViewBuilder private var contextHairline: some View {
    if let fraction = ChatFormat.contextFraction(used: model.state.contextUsed, size: model.state.contextSize) {
      Rectangle().fill(TetherColors.border).frame(height: 3)
        .overlay(alignment: .leading) {
          GeometryReader { proxy in
            Rectangle().fill(TetherColors.accent).frame(width: proxy.size.width * fraction)
          }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Context used")
        .accessibilityValue(
          ChatFormat.contextSummary(used: model.state.contextUsed, size: model.state.contextSize) ?? "")
    }
  }

  @ViewBuilder private var connectionBadge: some View {
    switch model.link.phase {
    case .lost:
      Button { model.reconnect() } label: {
        Label("Reconnect", systemImage: "arrow.clockwise").font(.caption.weight(.semibold))
          .frame(height: 24).hitSlop(vertical: 10)
      }
      .accessibilityHint("The connection to the host was lost")
    case .connecting, .catchingUp:
      badge(color: TetherColors.warning, text: model.link.phase == .connecting ? "Connecting" : "Catching up")
    case .live:
      badge(color: TetherColors.success, text: "Live")
    }
  }

  private func badge(color: Color, text: String) -> some View {
    HStack(spacing: 5) {
      Circle().fill(color).frame(width: 6, height: 6)
      Text(text).font(.caption2.weight(.semibold)).foregroundStyle(TetherColors.textSecondary)
    }
    .padding(.horizontal, 9)
    .frame(height: 24)
    .background(color.opacity(0.14), in: Capsule())
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Connection: \(text)")
  }

  // MARK: Bottom bar

  private var bottomBar: some View {
    VStack(spacing: 10) {
      if let notice = model.notice {
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: "exclamationmark.triangle").foregroundStyle(TetherColors.warning)
          Text(notice).font(.footnote).foregroundStyle(TetherColors.textSecondary)
          Spacer(minLength: 0)
          Button { model.notice = nil } label: { Image(systemName: "xmark") }
            .font(.caption.weight(.semibold)).foregroundStyle(TetherColors.textFaint)
            .accessibilityLabel("Dismiss")
        }
        .padding(10)
        .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 12))
      }
      if let permission = model.state.pendingPermissions.first, !model.readOnly {
        PermissionCard(
          permission: permission, cwd: model.cwd,
          position: model.state.pendingPermissions.count > 1 ? "1 of \(model.state.pendingPermissions.count)" : nil,
          enabled: model.canInteract,
          approve: { model.approve(permission, option: $0) },
          review: { reviewing = permission })
          .transition(.move(edge: .bottom).combined(with: .opacity))
      }
      if model.readOnly {
        Label("Started on another device. Read only.", systemImage: "eye")
          .font(.footnote).foregroundStyle(TetherColors.textSecondary)
          .frame(maxWidth: .infinity).padding(.vertical, 6)
      } else {
        composer
      }
    }
    .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 8)
    .background(TetherColors.background.opacity(0.96))
    .overlay(alignment: .top) { Rectangle().fill(TetherColors.border).frame(height: 0.5) }
    .animation(TetherMotion.ui(TetherMotion.overlay, reduceMotion: reduceMotion), value: model.state.pendingPermissions.first?.requestId)
  }

  private var composer: some View {
    VStack(alignment: .leading, spacing: 6) {
      if model.link.phase == .catchingUp || model.link.phase == .connecting {
        HStack(spacing: 6) {
          ProgressView().controlSize(.mini).tint(TetherColors.textFaint)
          Text("Catching up…").font(.caption).foregroundStyle(TetherColors.textFaint)
        }
        .padding(.leading, 6)
      }
      HStack(alignment: .bottom, spacing: 8) {
        TextField("Message the agent", text: $draft, axis: .vertical)
          .lineLimit(1...6)
          .font(.body)
          .padding(.horizontal, 14).padding(.vertical, 10)
          .background(TetherColors.input, in: RoundedRectangle(cornerRadius: 20))
          .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(TetherColors.border))
          .accessibilityIdentifier("chatComposer")
        actionButton
      }
    }
  }

  private var working: Bool { model.state.turn == .working }
  private var draftIsEmpty: Bool { draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

  private var actionButton: some View {
    Button {
      if working {
        model.cancel()
      } else if model.send(draft) {
        draft = ""
        userScrolledUp = false
      }
    } label: {
      Image(systemName: working ? "stop.fill" : "arrow.up")
        .font(.body.weight(.bold))
        .frame(width: 38, height: 38)
        .foregroundStyle(TetherColors.onAccent)
        .background(working ? TetherColors.textPrimary.opacity(0.85) : TetherColors.accent, in: Circle())
        .opacity(working || (!draftIsEmpty && model.canSend) ? 1 : 0.35)
    }
    .buttonStyle(TetherPressStyle())
    .disabled(working ? !model.canInteract : (draftIsEmpty || !model.canSend))
    .accessibilityLabel(working ? "Stop" : "Send")
    .accessibilityIdentifier("chatAction")
  }
}

/// Pinned above the composer so an approval is never lost in the scroll.
struct PermissionCard: View {
  let permission: ChatPermission
  let cwd: String
  let position: String?
  let enabled: Bool
  let approve: (ACPPermissionOption) -> Void
  let review: () -> Void

  @Environment(\.dynamicTypeSize) private var dynamicTypeSize

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Image(systemName: permission.kind.symbolName).foregroundStyle(TetherColors.accent)
        VStack(alignment: .leading, spacing: 1) {
          Text("PERMISSION").font(.caption2.weight(.bold)).tracking(0.8).foregroundStyle(TetherColors.textFaint)
          Text(permission.title).font(.subheadline.weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
            .lineLimit(2)
        }
        Spacer(minLength: 0)
        if let position {
          Text(position).font(.caption2.weight(.semibold).monospaced()).foregroundStyle(TetherColors.textFaint)
        }
      }
      preview
      VStack(spacing: 8) {
        ForEach(Array(ChatPermissionOptions.ordered(permission.options).enumerated()), id: \.offset) { _, entry in
          optionButton(entry.option, role: entry.role)
        }
      }
    }
    .padding(14)
    .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 18))
    .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(TetherColors.accent.opacity(0.45)))
    .shadow(color: .black.opacity(0.18), radius: 10, y: 3)
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder private var preview: some View {
    if let diff = permission.diff {
      let file = ACPDiffAdapter.file(for: diff, relativeTo: cwd)
      Button(action: review) {
        VStack(alignment: .leading, spacing: 0) {
          HStack(spacing: 8) {
            Text(file.path).font(.caption.monospaced()).lineLimit(1).truncationMode(.head)
              .foregroundStyle(TetherColors.textPrimary)
            Spacer(minLength: 6)
            if file.added > 0 { Text("+\(file.added)").foregroundStyle(TetherColors.success) }
            if file.removed > 0 { Text("−\(file.removed)").foregroundStyle(TetherColors.danger) }
            Image(systemName: "arrow.up.left.and.arrow.down.right").font(.caption2)
              .foregroundStyle(TetherColors.textFaint)
          }
          .font(.caption2.monospaced())
          .padding(.horizontal, 10).padding(.vertical, 7)
          .background(TetherColors.surfaceRaised)
          ForEach(previewRows(file)) { row in
            Text(row.text.isEmpty ? " " : row.text).font(.caption2.monospaced())
              .foregroundStyle(TetherColors.textPrimary).lineLimit(1)
              .padding(.horizontal, 10).padding(.vertical, 1)
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(edge(row.kind).opacity(0.10))
              .overlay(alignment: .leading) { edge(row.kind).frame(width: 2) }
          }
        }
        .background(TetherColors.background.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TetherColors.border))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Change to \(file.path), \(file.added) added, \(file.removed) removed")
      .accessibilityHint("Shows the full change")
    } else if let text = permission.text, !text.isEmpty {
      Text(String(text.prefix(300))).font(.caption.monospaced()).foregroundStyle(TetherColors.textSecondary)
        .lineLimit(4)
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(TetherColors.background.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TetherColors.border))
    }
  }

  /// A couple of removed lines, then the added ones, so a rewrite shows both sides.
  private func previewRows(_ file: DiffFile) -> [DiffRow] {
    let limit = dynamicTypeSize.isAccessibilitySize ? 2 : 3
    return Array(file.rows.filter { $0.kind == .removed }.prefix(2))
      + Array(file.rows.filter { $0.kind == .added }.prefix(limit))
  }

  private func edge(_ kind: DiffRow.Kind) -> Color {
    switch kind {
    case .added: TetherColors.success
    case .removed: TetherColors.danger
    default: .clear
    }
  }

  private func optionButton(_ option: ACPPermissionOption, role: ChatPermissionRole) -> some View {
    Button { approve(option) } label: {
      Text(option.name)
        .font(.body.weight(role == .primary ? .semibold : .medium))
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity, minHeight: 44)
        .padding(.horizontal, 10)
        .foregroundStyle(foreground(role))
        .background(background(role), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(border(role)))
    }
    .buttonStyle(TetherPressStyle())
    .disabled(!enabled)
    .opacity(enabled ? 1 : 0.5)
    .accessibilityLabel(option.name)
  }

  private func foreground(_ role: ChatPermissionRole) -> Color {
    switch role {
    case .primary: TetherColors.onAccent
    case .secondary: TetherColors.textPrimary
    case .destructive: TetherColors.danger
    }
  }

  private func background(_ role: ChatPermissionRole) -> Color {
    switch role {
    case .primary: TetherColors.accent
    case .secondary: TetherColors.surfaceRaised
    case .destructive: TetherColors.danger.opacity(0.10)
    }
  }

  private func border(_ role: ChatPermissionRole) -> Color {
    switch role {
    case .primary: .clear
    case .secondary: TetherColors.border
    case .destructive: TetherColors.danger.opacity(0.4)
    }
  }
}

extension ChatPermission: Identifiable {
  var id: ACPID { requestId }
}

private struct PermissionReviewSheet: View {
  let permission: ChatPermission
  let cwd: String
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        if let diff = permission.diff {
          DiffReviewView(files: [ACPDiffAdapter.file(for: diff, relativeTo: cwd)]).padding(.vertical, 8)
        }
      }
      .background(TetherColors.background)
      .navigationTitle(permission.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
    }
  }
}
