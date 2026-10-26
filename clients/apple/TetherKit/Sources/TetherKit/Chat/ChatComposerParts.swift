import ImageIO
import Observation
import SwiftUI
import UIKit

/// The images queued under the composer: each shows at once and becomes sendable once encoded.
@MainActor
@Observable
final class ChatAttachments {
  struct Item: Identifiable {
    let id = UUID()
    var thumbnail: UIImage?
    var encoded: ChatImageAttachment?
  }

  private(set) var items: [Item] = []
  var error: String?

  var encoding: Int { items.filter { $0.encoded == nil }.count }
  var ready: [ChatImageAttachment] { items.compactMap(\.encoded) }
  var room: Int { max(0, ChatComposerRule.maxImages - items.count) }

  func add(loading data: @escaping @Sendable () async -> Data?) {
    guard room > 0 else { return }
    let item = Item()
    items.append(item)
    Task { [weak self] in
      let result = await Task.detached(priority: .userInitiated) { () -> Result<(UIImage?, ChatImageAttachment), Error> in
        guard let bytes = await data() else { return .failure(ChatImageError.notAnImage) }
        do { return .success((Self.thumbnail(bytes), try ChatImageEncoder.encode(bytes))) } catch {
          return .failure(error)
        }
      }.value
      self?.finish(item.id, result)
    }
  }

  func add(data: Data) { add { data } }

  func remove(_ id: UUID) { items.removeAll { $0.id == id } }

  func clear() { items = [] }

  func seed(_ thumbnails: [UIImage]) {
    items = thumbnails.map { Item(thumbnail: $0, encoded: ChatImageAttachment(mimeType: "image/jpeg", data: "")) }
  }

  private func finish(_ id: UUID, _ result: Result<(UIImage?, ChatImageAttachment), Error>) {
    guard let index = items.firstIndex(where: { $0.id == id }) else { return }
    switch result {
    case let .success((thumbnail, attachment)):
      items[index].thumbnail = thumbnail
      items[index].encoded = attachment
    case let .failure(error):
      items.remove(at: index)
      self.error = ChatComposerRule.message(for: error)
    }
  }

  nonisolated private static func thumbnail(_ data: Data) -> UIImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: 180,
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
  }
}

struct AttachmentStrip: View {
  let attachments: ChatAttachments

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(attachments.items) { item in
          thumb(item).padding(.top, 6).padding(.trailing, 6)
        }
      }
      .padding(.leading, 2)
    }
  }

  private func thumb(_ item: ChatAttachments.Item) -> some View {
    ZStack {
      if let image = item.thumbnail {
        Image(uiImage: image).resizable().scaledToFill()
      } else {
        TetherColors.surfaceRaised
      }
      if item.encoded == nil {
        Color.black.opacity(0.35)
        ProgressView().controlSize(.small).tint(.white)
      }
    }
    .frame(width: 56, height: 56)
    .clipShape(RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TetherColors.border, lineWidth: 0.5))
    .overlay(alignment: .topTrailing) {
      Button { attachments.remove(item.id) } label: {
        Image(systemName: "xmark")
          .font(.system(size: 8, weight: .heavy))
          .foregroundStyle(TetherColors.textPrimary)
          .frame(width: 18, height: 18)
          .background(TetherColors.surfaceRaised, in: Circle())
          .overlay(Circle().strokeBorder(TetherColors.border, lineWidth: 0.5))
          .hitSlop(vertical: 13, horizontal: 13)
      }
      .buttonStyle(.plain)
      .offset(x: 6, y: -6)
      .accessibilityLabel("Remove image")
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(item.encoded == nil ? "Image, preparing" : "Image attached")
  }
}

struct AttachmentErrorRow: View {
  let message: String
  let dismiss: () -> Void

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: "exclamationmark.circle").font(.caption)
      Text(message).font(.caption)
      Spacer(minLength: 0)
      Button(action: dismiss) { Image(systemName: "xmark").font(.caption2.weight(.semibold)).hitSlop(vertical: 12, horizontal: 12) }
        .buttonStyle(.plain)
        .accessibilityLabel("Dismiss")
    }
    .foregroundStyle(TetherColors.danger)
    .padding(.horizontal, 6)
    .task(id: message) {
      try? await Task.sleep(nanoseconds: 4_000_000_000)
      dismiss()
    }
  }
}

/// Matching commands above the composer; a tap fills the draft and leaves sending to the user.
struct SlashPalette: View {
  let query: String
  let commands: [ACPCommand]
  let pick: (ACPCommand) -> Void

  private static let rowHeight: CGFloat = 36

