#if canImport(UIKit)
import SwiftUI

public struct TetherSurfaceRepresentable: UIViewRepresentable {
  @Binding public var snapshot: Data?
  public var fontName: String
  public var fontSize: CGFloat
  public var onGridSizeChange: (UInt16, UInt16) -> Void

  public init(
    snapshot: Binding<Data?>,
    fontName: String,
    fontSize: CGFloat,
    onGridSizeChange: @escaping (UInt16, UInt16) -> Void
  ) {
    _snapshot = snapshot
    self.fontName = fontName
    self.fontSize = fontSize
    self.onGridSizeChange = onGridSizeChange
  }

  public func makeUIView(context: Context) -> TetherSurfaceView {
    let view = TetherSurfaceView()
    view.fontName = fontName
    view.fontSize = fontSize
    view.onGridSizeChange = { cols, rows in onGridSizeChange(cols, rows) }
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    view.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
    return view
  }

  public func updateUIView(_ uiView: TetherSurfaceView, context: Context) {
    // The Appearance settings were previously inert: the surface exposed these
    // knobs but nothing ever assigned them.
    if uiView.fontName != fontName { uiView.fontName = fontName }
    if uiView.fontSize != fontSize { uiView.fontSize = fontSize }
    if let snapshot {
      uiView.updateSnapshot(snapshot)
    } else {
      uiView.clearSnapshot()
    }
  }
}
#endif
