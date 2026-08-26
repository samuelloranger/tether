#if canImport(UIKit)
import SwiftUI
import UIKit

public struct TetherSurfaceRepresentable: UIViewRepresentable {
  @Binding public var snapshot: Data?
  public var fontName: String
  public var fontSize: CGFloat
  public var onGridSizeChange: (UInt16, UInt16) -> Void
  public var onScrollLines: (Int32) -> Void
  public var onTap: () -> Void
  public var onSelectionText: (String?) -> Void
  public var onOpenURL: (URL) -> Void
  public var onMouseBytes: (String) -> Void
  public var mouseMode: MouseMode
  public var mouseSgr: Bool

  public init(
    snapshot: Binding<Data?>,
    fontName: String,
    fontSize: CGFloat,
    onGridSizeChange: @escaping (UInt16, UInt16) -> Void,
    onScrollLines: @escaping (Int32) -> Void = { _ in },
    onTap: @escaping () -> Void = {},
    onSelectionText: @escaping (String?) -> Void = { _ in },
    onOpenURL: @escaping (URL) -> Void = { _ in },
    onMouseBytes: @escaping (String) -> Void = { _ in },
    mouseMode: MouseMode = .off,
    mouseSgr: Bool = true
  ) {
    _snapshot = snapshot
    self.fontName = fontName
    self.fontSize = fontSize
    self.onGridSizeChange = onGridSizeChange
    self.onScrollLines = onScrollLines
    self.onTap = onTap
    self.onSelectionText = onSelectionText
    self.onOpenURL = onOpenURL
    self.onMouseBytes = onMouseBytes
    self.mouseMode = mouseMode
    self.mouseSgr = mouseSgr
  }

  public func makeCoordinator() -> Coordinator {
    Coordinator(parent: self)
  }

  public func makeUIView(context: Context) -> TetherSurfaceView {
    let view = TetherSurfaceView()
    view.fontName = fontName
    view.fontSize = fontSize
    view.onGridSizeChange = { cols, rows in onGridSizeChange(cols, rows) }
    bindCallbacks(view, context: context)
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    view.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
    return view
  }

  public func updateUIView(_ uiView: TetherSurfaceView, context: Context) {
    context.coordinator.parent = self
    if uiView.fontName != fontName { uiView.fontName = fontName }
    if uiView.fontSize != fontSize { uiView.fontSize = fontSize }
    uiView.mouseMode = mouseMode
    uiView.mouseSgr = mouseSgr
    bindCallbacks(uiView, context: context)
    if let snapshot {
      uiView.updateSnapshot(snapshot)
    } else {
      uiView.clearSnapshot()
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
      case .file:
        // Workspace file open is owned by the files agent — surface URL-style only.
        break
      }
    }
    view.onMouseBytes = { bytes in coordinator.parent.onMouseBytes(bytes) }
  }

  public final class Coordinator {
    var parent: TetherSurfaceRepresentable

    init(parent: TetherSurfaceRepresentable) {
      self.parent = parent
    }
  }
}
#endif
