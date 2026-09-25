import SwiftUI
import UIKit

/// A grid of the shipped icons; tapping one asks iOS to switch to it.
struct AppIconPicker: View {
  @Binding var current: AppIconChoice
  @State private var failure: String?
  @State private var changing = false

  var body: some View {
    ScrollView {
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 84), spacing: 12)], spacing: 20) {
        ForEach(AppIconChoice.all) { choice in
          Button { select(choice) } label: { cell(choice) }
            .buttonStyle(.plain)
            .accessibilityLabel(choice.name)
            .accessibilityAddTraits(choice == current ? .isSelected : [])
        }
      }
      .padding()
    }
    .navigationTitle("App icon")
    .navigationBarTitleDisplayMode(.inline)
    .alert(
      "Couldn't change the icon",
      isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
    ) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(failure ?? "")
    }
  }

  private static let corner = RoundedRectangle(cornerRadius: 15, style: .continuous)

  private func cell(_ choice: AppIconChoice) -> some View {
    VStack(spacing: 8) {
      Group {
        if let url = choice.previewURL, let image = UIImage(contentsOfFile: url.path) {
          Image(uiImage: image).resizable()
        } else {
          Color.secondary.opacity(0.2)
        }
      }
      .frame(width: 66, height: 66)
      .clipShape(Self.corner)
      .padding(4)
      .overlay(
        RoundedRectangle(cornerRadius: 18, style: .continuous)
          .strokeBorder(TetherColors.accent, lineWidth: 3)
          .opacity(choice == current ? 1 : 0)
      )
      Text(choice.name)
        .font(.caption)
        .foregroundStyle(choice == current ? .primary : .secondary)
    }
  }

  private func select(_ choice: AppIconChoice) {
    guard choice != current, !changing, UIApplication.shared.supportsAlternateIcons else { return }
    changing = true
    Task {
      do {
        try await UIApplication.shared.setAlternateIconName(choice.assetName)
      } catch {
        failure = error.localizedDescription
      }
      // What iOS reports, not what was asked for: the switch can fail or be refused.
      current = .current(alternateName: UIApplication.shared.alternateIconName)
      changing = false
    }
  }
}
