import SwiftUI
import UIKit

/// Frames go from the controller straight to the surface. Through Observation every chunk of
/// output was a SwiftUI transaction that re-ran the representable's whole update.
@MainActor
public final class TerminalFrameFeed {
  public private(set) var latest: TerminalFrame?
  fileprivate var subscriber: ((TerminalFrame?) -> Void)?
  /// The coordinator `subscriber` belongs to: a surface torn down after its replacement
  /// subscribed must not unsubscribe the replacement.
  fileprivate var owner: ObjectIdentifier?

  public init() {}

  public func publish(_ frame: TerminalFrame?) {
    latest = frame
    subscriber?(frame)
  }
}

public struct TetherSurfaceRepresentable: UIViewRepresentable {
  public var frames: TerminalFrameFeed
  public var sessionKey: String
  public var fontName: String
  public var fontSize: CGFloat
  public var lineSpacing: CGFloat
  public var horizontalPadding: CGFloat
  public var cursorStyle: TerminalCursorStyle
  public var theme: TerminalTheme
  public var onGridSizeChange: (UInt16, UInt16) -> Void
  public var onGridSizeSettled: (UInt16, UInt16) -> Void
  public var onCellPixelSize: (Int, Int) -> Void
  public var onScrollLines: (Int32) -> Void
  public var onTap: () -> Void
  public var onSelectionText: (String?) -> Void
  public var onOpenURL: (URL) -> Void
  public var onOpenFile: (String, Int?, Int?) -> Void
  public var onCopyLink: (String) -> Void
  public var onMouseBytes: (String) -> Void
  public var mouseMode: MouseMode
  public var mouseSgr: Bool
  public var freezesGrid: Bool

  public init(
    frames: TerminalFrameFeed,
    sessionKey: String = "",
    fontName: String,
    fontSize: CGFloat,
    lineSpacing: CGFloat = 1,
    horizontalPadding: CGFloat = TerminalGridInset.defaultPadding,
    cursorStyle: TerminalCursorStyle = .default,
    theme: TerminalTheme = .tether,
    onGridSizeChange: @escaping (UInt16, UInt16) -> Void,
    onGridSizeSettled: @escaping (UInt16, UInt16) -> Void = { _, _ in },
    onCellPixelSize: @escaping (Int, Int) -> Void = { _, _ in },
    onScrollLines: @escaping (Int32) -> Void = { _ in },
    onTap: @escaping () -> Void = {},
    onSelectionText: @escaping (String?) -> Void = { _ in },
    onOpenURL: @escaping (URL) -> Void = { _ in },
    onOpenFile: @escaping (String, Int?, Int?) -> Void = { _, _, _ in },
    onCopyLink: @escaping (String) -> Void = { _ in },
    onMouseBytes: @escaping (String) -> Void = { _ in },
    mouseMode: MouseMode = .off,
    mouseSgr: Bool = true,
    freezesGrid: Bool = false
  ) {
    self.frames = frames
    self.sessionKey = sessionKey
    self.fontName = fontName
    self.fontSize = fontSize
    self.lineSpacing = lineSpacing
    self.horizontalPadding = horizontalPadding
    self.cursorStyle = cursorStyle
    self.theme = theme
    self.onGridSizeChange = onGridSizeChange
    self.onGridSizeSettled = onGridSizeSettled
    self.onCellPixelSize = onCellPixelSize
    self.onScrollLines = onScrollLines
    self.onTap = onTap
    self.onSelectionText = onSelectionText
    self.onOpenURL = onOpenURL
    self.onOpenFile = onOpenFile
    self.onCopyLink = onCopyLink
    self.onMouseBytes = onMouseBytes
    self.mouseMode = mouseMode
    self.mouseSgr = mouseSgr
    self.freezesGrid = freezesGrid
  }

  public func makeCoordinator() -> Coordinator {
    Coordinator(parent: self)
  }

