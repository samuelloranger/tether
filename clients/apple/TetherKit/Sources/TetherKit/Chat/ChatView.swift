import SwiftUI

/// A document-style transcript: the agent's prose at full width, everything else quiet.
struct ChatView: View {
  @Bindable var model: ChatSessionModel

  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var draft = ""
  @State private var expanded: Set<Int> = []
  @State private var userScrolledUp = false
  @State private var bottomEdge: CGFloat = 0
  @State private var viewportHeight: CGFloat = 0
  @State private var atBottom = true
  @State private var sendTick = 0
  @State private var scrolledUnder = false
  @State private var reviewing: ChatPermission?

  private let bottomID = "chat-bottom"
  private static let space = "chat-scroll"

  var body: some View {
    scroller
    .background(TetherColors.background.ignoresSafeArea())
    .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
    .navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(.regularMaterial, for: .navigationBar)
    .toolbarBackground(scrolledUnder ? .visible : .hidden, for: .navigationBar)
    .toolbar {
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

  @ViewBuilder private var scroller: some View {
    if #available(iOS 18.0, *) {
      FollowingTranscript(atBottom: $atBottom, scrolledUnder: $scrolledUnder, sendTick: sendTick, reduceMotion: reduceMotion) { transcript }
    } else {
      legacyScroller
    }
  }

  private var transcript: some View {
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
    }
    .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 16)
  }

  /// iOS 17: the transcript follows by scrolling to a sentinel when the tail changes.
  private var legacyScroller: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(spacing: 0) {
          transcript
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(Self.space)).minY } action: {
              scrolledUnder = $0 < -1
            }
          Color.clear.frame(height: 1).id(bottomID)
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(Self.space)).maxY } action: { bottomEdge = $0 }
            .onDisappear { bottomEdge = .infinity }
        }
      }
      .coordinateSpace(name: Self.space)
      .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewportHeight = $0 }
      .chatEdgeFade(top: scrolledUnder, bottom: userScrolledUp)
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
          JumpToLatestButton {
            userScrolledUp = false
            withAnimation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion)) {
              proxy.scrollTo(bottomID, anchor: .bottom)
            }
          }
        }
      }
      .animation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion), value: userScrolledUp)
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

  private var titleBlock: some View {
    VStack(spacing: 1) {
      Text(model.title).font(.headline).foregroundStyle(TetherColors.textPrimary).lineLimit(1)
      Text(subtitle).font(.caption2.monospaced()).foregroundStyle(TetherColors.textFaint)
        .lineLimit(1).truncationMode(.head)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(model.title), \(model.cwd)")
  }

  private var subtitle: String {
    if let usage = ChatFormat.contextSummary(used: model.state.contextUsed, size: model.state.contextSize) {
      return "\(model.cwd) · \(usage)"
    }
    return model.cwd
  }

  @ViewBuilder private var connectionBadge: some View {
    switch model.link.phase {
    case .lost:
      Button { model.reconnect() } label: {
        Label("Reconnect", systemImage: "arrow.clockwise").font(.caption.weight(.semibold))
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
      Circle().fill(color).frame(width: 7, height: 7)
      Text(text).font(.caption2.weight(.semibold)).foregroundStyle(TetherColors.textSecondary)
    }
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
        sendTick += 1
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

  @State private var previewWidth: CGFloat = 0

  @ViewBuilder private var preview: some View {
    if let diff = permission.diff {
      let file = ACPDiffAdapter.file(for: diff, relativeTo: cwd)
      let rows = previewRows(file)
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 8) {
          Text(file.path).font(.caption.monospaced()).lineLimit(1).truncationMode(.head)
            .foregroundStyle(TetherColors.textPrimary)
          Spacer(minLength: 6)
          HStack(spacing: 6) {
            if file.added > 0 { Text("+\(file.added)").foregroundStyle(TetherColors.success) }
            if file.removed > 0 { Text("−\(file.removed)").foregroundStyle(TetherColors.danger) }
          }
          .font(.system(size: 14, weight: .semibold, design: .monospaced))
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(TetherColors.surfaceRaised)
        ScrollView(.horizontal, showsIndicators: false) {
          VStack(alignment: .leading, spacing: 0) {
            ForEach(rows) { row in
              HStack(spacing: 6) {
                Text(gutter(row.kind)).foregroundStyle(edge(row.kind))
                  .frame(width: 10)
                Text(row.text.isEmpty ? " " : row.text)
                  .foregroundStyle(TetherColors.textPrimary)
                  .fixedSize(horizontal: true, vertical: false)
              }
              .font(.caption2.monospaced())
              .padding(.horizontal, 10).padding(.vertical, 1)
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(edge(row.kind).opacity(0.10))
              .overlay(alignment: .leading) { edge(row.kind).frame(width: 2) }
              .accessibilityLabel("\(accessibleKind(row.kind)) \(row.text)")
            }
          }
          .frame(minWidth: previewWidth, alignment: .leading)
          .fixedSize(horizontal: true, vertical: false)
          .padding(.vertical, 4)
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { previewWidth = $0 }
        .mask {
          VStack(spacing: 0) {
            Color.black
            LinearGradient(colors: [.black, .black.opacity(0.15)], startPoint: .top, endPoint: .bottom)
              .frame(height: 16)
          }
        }
        Button(action: review) {
          HStack(spacing: 6) {
            Text("Show full diff").font(.footnote.weight(.semibold))
            Image(systemName: "arrow.up.left.and.arrow.down.right").font(.footnote)
            Spacer(minLength: 0)
          }
          .foregroundStyle(TetherColors.accent)
          .padding(.horizontal, 10)
          .frame(minHeight: 36)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Show full diff of \(file.path), \(file.added) added, \(file.removed) removed")
      }
      .background(TetherColors.background.opacity(0.5))
      .clipShape(RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TetherColors.border))
    } else if let text = permission.text, !text.isEmpty {
      Text(String(text.prefix(300))).font(.caption.monospaced()).foregroundStyle(TetherColors.textSecondary)
        .lineLimit(4)
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(TetherColors.background.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TetherColors.border))
    }
  }

  /// Up to five lines: the first removed ones, then the added ones, so a rewrite shows both sides.
  private func previewRows(_ file: DiffFile) -> [DiffRow] {
    let total = dynamicTypeSize.isAccessibilitySize ? 3 : 5
    let removed = Array(file.rows.filter { $0.kind == .removed }.prefix(2))
    let added = Array(file.rows.filter { $0.kind == .added }.prefix(total - removed.count))
    return removed + added
  }

  private func gutter(_ kind: DiffRow.Kind) -> String {
    switch kind {
    case .added: "+"
    case .removed: "−"
    default: " "
    }
  }

  private func accessibleKind(_ kind: DiffRow.Kind) -> String {
    switch kind {
    case .added: "Added"
    case .removed: "Removed"
    default: ""
    }
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

struct JumpToLatestButton: View {
  let action: () -> Void
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    Button(action: action) {
      Label("Jump to latest", systemImage: "arrow.down")
        .font(.caption.weight(.semibold))
        .tetherPill()
    }
    .buttonStyle(TetherPressStyle())
    .padding(.trailing, 14).padding(.bottom, 10)
    .transition(.opacity)
  }
}

/// iOS 18: the scroll view stays pinned to the end while content grows (`.sizeChanges`) and lets go
/// once the user scrolls up; "at the bottom" comes from the real offset and sizes.
@available(iOS 18.0, *)
private struct FollowingTranscript<Content: View>: View {
  @Binding var atBottom: Bool
  @Binding var scrolledUnder: Bool
  let sendTick: Int
  let reduceMotion: Bool
  @ViewBuilder var content: () -> Content

  @State private var position = ScrollPosition(edge: .bottom)

  var body: some View {
    ScrollView {
      content()
    }
    .scrollPosition($position)
    .defaultScrollAnchor(.bottom, for: .initialOffset)
    .defaultScrollAnchor(.bottom, for: .sizeChanges)
    .scrollDismissesKeyboard(.interactively)
    .onScrollGeometryChange(for: Bool.self) { geometry in
      ChatScrollFollow.isNearBottom(
        offset: geometry.visibleRect.minY,
        content: geometry.contentSize.height,
        container: geometry.visibleRect.height)
    } action: { _, near in
      atBottom = near
    }
    .onScrollGeometryChange(for: Bool.self) { geometry in
      geometry.contentOffset.y + geometry.contentInsets.top > 1
    } action: { _, under in
      scrolledUnder = under
    }
    .chatEdgeFade(top: scrolledUnder, bottom: !atBottom)
    .overlay(alignment: .bottomTrailing) {
      if !atBottom {
        JumpToLatestButton {
          withAnimation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion)) {
            position.scrollTo(edge: .bottom)
          }
        }
      }
    }
    .onChange(of: sendTick) { _, _ in position.scrollTo(edge: .bottom) }
    .animation(TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion), value: atBottom)
  }
}

extension View {
  /// Fades the last 12pt of scrolling content under the bars instead of slicing a line in half.
  func chatEdgeFade(top: Bool, bottom: Bool) -> some View { modifier(ChatEdgeFade(top: top, bottom: bottom)) }
}

private struct ChatEdgeFade: ViewModifier {
  let top: Bool
  let bottom: Bool
  @State private var insets = EdgeInsets()
  private let fade: CGFloat = 12

  func body(content: Content) -> some View {
    content
      .onGeometryChange(for: EdgeInsets.self) { $0.safeAreaInsets } action: { insets = $0 }
      .mask {
        VStack(spacing: 0) {
          Color.black.frame(height: insets.top)
          LinearGradient(colors: [top ? .clear : .black, .black], startPoint: .top, endPoint: .bottom)
            .frame(height: fade)
          Color.black
          LinearGradient(colors: [.black, bottom ? .clear : .black], startPoint: .top, endPoint: .bottom)
            .frame(height: fade)
          Color.black.frame(height: insets.bottom)
        }
        .ignoresSafeArea()
        .animation(.easeOut(duration: 0.15), value: top)
        .animation(.easeOut(duration: 0.15), value: bottom)
      }
  }
}
