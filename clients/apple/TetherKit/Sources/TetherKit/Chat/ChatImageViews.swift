import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// An image in the transcript: aspect-fit in a hairline container, a calm placeholder when the file is gone.
struct ChatImageView: View {
  let ref: ChatImageRef
  var maxHeight: CGFloat = 240

  @Environment(\.chatImages) private var library
  @Environment(\.chatImageGallery) private var gallery
  @State private var image: UIImage?
  @State private var missing = false
  @State private var viewing = false
  @State private var refs: [ChatImageRef] = []

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
        Button {
          refs = gallery()
          viewing = true
        } label: { picture }
          .buttonStyle(.plain)
          .accessibilityLabel(ref.accessibilityLabel)
          .accessibilityHint("Opens the image full screen")
          .accessibilityAddTraits(.isImage)
          .contextMenu { ChatImageActions(ref: ref, library: library, preview: image) }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: missing ? nil : maxHeight, alignment: .leading)
    .task(id: ref.id) { await load() }
    .fullScreenCover(isPresented: $viewing) { ChatImageViewer(ref: ref, gallery: refs, library: library) }
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
      Image(systemName: "photo").font(.chat(.footnote))
      Text("Image not on this device").font(.chat(.footnote))
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
        Text("+\(refs.count - Self.limit)").font(.chat(.caption).weight(.semibold)).foregroundStyle(TetherColors.textSecondary)
          .padding(.leading, 2)
      }
    }
  }
}

struct ChatImageChip: View {
  let ref: ChatImageRef

  @Environment(\.chatImages) private var library
  @Environment(\.chatImageGallery) private var gallery
  @State private var image: UIImage?
  @State private var viewing = false
  @State private var refs: [ChatImageRef] = []

  var body: some View {
    Button {
      refs = gallery()
      viewing = true
    } label: {
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
    .contextMenu { ChatImageActions(ref: ref, library: library, preview: image) }
    .fullScreenCover(isPresented: $viewing) { ChatImageViewer(ref: ref, gallery: refs, library: library) }
  }
}

/// Copy, save and share for an image's long-press menu; each reads the full file when chosen.
struct ChatImageActions: View {
  let ref: ChatImageRef
  let library: ChatImageLibrary?
  let preview: UIImage?

  var body: some View {
    if let library, library.store.exists(ref) {
      let file = ChatImageFile(url: library.store.url(for: ref))
      Button { UIPasteboard.general.image = file.image } label: { MenuLabel("Copy", systemImage: "doc.on.doc") }
      Button {
        if let image = file.image { UIImageWriteToSavedPhotosAlbum(image, nil, nil, nil) }
      } label: { MenuLabel("Save to Photos", systemImage: "square.and.arrow.down") }
      ShareLink(item: file, preview: SharePreview("Image", image: Image(uiImage: preview ?? UIImage()))) {
        MenuLabel("Share…", systemImage: "square.and.arrow.up")
      }
    }
  }
}

/// A stored image handed to the share sheet as PNG, decoded only when the sheet asks.
struct ChatImageFile: Transferable {
  let url: URL

  var image: UIImage? { UIImage(contentsOfFile: url.path) }

  static var transferRepresentation: some TransferRepresentation {
    DataRepresentation(exportedContentType: .png) { file in
      guard let data = file.image?.pngData() else { throw CocoaError(.fileReadCorruptFile) }
      return data
    }
  }
}

/// Full screen on black: swipe between the chat's images, pinch, double-tap, drag down to close,
/// and the share sheet (which also offers Save Image).
struct ChatImageViewer: View {
  let refs: [ChatImageRef]
  let library: ChatImageLibrary?

  @Environment(\.dismiss) private var dismiss
  @State private var current: String
  @State private var shareURL: URL?
  @State private var dragProgress: CGFloat = 0

  /// `gallery` is every image in the chat; without `ref` in it the viewer shows `ref` alone.
  init(ref: ChatImageRef, gallery: [ChatImageRef] = [], library: ChatImageLibrary?) {
    refs = gallery.contains(ref) ? gallery : [ref]
    self.library = library
    _current = State(initialValue: ref.id)
  }

  private var currentRef: ChatImageRef? { refs.first { $0.id == current } }

