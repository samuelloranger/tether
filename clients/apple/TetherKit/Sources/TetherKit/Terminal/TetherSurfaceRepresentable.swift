#if canImport(UIKit)
import SwiftUI

public struct TetherSurfaceRepresentable: UIViewRepresentable {
  @Binding public var snapshot: Data?

  public init(snapshot: Binding<Data?>) {
    _snapshot = snapshot
  }

  public func makeUIView(context: Context) -> TetherSurfaceView {
    let view = TetherSurfaceView()
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    view.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
    return view
  }

  public func updateUIView(_ uiView: TetherSurfaceView, context: Context) {
    if let snapshot {
      uiView.updateSnapshot(snapshot)
    } else {
      uiView.clearSnapshot()
    }
  }
}
#endif
