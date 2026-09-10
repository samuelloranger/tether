import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

/// Side-by-side before/after images.
public struct ImageDiffView: View {
  public var oldData: Data?
  public var newData: Data?
  public var loading: Bool

  public init(oldData: Data?, newData: Data?, loading: Bool) {
    self.oldData = oldData
    self.newData = newData
    self.loading = loading
  }

  public var body: some View {
    Group {
      if loading {
        ProgressView()
          .tint(TetherColors.accent)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if oldData == nil && newData == nil {
        Text("Preview not available")
          .foregroundStyle(TetherColors.textSecondary)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        HStack(alignment: .top, spacing: 16) {
          if let oldData {
            pane(label: "Before", data: oldData)
          }
          if let newData {
            pane(label: "After", data: newData)
          }
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      }
    }
    .background(TetherColors.background)
  }

  private func pane(label: String, data: Data) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(label.uppercased())
        .font(.caption.monospaced())
        .foregroundStyle(TetherColors.textSecondary)
      ZStack {
        RoundedRectangle(cornerRadius: 8)
          .fill(TetherColors.surface)
        #if canImport(UIKit)
        if let uiImage = UIImage(data: data) {
          Image(uiImage: uiImage)
            .resizable()
            .scaledToFit()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          Text("Could not decode image")
            .font(.caption)
            .foregroundStyle(TetherColors.textSecondary)
        }
        #else
        Text("Image preview unavailable")
          .font(.caption)
          .foregroundStyle(TetherColors.textSecondary)
        #endif
      }
      .frame(minHeight: 200)
      .clipShape(RoundedRectangle(cornerRadius: 8))
    }
    .frame(maxWidth: .infinity)
  }
}
