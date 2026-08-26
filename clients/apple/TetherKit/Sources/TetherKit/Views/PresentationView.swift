import SwiftUI
#if canImport(WebKit)
import WebKit
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif
#endif

/// Banner announcing a presentation — port of `PresentationBanner.tsx`.
public struct PresentationBannerView: View {
  public var label: String
  public var systemImage: String
  public var onPress: () -> Void
  public var showsChrome: Bool

  public init(
    label: String,
    systemImage: String = "rectangle.on.rectangle",
    onPress: @escaping () -> Void,
    showsChrome: Bool = true
  ) {
    self.label = label
    self.systemImage = systemImage
    self.onPress = onPress
    self.showsChrome = showsChrome
  }

  public var body: some View {
    Button(action: onPress) {
      HStack(spacing: 8) {
        Image(systemName: systemImage)
          .font(.caption.weight(.semibold))
          .foregroundStyle(TetherColors.accent)
        Text(label)
          .font(.caption.weight(.semibold))
          .foregroundStyle(TetherColors.accent)
          .lineLimit(1)
        Spacer(minLength: 0)
        Image(systemName: "chevron.right")
          .font(.caption)
          .foregroundStyle(TetherColors.textSecondary)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 6)
      // When this sits inside a wider header row, that row owns the background
      // and the hairline; drawing them here left the surface stopping short of
      // the close button, with a visible seam between the two.
      .background(showsChrome ? TetherColors.surface : Color.clear)
      .overlay(alignment: .bottom) {
        if showsChrome {
          Rectangle()
            .fill(TetherColors.textSecondary.opacity(0.25))
            .frame(height: 1)
        }
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }
}

/// Full-screen presentation host with back banner.
public struct PresentationPaneView: View {
  public var preview: Presentation
  public var url: URL
  public var backLabel: String
  public var onBack: () -> Void
  public var onClose: (() -> Void)?

  public init(
    preview: Presentation,
    url: URL,
    backLabel: String,
    onBack: @escaping () -> Void,
    onClose: (() -> Void)? = nil
  ) {
    self.preview = preview
    self.url = url
    self.backLabel = backLabel
    self.onBack = onBack
    self.onClose = onClose
  }

  public var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 0) {
        PresentationBannerView(
          label: "Back to \(backLabel)",
          systemImage: "terminal",
          onPress: onBack,
          showsChrome: false
        )
        if let onClose {
          Button(role: .destructive, action: onClose) {
            Image(systemName: "xmark")
              .frame(width: 36, height: 36)
              .foregroundStyle(TetherColors.danger)
          }
          .accessibilityLabel("Close presentation")
        }
      }
      .background(TetherColors.surface)
      .overlay(alignment: .bottom) {
        Rectangle()
          .fill(TetherColors.textSecondary.opacity(0.25))
          .frame(height: 1)
      }
      PresentationView(preview: preview, url: url)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .background(TetherColors.background)
  }
}

/// Renders agent-pushed HTML in a WKWebView — port of `PresentationView.native.tsx`.
///
/// SECURITY: matches RN (`originWhitelist=['*']`, JS left at platform default =
/// enabled). No script message handlers, no bridge to SessionStore / Keychain.
public struct PresentationView: View {
  public var preview: Presentation
  public var url: URL

  public init(preview: Presentation, url: URL) {
    self.preview = preview
    self.url = url
  }

  public var body: some View {
    #if canImport(WebKit)
    PresentationWebView(url: url)
      .id("\(preview.id):\(preview.revision)")
    #else
    Text("WebKit unavailable")
      .foregroundStyle(TetherColors.textSecondary)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    #endif
  }
}

#if canImport(WebKit)
private func makePresentationWebView() -> WKWebView {
  let config = WKWebViewConfiguration()
  // RN PresentationView does not set javaScriptEnabled (defaults true).
  // Match that — do not loosen further, and never add a message handler.
  config.defaultWebpagePreferences.allowsContentJavaScript = true
  config.preferences.javaScriptCanOpenWindowsAutomatically = false
  config.userContentController = WKUserContentController()
  let webView = WKWebView(frame: .zero, configuration: config)
  webView.allowsBackForwardNavigationGestures = false
  return webView
}

#if os(iOS)
struct PresentationWebView: UIViewRepresentable {
  let url: URL

  func makeUIView(context: Context) -> WKWebView {
    makePresentationWebView()
  }

  func updateUIView(_ webView: WKWebView, context: Context) {
    if webView.url != url {
      webView.load(URLRequest(url: url))
    }
  }
}

#elseif os(macOS)
struct PresentationWebView: NSViewRepresentable {
  let url: URL

  func makeNSView(context: Context) -> WKWebView {
    makePresentationWebView()
  }

  func updateNSView(_ webView: WKWebView, context: Context) {
    if webView.url != url {
      webView.load(URLRequest(url: url))
    }
  }
}
#endif
#endif
