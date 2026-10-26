import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// An image in the transcript: aspect-fit in a hairline container, a calm placeholder when the file is gone.
struct ChatImageView: View {
  let ref: ChatImageRef
  var maxHeight: CGFloat = 240

  @Environment(\.chatImages) private var library
  @State private var image: UIImage?
  @State private var missing = false
  @State private var viewing = false

  private var ratio: CGFloat {
    if let width = ref.pixelWidth, let height = ref.pixelHeight, width > 0, height > 0 {
      return CGFloat(width) / CGFloat(height)
    }
    if let image, image.size.height > 0 { return image.size.width / image.size.height }
    return 4.0 / 3.0
  }

  var body: some View {
    Group {
      if missing {
        ChatImagePlaceholder()
      } else {
        Button { viewing = true } label: { picture }
          .buttonStyle(.plain)
          .accessibilityLabel(ref.accessibilityLabel)
          .accessibilityHint("Opens the image full screen")
          .accessibilityAddTraits(.isImage)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: missing ? nil : maxHeight, alignment: .leading)
    .task(id: ref.id) { await load() }
    .fullScreenCover(isPresented: $viewing) { ChatImageViewer(ref: ref, library: library) }
  }

  private var picture: some View {
    ZStack {
      TetherColors.surface
      if let image {
        Image(uiImage: image).resizable().scaledToFit()
      } else {
        ProgressView().controlSize(.small).tint(TetherColors.textFaint)
      }
    }
    .aspectRatio(ratio, contentMode: .fit)
    .clipShape(RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TetherColors.border, lineWidth: 0.5))
    .contentShape(RoundedRectangle(cornerRadius: 10))
  }

  private func load() async {
    guard let library else {
      missing = true
      return
    }
    if let hit = library.loader.cached(ref.id, maxPixel: ChatImageThumbnail.rowMaxPixel) {
      image = hit
      return
    }
    guard library.store.exists(ref) else {
      missing = true
      return
    }
    let loaded = await library.loader.load(ref, from: library.store, maxPixel: ChatImageThumbnail.rowMaxPixel)
    image = loaded
    missing = loaded == nil
  }
}

struct ChatImagePlaceholder: View {
  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "photo").font(.footnote)
      Text("Image not on this device").font(.footnote)
    }
    .foregroundStyle(TetherColors.textFaint)
    .padding(.horizontal, 12)
    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    .background(TetherColors.surface, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(TetherColors.border, lineWidth: 0.5))
    .accessibilityElement(children: .combine)
  }
}

/// The agent's pictures between its paragraphs.
struct ChatImagesRow: View {
  let refs: [ChatImageRef]

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(Array(refs.enumerated()), id: \.offset) { _, ref in ChatImageView(ref: ref) }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// The attached images in the user's own message: small squares, up to four.
struct ChatImageChips: View {
  static let limit = 4
  static let side: CGFloat = 56

  let refs: [ChatImageRef]

  /// Only when every shown file is here; otherwise the message keeps its count label.
  static func canShow(_ refs: [ChatImageRef], in library: ChatImageLibrary?) -> Bool {
    guard let library, !refs.isEmpty else { return false }
    return refs.prefix(limit).allSatisfy(library.store.exists)
  }

  var body: some View {
    HStack(spacing: 6) {
      ForEach(Array(refs.prefix(Self.limit).enumerated()), id: \.offset) { _, ref in ChatImageChip(ref: ref) }
      if refs.count > Self.limit {
        Text("+\(refs.count - Self.limit)").font(.caption.weight(.semibold)).foregroundStyle(TetherColors.textSecondary)
          .padding(.leading, 2)
      }
    }
  }
}

struct ChatImageChip: View {
  let ref: ChatImageRef

  @Environment(\.chatImages) private var library
  @State private var image: UIImage?
  @State private var viewing = false

  var body: some View {
    Button { viewing = true } label: {
      ZStack {
        TetherColors.background
        if let image { Image(uiImage: image).resizable().scaledToFill() }
      }
      .frame(width: ChatImageChips.side, height: ChatImageChips.side)
      .clipShape(RoundedRectangle(cornerRadius: 8))
      .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(TetherColors.border, lineWidth: 0.5))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(ref.accessibilityLabel)
    .accessibilityHint("Opens the image full screen")
    .task(id: ref.id) {
      guard let library else { return }
      image = await library.loader.load(ref, from: library.store, maxPixel: ChatImageThumbnail.chipMaxPixel)
    }
    .fullScreenCover(isPresented: $viewing) { ChatImageViewer(ref: ref, library: library) }
  }
}

/// Full screen on black: pinch, double-tap, close, and the share sheet (which also offers Save Image).
struct ChatImageViewer: View {
  let ref: ChatImageRef
  let library: ChatImageLibrary?