  var body: some View {
    ZStack {
      Color.black.opacity(Double(1 - dragProgress * 0.7)).ignoresSafeArea()
      TabView(selection: $current) {
        ForEach(refs) { ref in
          ChatImagePage(ref: ref, library: library, onDrag: { dragProgress = $0 }, onDismiss: { dismiss() })
            .tag(ref.id)
        }
      }
      .tabViewStyle(.page(indexDisplayMode: .never))
      .ignoresSafeArea()
    }
    .overlay(alignment: .top) {
      HStack {
        control(symbol: "xmark", label: "Close") { dismiss() }
        Spacer()
        if refs.count > 1, let index = refs.firstIndex(where: { $0.id == current }) {
          Text("\(index + 1) of \(refs.count)").font(.app(.footnote).monospacedDigit()).foregroundStyle(.white.opacity(0.8))
        }
        Spacer()
        if let shareURL {
          ShareLink(item: shareURL) { glyph("square.and.arrow.up") }
            .accessibilityLabel("Share image")
        } else {
          Color.clear.frame(width: 44, height: 44)
        }
      }
      .padding(.horizontal, 16).padding(.top, 8)
      .opacity(dragProgress > 0 ? 0 : 1)
    }
    .statusBarHidden()
    .task(id: current) {
      shareURL = nil
      guard let library, let ref = currentRef, library.store.exists(ref) else { return }
      shareURL = await Self.shareFile(ref, library: library)
    }
  }

  private func glyph(_ symbol: String) -> some View {
    Image(systemName: symbol).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
      .frame(width: 44, height: 44)
      .background(Color.white.opacity(0.16), in: Circle())
  }

  private func control(symbol: String, label: String, action: @escaping () -> Void) -> some View {
    Button(action: action) { glyph(symbol) }.accessibilityLabel(label)
  }

  /// A copy with a real extension, so the share sheet knows the type.
  private static func shareFile(_ ref: ChatImageRef, library: ChatImageLibrary) async -> URL? {
    let source = library.store.url(for: ref)
    let name = ref.id
    let ext = UTType(mimeType: ref.mimeType)?.preferredFilenameExtension ?? "jpg"
    return await Task.detached { () -> URL? in
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

/// One image of the viewer, loaded when its page is built.
private struct ChatImagePage: View {
  let ref: ChatImageRef
  let library: ChatImageLibrary?
  let onDrag: (CGFloat) -> Void
  let onDismiss: () -> Void

  @State private var image: UIImage?
  @State private var failed = false

  var body: some View {
    ZStack {
      if let image {
        ZoomableImage(image: image, onDrag: onDrag, onDismiss: onDismiss)
          .accessibilityLabel(ref.accessibilityLabel)
          .accessibilityAddTraits(.isImage)
      } else if failed {
        Label("Image not on this device", systemImage: "photo")
          .font(.app(.footnote)).foregroundStyle(.white.opacity(0.7))
      } else {
        ProgressView().tint(.white)
      }
    }
    .task(id: ref.id) {
      guard let library, library.store.exists(ref) else {
        failed = true
        return
      }
      image = await library.loader.load(ref, from: library.store, maxPixel: ChatImageThumbnail.viewerMaxPixel)
      failed = image == nil
    }
  }
}

struct ZoomableImage: UIViewRepresentable {
  let image: UIImage
  var onDrag: (CGFloat) -> Void = { _ in }
  var onDismiss: () -> Void = {}

  func makeUIView(context: Context) -> ZoomScrollView { ZoomScrollView(image: image) }
  func updateUIView(_ view: ZoomScrollView, context: Context) {
    view.onDrag = onDrag
    view.onDismiss = onDismiss
  }
}

final class ZoomScrollView: UIScrollView, UIScrollViewDelegate {
  private let imageView: UIImageView
  private var laidOutFor: CGSize = .zero
  private lazy var dismissPan = UIPanGestureRecognizer(target: self, action: #selector(dragged(_:)))
  // Its own delegate: the scroll view is already its pan and pinch's.
  private let dismissGate = DismissGate()
  private var dragStart: CGPoint = .zero
  /// How far a downward drag has gone toward closing, 0 to 1.
  var onDrag: (CGFloat) -> Void = { _ in }
  var onDismiss: () -> Void = {}

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
    dismissGate.scrollView = self
    dismissPan.delegate = dismissGate
    addGestureRecognizer(dismissPan)
  }

  /// Moves the content through the offset: layout owns the image view's frame and SwiftUI owns this view's.
  @objc private func dragged(_ gesture: UIPanGestureRecognizer) {
    let distance = max(0, gesture.translation(in: self).y)
    switch gesture.state {
    case .began:
      dragStart = contentOffset
    case .changed:
      contentOffset = CGPoint(x: dragStart.x, y: dragStart.y - distance)
      onDrag(min(1, distance / 300))
    case .ended where distance > 120 || gesture.velocity(in: self).y > 900:
      onDismiss()
    case .ended, .cancelled, .failed:
      setContentOffset(dragStart, animated: true)
      onDrag(0)
    default:
      break
    }
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

/// Only a downward drag on an unzoomed image closes; anything else is a pan, a zoom or a page swipe.
private final class DismissGate: NSObject, UIGestureRecognizerDelegate {
  weak var scrollView: UIScrollView?

  func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
    guard let scrollView, let pan = gesture as? UIPanGestureRecognizer else { return false }
    let velocity = pan.velocity(in: scrollView)
    return scrollView.zoomScale <= scrollView.minimumZoomScale + 0.01 && velocity.y > abs(velocity.x)
  }

  func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
    other.view === scrollView
  }
}