  var body: some View {
    let matches = ChatSlash.matches(query: query, commands: commands, limit: 60)
    if commands.isEmpty || (matches.isEmpty && query.isEmpty) {
      EmptyView()
    } else if matches.isEmpty {
      Text("No command")
        .font(.caption).foregroundStyle(TetherColors.textFaint)
        .frame(maxWidth: .infinity, minHeight: Self.rowHeight, alignment: .leading)
        .padding(.horizontal, 12)
        .card
    } else {
      ScrollView {
        LazyVStack(spacing: 0) {
          ForEach(Array(matches.enumerated()), id: \.element.id) { index, command in
            if index > 0 { Rectangle().fill(TetherColors.border.opacity(0.6)).frame(height: 0.5).padding(.leading, 12) }
            Button { pick(command) } label: { row(command) }
              .buttonStyle(PaletteRowStyle())
          }
        }
      }
      .frame(height: min(CGFloat(matches.count), 6) * Self.rowHeight)
      .scrollBounceBehavior(.basedOnSize)
      .card
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Commands")
    }
  }

  private func row(_ command: ACPCommand) -> some View {
    HStack(spacing: 8) {
      HStack(spacing: 5) {
        Text("/" + command.name).font(.system(size: 14, design: .monospaced)).foregroundStyle(TetherColors.accent)
        if let hint = command.hint {
          Text(hint).font(.system(size: 12, design: .monospaced)).foregroundStyle(TetherColors.textFaint)
        }
      }
      .lineLimit(1).layoutPriority(1)
      Text(command.description).font(.caption).foregroundStyle(TetherColors.textSecondary).lineLimit(1)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12)
    .frame(maxWidth: .infinity, minHeight: Self.rowHeight, maxHeight: Self.rowHeight, alignment: .leading)
    .contentShape(Rectangle())
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("/\(command.name). \(command.description)")
  }
}

/// Files of the chat's folder matching the `@word` being typed; a tap writes the path into the draft.
struct MentionPalette: View {
  let matches: [ChatMention.Match]
  let pick: (ChatMention.Match) -> Void

  private static let rowHeight: CGFloat = 36

  var body: some View {
    if !matches.isEmpty {
      ScrollView {
        LazyVStack(spacing: 0) {
          ForEach(Array(matches.enumerated()), id: \.element.id) { index, match in
            if index > 0 { Rectangle().fill(TetherColors.border.opacity(0.6)).frame(height: 0.5).padding(.leading, 12) }
            Button { pick(match) } label: { row(match) }
              .buttonStyle(PaletteRowStyle())
          }
        }
      }
      .frame(height: min(CGFloat(matches.count), 6) * Self.rowHeight)
      .scrollBounceBehavior(.basedOnSize)
      .card
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Files")
      .accessibilityIdentifier("chatMentionPalette")
    }
  }

  private func row(_ match: ChatMention.Match) -> some View {
    HStack(spacing: 0) {
      Text(match.name).font(.system(size: 14, weight: .semibold, design: .monospaced))
        .foregroundStyle(TetherColors.textPrimary).lineLimit(1).layoutPriority(1)
      if !match.folder.isEmpty {
        Text("  " + match.folder).font(.system(size: 12, design: .monospaced))
          .foregroundStyle(TetherColors.textFaint).lineLimit(1).truncationMode(.head)
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12)
    .frame(maxWidth: .infinity, minHeight: Self.rowHeight, maxHeight: Self.rowHeight, alignment: .leading)
    .contentShape(Rectangle())
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(match.path)
  }
}

private struct PaletteRowStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.background(configuration.isPressed ? TetherColors.surfaceHover : .clear)
  }
}

extension View {
  fileprivate var card: some View {
    background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 12))
      .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(TetherColors.border, lineWidth: 0.5))
      .clipShape(RoundedRectangle(cornerRadius: 12))
  }
}

/// The composer's text field. From iOS 18 it reports where the caret is, so an `@` mention is only
/// offered while the caret is in it; before that the caret is taken to be at the end of the draft.
@available(iOS 18.0, *)
struct CaretComposerField: View {
  @Binding var text: String
  @Binding var cursor: Int?
  @Binding var caretRequest: Int?
  let prompt: Text
  var focus: FocusState<Bool>.Binding
  @State private var selection: TextSelection?

  var body: some View {
    TextField(text: $text, selection: $selection, prompt: prompt, axis: .vertical) { EmptyView() }
      .focused(focus)
      .onChange(of: selection) { _, next in cursor = offset(of: next) }
      .onChange(of: caretRequest) { _, request in
        guard let request else { return }
        let index = text.index(text.startIndex, offsetBy: min(request, text.count))
        selection = TextSelection(insertionPoint: index)
        caretRequest = nil
      }
  }

  private func offset(of selection: TextSelection?) -> Int? {
    guard let selection, case let .selection(range) = selection.indices, range.isEmpty,
      range.lowerBound <= text.endIndex
    else { return nil }
    return text.distance(from: text.startIndex, to: range.lowerBound)
  }
}

#if DEBUG
extension ChatAttachments {
  /// Two generated placeholders for the attach fixture.
  func seedPlaceholders() {
    func tile(_ top: UIColor, _ bottom: UIColor) -> UIImage {
      UIGraphicsImageRenderer(size: CGSize(width: 112, height: 112)).image { context in
        let colors = [top.cgColor, bottom.cgColor] as CFArray
        let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: nil)!
        context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 112, y: 112), options: [])
      }
    }
    seed([tile(.systemTeal, .systemIndigo), tile(.systemOrange, .systemPink)])
  }
}
#endif