  @Environment(\.dismiss) private var dismiss
  @State private var image: UIImage?
  @State private var failed = false
  @State private var shareURL: URL?

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      if let image {
        ZoomableImage(image: image).ignoresSafeArea()
          .accessibilityLabel(ref.accessibilityLabel)
          .accessibilityAddTraits(.isImage)
      } else if failed {
        Label("Image not on this device", systemImage: "photo")
          .font(.footnote).foregroundStyle(.white.opacity(0.7))
      } else {
        ProgressView().tint(.white)
      }
    }
    .overlay(alignment: .top) {
      HStack {
        control(symbol: "xmark", label: "Close") { dismiss() }
        Spacer()
        if let shareURL {
          ShareLink(item: shareURL) { glyph("square.and.arrow.up") }
            .accessibilityLabel("Share image")
        }
      }
      .padding(.horizontal, 16).padding(.top, 8)
    }
    .statusBarHidden()
    .task { await load() }
  }

  private func glyph(_ symbol: String) -> some View {
    Image(systemName: symbol).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
      .frame(width: 44, height: 44)
      .background(Color.white.opacity(0.16), in: Circle())
  }

  private func control(symbol: String, label: String, action: @escaping () -> Void) -> some View {
    Button(action: action) { glyph(symbol) }.accessibilityLabel(label)
  }

  private func load() async {
    guard let library, library.store.exists(ref) else {
      failed = true
      return
    }
    image = await library.loader.load(ref, from: library.store, maxPixel: ChatImageThumbnail.viewerMaxPixel)
    failed = image == nil
    let source = library.store.url(for: ref)
    let name = ref.id
    let ext = UTType(mimeType: ref.mimeType)?.preferredFilenameExtension ?? "jpg"
    shareURL = await Task.detached { () -> URL? in
      let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ChatImages", isDirectory: true)
      try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      let target = folder.appendingPathComponent("\(name.prefix(12)).\(ext)")
      if !FileManager.default.fileExists(atPath: target.path) {
        guard (try? FileManager.default.copyItem(at: source, to: target)) != nil else { return nil }
      }
      return target
    }.value
  }
}

struct ZoomableImage: UIViewRepresentable {
  let image: UIImage

  func makeUIView(context: Context) -> ZoomScrollView { ZoomScrollView(image: image) }
  func updateUIView(_ view: ZoomScrollView, context: Context) {}
}

final class ZoomScrollView: UIScrollView, UIScrollViewDelegate {
  private let imageView: UIImageView
  private var laidOutFor: CGSize = .zero

  init(image: UIImage) {
    imageView = UIImageView(image: image)
    super.init(frame: .zero)
    delegate = self
    minimumZoomScale = 1
    maximumZoomScale = 5
    showsHorizontalScrollIndicator = false
    showsVerticalScrollIndicator = false
    contentInsetAdjustmentBehavior = .never
    bouncesZoom = true
    backgroundColor = .clear
    addSubview(imageView)
    let double = UITapGestureRecognizer(target: self, action: #selector(doubleTapped(_:)))
    double.numberOfTapsRequired = 2
    addGestureRecognizer(double)
  }

  @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

  func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard bounds.width > 0, bounds.height > 0, let size = imageView.image?.size, size.width > 0, size.height > 0
    else { return }
    if laidOutFor != bounds.size {
      laidOutFor = bounds.size
      zoomScale = 1
      let scale = min(bounds.width / size.width, bounds.height / size.height)
      imageView.frame = CGRect(x: 0, y: 0, width: size.width * scale, height: size.height * scale)
      contentSize = imageView.frame.size
    }
    var frame = imageView.frame
    frame.origin.x = max(0, (bounds.width - frame.width) / 2)
    frame.origin.y = max(0, (bounds.height - frame.height) / 2)
    imageView.frame = frame
  }

  @objc private func doubleTapped(_ gesture: UITapGestureRecognizer) {
    if zoomScale > 1.01 {
      setZoomScale(1, animated: true)
      return
    }
    let target: CGFloat = 2.5
    let point = gesture.location(in: imageView)
    let width = bounds.width / target
    let height = bounds.height / target
    zoom(to: CGRect(x: point.x - width / 2, y: point.y - height / 2, width: width, height: height), animated: true)
  }
}