  public func makeUIView(context: Context) -> TetherSurfaceView {
    let view = TetherSurfaceView()
    view.fontName = fontName
    view.fontSize = fontSize
    view.lineSpacing = lineSpacing
    view.horizontalPadding = horizontalPadding
    view.cursorPreference = cursorStyle
    view.apply(theme: theme)
    view.onGridSizeChange = { cols, rows in onGridSizeChange(cols, rows) }
    view.onGridSizeSettled = { cols, rows in onGridSizeSettled(cols, rows) }
    view.onCellPixelSize = { width, height in onCellPixelSize(width, height) }
    bindCallbacks(view, context: context)
    context.coordinator.subscribe(view, to: frames)
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    view.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
    return view
  }

  public func updateUIView(_ uiView: TetherSurfaceView, context: Context) {
    context.coordinator.parent = self
    if uiView.fontName != fontName { uiView.fontName = fontName }
    uiView.apply(theme: theme)
    if uiView.fontSize != fontSize { uiView.fontSize = fontSize }
    if uiView.lineSpacing != lineSpacing { uiView.lineSpacing = lineSpacing }
    if uiView.horizontalPadding != horizontalPadding { uiView.horizontalPadding = horizontalPadding }
    uiView.cursorPreference = cursorStyle
    uiView.mouseMode = mouseMode
    uiView.mouseSgr = mouseSgr
    if uiView.freezesGrid != freezesGrid { uiView.freezesGrid = freezesGrid }
    bindCallbacks(uiView, context: context)
    if context.coordinator.sessionKey != sessionKey {
      context.coordinator.sessionKey = sessionKey
      if !sessionKey.isEmpty {
        uiView.prepareForSessionChange()
        if let latest = frames.latest { uiView.updateSnapshot(latest) }
      }
    }
    // Another surface for the same feed may have subscribed and gone away since.
    if context.coordinator.feed !== frames || frames.owner != ObjectIdentifier(context.coordinator) {
      context.coordinator.subscribe(uiView, to: frames)
    }
  }

  private func bindCallbacks(_ view: TetherSurfaceView, context: Context) {
    let coordinator = context.coordinator
    view.onScrollLines = { lines in coordinator.parent.onScrollLines(lines) }
    view.onTapCell = { _, _ in coordinator.parent.onTap() }
    view.onSelectionChanged = { selection in
      guard let selection else {
        coordinator.parent.onSelectionText(nil)
        return
      }
      let text = selection.text(from: view.rowTexts())
      coordinator.parent.onSelectionText(text.isEmpty ? nil : text)
    }
    view.onOpenLink = { target in
      switch target {
      case let .external(urlString):
        if let url = URL(string: urlString) {
          coordinator.parent.onOpenURL(url)
        }
      case let .file(path, line, column):
        coordinator.parent.onOpenFile(path, line, column)
      }
    }
    view.onCopyLink = { target in coordinator.parent.onCopyLink(target.text) }
    view.onMouseBytes = { bytes in coordinator.parent.onMouseBytes(bytes) }
  }

  public final class Coordinator {
    var parent: TetherSurfaceRepresentable
    var sessionKey: String = ""
    fileprivate weak var feed: TerminalFrameFeed?

    init(parent: TetherSurfaceRepresentable) {
      self.parent = parent
    }

    @MainActor
    fileprivate func subscribe(_ view: TetherSurfaceView, to feed: TerminalFrameFeed) {
      if let old = self.feed, old.owner == ObjectIdentifier(self) { old.subscriber = nil }
      self.feed = feed
      feed.owner = ObjectIdentifier(self)
      feed.subscriber = { [weak view] frame in
        guard let view else { return }
        if let frame { view.updateSnapshot(frame) } else { view.clearSnapshot() }
      }
      if let latest = feed.latest { view.updateSnapshot(latest) }
    }
  }

  public static func dismantleUIView(_ uiView: TetherSurfaceView, coordinator: Coordinator) {
    guard let feed = coordinator.feed, feed.owner == ObjectIdentifier(coordinator) else { return }
    feed.subscriber = nil
    feed.owner = nil
  }
}
