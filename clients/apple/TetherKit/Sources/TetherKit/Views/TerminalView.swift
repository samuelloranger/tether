#if canImport(UIKit)
import SwiftUI
import UIKit

/// Full utility key row for touch input — horizontally scrollable instead of RN paging.
/// Mutable state of the key bar.
///
/// An @Observable class rather than a Binding, because the bar is hosted in a
/// UIHostingController for use as an inputAccessoryView. A Binding does not
/// publish into that separate SwiftUI graph, so the only way to refresh the bar
/// was to reassign the controller's rootView on every updateUIView — and
/// reassigning it made reloadInputViews() rebuild SwiftUI content INSIDE a
/// SwiftUI update. That re-entrancy is what let any focus change spin the main
/// thread at 100% CPU. Observing an object instead lets the bar update on its
/// own, so rootView is assigned exactly once.
@Observable
public final class TerminalAccessoryModel {
  public var ctrlArmed = false
  /// Drives the bar's own slide-out. UIKit's accessory dismissal only travels
  /// the bar's height, which reads as a short hop; this carries it fully off the
  /// bottom before UIKit removes the view.
  public var visible = true
  /// Distance from the window's bottom edge to the TOP of the docked bar, as
  /// the bar itself measures it.
  ///
  /// `barHeight` is only a first-frame fallback (keySize + padding either side).
  /// UIKit docks the bar ~15pt above the screen edge rather than above the 34pt
  /// home indicator, so a fixed constant left dead space between the last
  /// terminal row and the keys. Measuring removes that arithmetic: whatever the
  /// bar actually occupies is what the terminal gives up.
  public var dockedHeight: CGFloat = 0
  public init() {}
}

public struct TerminalAccessoryBar: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  public var model: TerminalAccessoryModel
  public var onKey: (String) -> Void
  public var onPaste: (String) -> Void
  public var onArrow: (DPadDirection) -> Void
  public var onHideKeyboard: () -> Void

  public init(
    model: TerminalAccessoryModel,
    onKey: @escaping (String) -> Void,
    onPaste: @escaping (String) -> Void,
    onArrow: @escaping (DPadDirection) -> Void,
    onHideKeyboard: @escaping () -> Void
  ) {
    self.model = model
    self.onKey = onKey
    self.onPaste = onPaste
    self.onArrow = onArrow
    self.onHideKeyboard = onHideKeyboard
  }

  /// Every key in the bar is this tall, the D-pad included — a control that is
  /// taller than its neighbours reads as a different kind of thing.
  static let keySize: CGFloat = 40
  static let barVerticalPadding: CGFloat = 8
  /// How far above the screen's bottom edge UIKit docks the bar when the
  /// keyboard is down. Not the home-indicator inset (34pt) — UIKit uses its own,
  /// smaller gap, and the terminal has to reserve the difference.
  static let dockedGap: CGFloat = 15
  /// First-frame fallback before GeometryReader reports the real docked height.
  /// Derived from key + padding so it cannot drift from the row's layout again.
  public static let barHeight: CGFloat = keySize + barVerticalPadding * 2

  /// Key order matches `UTILITY_BAR_KEYS` in the RN client. There are no arrow
  /// keys: the D-pad is one square key in the row and covers all four
  /// directions, which is why four separate arrows would be redundant.
  public var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ctrlButton
        accessoryButton("Tab") { send(base: "\t") }
        accessoryButton("Esc") { onKey("\u{1B}") }
        accessoryButton("/") { onKey("/") }
        DpadView(size: Self.keySize, onArrow: onArrow)
        pasteButton
        accessoryButton("Hide", systemImage: "keyboard.chevron.compact.down", action: onHideKeyboard)
        accessoryButton("Del") { onKey("\u{1B}[3~") }
        accessoryButton("Home") { send(base: "\u{1B}[H") }
        accessoryButton("End") { send(base: "\u{1B}[F") }
        accessoryButton("PgUp") { onKey("\u{1B}[5~") }
        accessoryButton("PgDn") { onKey("\u{1B}[6~") }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, Self.barVerticalPadding)
    }
    // ignoresSafeAreaEdges defaults to .all, so the material bled down into the
    // home-indicator strip and the bar read as half again as tall. Confined to
    // its own bounds, the strip below shows the window colour instead — which is
    // the terminal's colour, so it reads as terminal rather than as chrome.
    .background(.ultraThinMaterial, ignoresSafeAreaEdges: [])
    // The bar lives in the keyboard window, so `.global` here is that window's
    // space — which shares the screen's geometry. Reporting its top edge lets
    // the terminal reserve the real height instead of a constant.
    .background(
      GeometryReader { proxy in
        Color.clear
          .onAppear { report(proxy) }
          .onChange(of: proxy.frame(in: .global)) { _, _ in report(proxy) }
      }
    )
    // Slide the whole row clear of the bottom edge rather than letting UIKit
    // nudge it by its own height. Reduce Motion keeps the fade and drops the
    // travel — the bar is a full row leaving the bottom of the screen.
    .offset(y: model.visible || reduceMotion ? 0 : Self.keySize * 2.4)
    .opacity(model.visible ? 1 : 0)
    .animation(
      TetherMotion.ui(TetherMotion.overlay, reduceMotion: reduceMotion),
      value: model.visible
    )
  }


  /// Publishes the bar's docked height, skipping the slide-out frames — while
  /// the bar is animating away its top edge is off-screen, and reporting that
  /// would tell the terminal the bar is taller than it is.
  private func report(_ proxy: GeometryProxy) {
    guard model.visible else { return }
    let frame = proxy.frame(in: .global)
    guard let screen = UIApplication.shared.connectedScenes
      .compactMap({ ($0 as? UIWindowScene)?.screen })
      .first
    else { return }
    // While the keyboard window tears down it hands out frames that start ABOVE
    // the screen (minY < 0), and `screen.maxY - minY` then reads as taller than
    // the display. The old code believed one: a final -17 frame reported a 949pt
    // bar on a 932pt screen, the terminal reserved 915pt of bottom padding, and
    // the whole VStack — title bar included — was squeezed off screen with no
    // later frame to correct it. A bar cannot start off the top of the screen
    // nor be taller than the screen, so those frames are dismissal artefacts.
    guard frame.minY >= 0 else { return }
    let height = max(0, screen.bounds.maxY - frame.minY)
    guard height <= screen.bounds.height else { return }
    guard abs(height - model.dockedHeight) > 0.5 else { return }
    // Deferred by one runloop turn on purpose. The terminal's padding reads this
    // value, and the padding changes the layout that this GeometryReader is
    // measuring — writing it inline is a dependency cycle, which AttributeGraph
    // duly logged. Handing the write to the next turn keeps the measurement and
    // breaks the loop.
    DispatchQueue.main.async { model.dockedHeight = height }
  }

  /// Matches the D-pad's feedback: the clipboard's contents are invisible until
  /// the shell echoes them, so the tap needs its own confirmation.
  private static let pasteFeedback = UIImpactFeedbackGenerator(style: .light)

  /// The system paste control.
  ///
  /// Reading `UIPasteboard.general` directly is denied unless the user
  /// confirms, and the denial is silent — the button appeared to do nothing.
  /// `PasteButton` is granted access without a prompt.
  private var pasteButton: some View {
    PasteButton(payloadType: String.self) { strings in
      guard let text = strings.first else { return }
      Self.pasteFeedback.impactOccurred()
      onPaste(text)
    }
    .labelStyle(.iconOnly)
    .buttonBorderShape(.roundedRectangle(radius: 8))
    .tint(TetherColors.surface)
    .frame(minWidth: Self.keySize, minHeight: Self.keySize)
  }

  /// Arming Ctrl changes what the *next* key does, and nothing on screen moves
  /// except this one face — so it gets the same confirmation the D-pad and the
  /// paste key get.
  private static let armFeedback = UISelectionFeedbackGenerator()

  private var ctrlButton: some View {
    Button {
      Self.armFeedback.selectionChanged()
      model.ctrlArmed.toggle()
    } label: {
      Text(model.ctrlArmed ? "Ctrl ✓" : "Ctrl")
        .contentTransition(.opacity)
    }
    .buttonStyle(TerminalKeyStyle(armed: model.ctrlArmed))
    .accessibilityLabel("Control modifier")
    .accessibilityValue(model.ctrlArmed ? "Armed" : "Off")
  }

  private func accessoryButton(_ title: String, systemImage: String? = nil, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Group {
        if let systemImage {
          Label(title, systemImage: systemImage)
            .labelStyle(.iconOnly)
            .accessibilityLabel(title)
        } else {
          Text(title)
        }
      }
    }
    .buttonStyle(TerminalKeyStyle())
  }

  private func send(base: String) {
    guard model.ctrlArmed else {
      onKey(base)
      return
    }
    model.ctrlArmed = false
    onKey(TerminalKeyMap.ctrlModified(base))
  }
}

/// Bridges the system keyboard to PTY input with an accessory toolbar.
public struct TerminalInputBridge: UIViewRepresentable {
  @Binding public var text: String
  public var accessory: AnyView
  /// Whether to offer the key bar at all. Gating the ACCESSORY is safe; gating
  /// the bridge's existence was not — a view carrying .focused() that appears
  /// and disappears makes SwiftUI's FocusStore and UIKit's first-responder
  /// machinery loop against each other, and the app spins at 100% CPU.
  public var showsAccessory: Bool = true
  public var onSubmitBytes: (String) -> Void
  public var isFocused: Binding<Bool>

  public init(
    text: Binding<String>,
    accessory: AnyView,
    showsAccessory: Bool = true,
    onSubmitBytes: @escaping (String) -> Void,
    isFocused: Binding<Bool>
  ) {
    _text = text
    self.accessory = accessory
    self.showsAccessory = showsAccessory
    self.onSubmitBytes = onSubmitBytes
    self.isFocused = isFocused
  }

  public func makeCoordinator() -> Coordinator {
    Coordinator(onSubmitBytes: onSubmitBytes, isFocused: isFocused)
  }

  public func makeUIView(context: Context) -> TerminalInputTextView {
    let view = TerminalInputTextView()
    view.delegate = context.coordinator
    view.autocorrectionType = .no
    view.autocapitalizationType = .none
    view.spellCheckingType = .no
    view.keyboardType = .asciiCapable
    view.backgroundColor = .clear
    view.textColor = .clear
    view.tintColor = .clear
    view.accessoryHosting.rootView = accessory
    view.showsAccessory = showsAccessory
    // 0x7F (DEL) is what terminals and readline expect from backspace.
    view.onBackspace = { [onSubmitBytes] in onSubmitBytes("\u{7F}") }
    view.onKeyBytes = { [onSubmitBytes] bytes in onSubmitBytes(bytes) }
    view.refillFiller()
    return view
  }

  public func updateUIView(_ uiView: TerminalInputTextView, context: Context) {
    // rootView is set once in makeUIView. Reassigning it here is what made
    // reloadInputViews() rebuild SwiftUI inside a SwiftUI update.
    if uiView.showsAccessory != showsAccessory {
      uiView.showsAccessory = showsAccessory
      uiView.reloadInputViews()
    }
    // The document is not user-visible text — it is invisible filler that keeps
    // the delete key repeating (see `refillFiller`). Syncing the binding here
    // would wipe that filler on every SwiftUI update.
    uiView.refillFiller()
    if isFocused.wrappedValue, !uiView.isFirstResponder {
      uiView.becomeFirstResponder()
    } else if !isFocused.wrappedValue, uiView.isFirstResponder {
      uiView.resignFirstResponder()
    }
  }

  public final class Coordinator: NSObject, UITextViewDelegate {
    let onSubmitBytes: (String) -> Void
    let isFocused: Binding<Bool>

    init(onSubmitBytes: @escaping (String) -> Void, isFocused: Binding<Bool>) {
      self.onSubmitBytes = onSubmitBytes
      self.isFocused = isFocused
    }

    public func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
      if text == "\n" {
        onSubmitBytes("\r")
        return false
      }
      // An EMPTY replacement is a deletion. UIKit reports the software backspace
      // here rather than through `deleteBackward()`, so the previous code — which
      // only forwarded non-empty text — silently dropped every backspace.
      //
      // The deletion is ALLOWED through (unlike every other edit) so the hidden
      // document actually shrinks: UIKit stops auto-repeating a held delete key
      // the moment a press changes nothing. A held key can also escalate to a
      // word deletion, so send one DEL per character removed.
      if text.isEmpty {
        let view = textView as? TerminalInputTextView
        if view?.consumeDeletionByteSent() != true {
          for _ in 0..<max(range.length, 1) { onSubmitBytes("\u{7F}") }
        }
        DispatchQueue.main.async { view?.refillFiller() }
        return true
      }
      onSubmitBytes(text)
      return false
    }

    public func textViewDidEndEditing(_ textView: UITextView) {
      // `updateUIView` can arrive here synchronously from
      // `resignFirstResponder()`. Writing the binding in that callback re-enters
      // SwiftUI while it is still updating this representable and UIKit is
      // tearing down the input accessory view. If SwiftUI already requested the
      // resignation there is nothing to synchronize. Otherwise defer the UIKit-
      // initiated focus loss until both stacks have unwound.
      guard isFocused.wrappedValue else { return }
      DispatchQueue.main.async { [weak textView, isFocused] in
        guard
          let textView,
          !textView.isFirstResponder,
          isFocused.wrappedValue
        else { return }
        isFocused.wrappedValue = false
      }
    }
  }
}

/// Translates hardware key presses into the bytes a PTY expects.
///
/// Keys that produce no text — backspace on an empty buffer, arrows, Ctrl
/// combos, Esc — never reach `UITextViewDelegate`, because there is no text
/// change for UIKit to report. `pressesBegan` sees them all, so the terminal
/// key handling lives here and the delegate is left to handle plain typing.
enum TerminalKeyMap {
  static func bytes(for key: UIKey) -> String? {
    let mods = key.modifierFlags
    let ctrl = mods.contains(.control)
    let alt = mods.contains(.alternate)
    let mod = modifierParam(mods)

    switch key.keyCode {
    case .keyboardUpArrow: return csi("A", mod)
    case .keyboardDownArrow: return csi("B", mod)
    case .keyboardRightArrow: return csi("C", mod)
    case .keyboardLeftArrow: return csi("D", mod)
    case .keyboardHome: return csi("H", mod)
    case .keyboardEnd: return csi("F", mod)
    case .keyboardPageUp: return "\u{1B}[5~"
    case .keyboardPageDown: return "\u{1B}[6~"
    case .keyboardDeleteForward: return "\u{1B}[3~"
    case .keyboardDeleteOrBackspace: return "\u{7F}"
    case .keyboardEscape: return "\u{1B}"
    default: break
    }

    // Plain text is the delegate's job; only modified keys are claimed here,
    // otherwise every character would be sent twice.
    guard ctrl || alt else { return nil }
    guard let ch = key.charactersIgnoringModifiers.first, let ascii = ch.asciiValue else {
      return nil
    }
    if ctrl {
      // Ctrl-@ through Ctrl-_ map onto 0x00-0x1F; lowercase folds to uppercase first.
      let upper = (ascii >= 97 && ascii <= 122) ? ascii - 32 : ascii
      let control = String(UnicodeScalar(upper & 0x1F))
      return alt ? "\u{1B}" + control : control
    }
    return "\u{1B}" + String(ch)
  }

  /// Applies the Ctrl latch to an accessory-bar key.
  ///
  /// A CSI sequence carries its modifier as a parameter. Masking its final
  /// byte instead produced a control code from the wrong character entirely:
  /// Ctrl+Left became 0x04 (EOF) and killed the shell, and Ctrl+Up became
  /// 0x01 (start of line).
  static func ctrlModified(_ sequence: String) -> String {
    guard sequence.hasPrefix("\u{1B}["), let final = sequence.last else { return sequence }
    return "\u{1B}[1;5\(final)"
  }

  /// Folds a latched Ctrl into the next typed character.
  ///
  /// Only printable ASCII has a control form; applying the mask to Return or
  /// DEL would corrupt them.
  static func ctrlFolded(_ text: String) -> String? {
    guard text.count == 1, let ch = text.first, let ascii = ch.asciiValue,
          (0x20...0x7E).contains(ascii)
    else { return nil }
    let upper = (ascii >= 97 && ascii <= 122) ? ascii - 32 : ascii
    return String(UnicodeScalar(upper & 0x1F))
  }

  /// xterm's modifier parameter: 1 + shift(1) + alt(2) + ctrl(4).
  private static func modifierParam(_ m: UIKeyModifierFlags) -> Int {
    var value = 1
    if m.contains(.shift) { value += 1 }
    if m.contains(.alternate) { value += 2 }
    if m.contains(.control) { value += 4 }
    return value
  }

  private static func csi(_ final: String, _ mod: Int) -> String {
    mod == 1 ? "\u{1B}[" + final : "\u{1B}[1;\(mod)" + final
  }
}

public final class TerminalInputTextView: UITextView {
  let accessoryHosting = UIHostingController<AnyView>(rootView: AnyView(EmptyView()))

  /// Receives the bytes for any hardware key the terminal claims.
  var onKeyBytes: ((String) -> Void)?

  /// Software-keyboard backspace. The on-screen delete key routes here rather
  /// than through `pressesBegan`, and reports an empty replacement string to
  /// the delegate, so it needs its own hook.
  var onBackspace: (() -> Void)?

  /// UIKit only routes the software delete key to `deleteBackward()` while the
  /// input view reports that it has something to delete. This view's text is
  /// always empty — the delegate refuses every change and forwards bytes to the
  /// PTY instead — so `hasText` was always false and the on-screen backspace
  /// did nothing at all. Claiming text unconditionally restores the key.
  public override var hasText: Bool { true }

  /// The hidden document is kept stocked with invisible filler so the system
  /// keyboard's delete key always has something to consume. Holding the key
  /// only auto-repeats while each press actually shortens the document; a view
  /// that refuses every edit gets one `deleteBackward()` and the repeat stalls
  /// after it, which is why holding backspace deleted a single character.
  private static let filler = "\u{00A0}"
  private static let fillerCount = 64

  /// `deleteBackward()` emits the byte itself and then lets UIKit perform the
  /// real deletion, which re-enters the delegate. Without this the delegate
  /// would send a second DEL for the same keypress.
  private var deletionByteAlreadySent = false

  /// Called by the delegate: true when this deletion's byte was already sent.
  func consumeDeletionByteSent() -> Bool {
    defer { deletionByteAlreadySent = false }
    return deletionByteAlreadySent
  }

  /// Tops the document back up, prepending so the caret stays at the end — a
  /// selection change mid-repeat cancels the repeat.
  func refillFiller() {
    let missing = Self.fillerCount - (text as NSString).length
    guard missing > 0 else { return }
    text = String(repeating: Self.filler, count: missing) + text
    selectedRange = NSRange(location: (text as NSString).length, length: 0)
  }

  public override func deleteBackward() {
    onBackspace?()
    deletionByteAlreadySent = true
    super.deleteBackward()
    deletionByteAlreadySent = false
    refillFiller()
  }

  public override func becomeFirstResponder() -> Bool {
    refillFiller()
    return super.becomeFirstResponder()
  }

  public override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    var unhandled: Set<UIPress> = []
    for press in presses {
      if let key = press.key, let bytes = TerminalKeyMap.bytes(for: key) {
        onKeyBytes?(bytes)
      } else {
        unhandled.insert(press)
      }
    }
    if !unhandled.isEmpty {
      super.pressesBegan(unhandled, with: event)
    }
  }

  /// Configured once rather than on every getter call — the previous version
  /// mutated the hosting view's frame and background each time UIKit asked for
  /// the accessory, which UIKit does often.
  private lazy var accessoryContainer: UIView = {
    let view = accessoryHosting.view!
    // Ask the bar how tall it is instead of asserting 52pt. The keys are 40pt
    // with 8pt padding either side, so the assertion clipped 4pt off the row and
    // then reserved the wrong amount of terminal for it.
    let width = view.window?.bounds.width
      ?? (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.screen.bounds.width
      ?? 390
    let fitted = accessoryHosting.sizeThatFits(
      in: CGSize(width: width, height: .greatestFiniteMagnitude))
    view.frame.size.height = fitted.height > 0 ? fitted.height : TerminalAccessoryBar.barHeight
    view.backgroundColor = .clear
    return view
  }()


  private var assignedAccessoryView: UIView?

  /// UIKit declares `inputAccessoryView` as settable, so an override must
  /// supply a setter as well — a get-only override fails to compile with
  /// "cannot override mutable property with read-only property".
  ///
  /// The keyboard accessory is owned by this view; an explicit assignment from
  /// outside still wins, which keeps the property honest rather than silently
  /// ignoring the setter.
  /// Set false when there is no session, so the key bar does not sit on screen
  /// with nothing to act on.
  var showsAccessory = true

  public override var inputAccessoryView: UIView? {
    get {
      guard showsAccessory else { return assignedAccessoryView }
      return assignedAccessoryView ?? accessoryContainer
    }
    set { assignedAccessoryView = newValue }
  }

  public override var canBecomeFirstResponder: Bool { true }

  /// With a hardware keyboard attached (and on iPad generally) UIKit renders the
  /// system input-assistant shortcuts bar for the first responder. This view has
  /// no shortcuts to offer, so it showed up as an empty strip along the bottom.
  /// Emptying both groups removes the bar rather than leaving it blank.
  public override init(frame: CGRect, textContainer: NSTextContainer?) {
    super.init(frame: frame, textContainer: textContainer)
    inputAssistantItem.leadingBarButtonGroups = []
    inputAssistantItem.trailingBarButtonGroups = []
  }

  public required init?(coder: NSCoder) {
    super.init(coder: coder)
    inputAssistantItem.leadingBarButtonGroups = []
    inputAssistantItem.trailingBarButtonGroups = []
  }
}

/// What the terminal area should show when there is nothing to stream.
///
/// A void with a live key bar above it is not an empty state — it gives the
/// reader nothing to do and no idea what is missing. Each case names the thing
/// that is absent and offers the one action that resolves it.
struct TerminalPlaceholder: View {
  enum Reason {
    case noHost
    case noSession
  }

  let reason: Reason
  let onAddHost: () -> Void
  let onNewTerminal: () -> Void

  var body: some View {
    VStack(spacing: 14) {
      Image(systemName: reason == .noHost ? "server.rack" : "terminal")
        .font(.system(size: 34, weight: .light))
        .foregroundStyle(TetherColors.textSecondary)
      VStack(spacing: 5) {
        Text(reason == .noHost ? "No server yet" : "No session open")
          .font(.headline)
          .foregroundStyle(TetherColors.textPrimary)
        Text(
          reason == .noHost
            ? "Add the machine you want a shell on. Tether pairs with it once and remembers."
            : "Start a terminal to pick up where the shell left off."
        )
        .font(.footnote)
        .foregroundStyle(TetherColors.textSecondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 280)
      }
      Button(reason == .noHost ? "Add a server" : "New terminal") {
        reason == .noHost ? onAddHost() : onNewTerminal()
      }
      .font(.subheadline.weight(.semibold))
      .padding(.horizontal, 18)
      .padding(.vertical, 10)
      .background(TetherColors.accent)
      .foregroundStyle(TetherColors.onAccent)
      .clipShape(Capsule())
      .padding(.top, 2)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(TetherColors.terminalBackground)
  }
}

public struct TerminalView: View {
  @Bindable public var store: SessionStore
  @Bindable public var preferences: AppPreferences
  /// Routed from RootView so the empty state can open pairing.
  public var onAddHost: () -> Void = {}
  /// True while an in-app overlay (the session drawer) is covering the terminal.
  ///
  /// The key bar is an inputAccessoryView, so it lives in the KEYBOARD window —
  /// above the app's own window. An in-app overlay cannot cover it, and the bar
  /// drew across the drawer, clipping its "New terminal" button. A sheet does not
  /// have this problem because presenting one takes first responder away.
  public var overlayPresented: Bool = false
  /// Opens a workspace file path detected in the terminal grid.
  public var onOpenFile: (String, Int?, Int?) -> Void = { _, _, _ in }
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var accessory = TerminalAccessoryModel()
  @State private var inputBuffer = ""
  @State private var scrollOffsetFromBottom = 0
  @State private var selectionText: String?
  /// How far the keyboard (plus its accessory bar) overlaps this view.
  ///
  /// Measured rather than left to SwiftUI's automatic avoidance: the first
  /// responder here is a UIKit UITextView carrying its own inputAccessoryView,
  /// not a SwiftUI field, and the implicit avoidance does not engage for it —
  /// the terminal simply stayed full height and the keyboard covered the last
  /// rows. Shrinking the view also makes TetherSurfaceView.reportGridSize fire,
  /// so the PTY learns the new row count.
  @State private var keyboardInset: CGFloat = 0
  // UIKit is the single owner of first-responder changes through
  // TerminalInputBridge. Combining this binding with SwiftUI's `.focused`
  // modifier created two focus controllers that could both resign the text view
  // and feed state back while its inputAccessoryView was being removed.
  @State private var keyboardFocused = false

  public init(
    store: SessionStore,
    preferences: AppPreferences,
    onAddHost: @escaping () -> Void = {},
    overlayPresented: Bool = false,
    onOpenFile: @escaping (String, Int?, Int?) -> Void = { _, _, _ in }
  ) {
    self.store = store
    self.preferences = preferences
    self.onAddHost = onAddHost
    self.overlayPresented = overlayPresented
    self.onOpenFile = onOpenFile
  }

  public var body: some View {
    VStack(spacing: 0) {
      ZStack(alignment: .topTrailing) {
        if let placeholder = placeholderReason {
          TerminalPlaceholder(
            reason: placeholder,
            onAddHost: onAddHost,
            onNewTerminal: { Task { await store.newTerminal() } }
          )
          // Crossfade with the grid rather than cut: the first session of the
          // day replaces this view, and a hard swap there reads as a reload.
          .transition(.opacity)
        } else {
        TetherSurfaceRepresentable(
          snapshot: $store.terminalSnapshot,
          fontName: preferences.terminalFont.postScriptName,
          fontSize: preferences.terminalFontSize,
          onGridSizeChange: { cols, rows in store.updateGrid(cols: cols, rows: rows) },
          onScrollLines: { lines in
            store.scrollViewport(lines: lines)
            scrollOffsetFromBottom = max(0, scrollOffsetFromBottom + Int(lines))
          },
          onTap: { keyboardFocused = true },
          onSelectionText: { text in selectionText = text },
          onOpenURL: { url in UIApplication.shared.open(url) },
          onOpenFile: onOpenFile,
          onMouseBytes: { store.sendInput($0) },
          mouseMode: store.terminalMouseMode,
          mouseSgr: store.terminalMouseSgr
        )
        // No inset. The gutter that used to be here cost two columns and, being
        // a different colour from the grid, was itself half of the frame the
        // terminal appeared to sit inside.
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Must match TetherSurfaceView's own backgroundColor. Any area the grid
        // does not cover — the remainder below the last whole row, and the
        // home-indicator inset — shows this through, and Color.black read as a
        // dead strip against the terminal's navy.
        .background(TetherColors.terminalBackground)

        }

        if scrollOffsetFromBottom > 0 {
          ScrollPositionIndicator(offset: scrollOffsetFromBottom)
            .padding(.trailing, 4)
            .padding(.top, 8)
            // Fades in when you leave the live tail and out when you catch up.
            // It appeared and vanished mid-scroll, which read as a rendering
            // artefact of the scroll rather than as an answer to "where am I".
            .transition(.opacity)
        }

        if let selectionText, !selectionText.isEmpty {
          selectionChrome(text: selectionText)
        }

      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      // Scoped to these three values so nothing here can animate the grid: the
      // terminal surface must never be walked through intermediate sizes.
      .animation(
        TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion),
        value: scrollOffsetFromBottom > 0
      )
      .animation(
        TetherMotion.ui(TetherMotion.state, reduceMotion: reduceMotion),
        value: selectionText == nil
      )
      .animation(
        TetherMotion.ui(TetherMotion.overlay, reduceMotion: reduceMotion),
        value: placeholderReason
      )

      TerminalInputBridge(
        text: $inputBuffer,
        accessory: AnyView(
          TerminalAccessoryBar(
            model: accessory,
            onKey: { store.sendInput($0) },
            onPaste: { store.sendPaste($0) },
            onArrow: { store.sendInput($0.escapeSequence) },
            // Deferred by one runloop turn, like `report` above and for the
            // same reason. This button lives inside the accessory bar, which is
            // the inputAccessoryView's own UIHostingController. Dropping focus
            // synchronously makes UIKit dismiss the keyboard and tear that
            // hosting view down while the touch that triggered it is still being
            // delivered to it — the view is deallocated underneath its own
            // handler, which crashes the app. One turn later the touch is
            // finished and the teardown has nothing live to pull out from under.
            onHideKeyboard: { DispatchQueue.main.async { keyboardFocused = false } }
          )
        ),
        showsAccessory: accessoryVisible,
        onSubmitBytes: submit,
        isFocused: Binding(
          get: { keyboardFocused },
          set: { keyboardFocused = $0 }
        )
      )
      .frame(height: 1)
    }
    // The terminal's own colour, not the chrome colour. .background() bleeds into
    // the safe area by default, so this painted #11111b over the window backdrop
    // in the home-indicator strip — which is exactly the band that showed on the
    // startup screen and with the sidebar open, the two states where the key bar
    // is not there to cover it.
    .background(TetherColors.terminalBackground)
    // The bar is an inputAccessoryView: it floats above the app, and it stays
    // docked when the keyboard is down. Padding by the keyboard alone left the
    // last terminal rows underneath it, because keyboardWillHide zeroes the
    // inset while the bar is still on screen. Reserve whichever is taller.
    // The bar's measured height, minus the container's own bottom inset — this
    // padding is applied INSIDE the safe area, so not subtracting it stacks the
    // two and leaves a home-indicator-sized band above the keys.
    .padding(.bottom, max(keyboardInset, accessoryVisible ? accessoryReserve : 0))
    // keyboardWillChangeFrame already carries the END frame, so go straight to the
    // final height. Animating this padding would walk the view through
    // intermediate heights, and every one of those is a grid size the surface
    // would otherwise report.
    .animation(nil, value: keyboardInset)
    .onReceive(
      NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)
    ) { note in
      keyboardInset = Self.keyboardOverlap(note)
    }
    .onReceive(
      NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)
    ) { _ in
      keyboardInset = 0
    }
    // Animate the bar out BEFORE UIKit removes it, so it leaves downward instead
    // of blinking. Only the model is written here — no focus, no input views —
    // so this cannot re-enter the update the way the earlier attempts did.
    .onChange(of: accessoryVisible, initial: true) { _, shown in
      accessory.visible = shown
    }
    .onAppear {
      // Only claim the keyboard when there is a session to type into. Focusing
      // with nothing open put the key bar on screen with nothing to act on.
      keyboardFocused = placeholderReason == nil
    }
    .onChange(of: store.activeSessionId) { _, _ in
      scrollOffsetFromBottom = 0
      selectionText = nil
    }
  }

  @ViewBuilder
  private func selectionChrome(text: String) -> some View {
    VStack {
      Spacer()
      HStack {
        Spacer()
        Button {
          Self.copyFeedback.impactOccurred()
          UIPasteboard.general.string = text
          selectionText = nil
        } label: {
          Label("Copy", systemImage: "doc.on.doc")
            .font(.callout.weight(.semibold))
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(TetherColors.accent)
            .foregroundStyle(TetherColors.onAccent)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .padding(12)
      }
    }
    // Rises from the corner it sits in, and leaves the same way. Reduce Motion
    // keeps the fade only.
    .transition(
      reduceMotion
        ? .opacity
        : .opacity.combined(with: .move(edge: .bottom))
    )
  }

  /// Copying is a silent success — the selection disappears and nothing else
  /// changes — so it gets the same light tap the D-pad and paste key give.
  private static let copyFeedback = UIImpactFeedbackGenerator(style: .light)

  /// Height of the window the keyboard's end frame covers. Uses the window
  /// rather than UIScreen so it stays correct in a resized or split window.
  private static func keyboardOverlap(_ note: Notification) -> CGFloat {
    guard
      let end = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
      let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
      let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first
    else { return 0 }
    // The container's bottom inset is ALREADY reserved by the layout, and this
    // padding is applied inside it. Without subtracting it the two stack and
    // leave a dead band the height of the home indicator between the last
    // terminal row and the key bar.
    return max(0, window.bounds.maxY - end.minY - window.safeAreaInsets.bottom)
  }

  private var accessoryVisible: Bool { placeholderReason == nil && !overlayPresented }

  /// Padding that puts the last terminal row exactly on the bar's top edge.
  /// Falls back to the constant only for the first frame, before the bar has
  /// laid out and measured itself.
  private var accessoryReserve: CGFloat {
    let inset = Self.bottomSafeInset()
    // The bar always covers at least itself plus the gap UIKit docks it above
    // the screen edge, and it can never cover more than the keyboard plus that.
    // Both ends matter: the measurement is taken in the keyboard's own window,
    // which reports garbage while that window is being torn down, and a single
    // believed outlier (949pt on a 932pt screen) once padded the whole VStack —
    // title bar included — off the display with no later frame to correct it.
    let floor = TerminalAccessoryBar.barHeight + TerminalAccessoryBar.dockedGap
    let ceiling = keyboardInset + floor
    let measured = accessory.dockedHeight
    guard measured > 0 else { return max(0, floor - inset) }
    return max(0, max(floor, min(measured, ceiling)) - inset)
  }

  private static func bottomSafeInset() -> CGFloat {
    guard
      let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
      let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first
    else { return 0 }
    return window.safeAreaInsets.bottom
  }

  /// Nothing to stream: either no server is paired, or none is open.
  private var placeholderReason: TerminalPlaceholder.Reason? {
    if store.hosts.isEmpty { return .noHost }
    if store.activeSessionId == nil { return .noSession }
    return nil
  }

  /// Sends typed input, folding in a latched Ctrl.
  ///
  /// The Ctrl button used to affect only the five keys that routed through
  /// `send`, so the on-screen keyboard could not produce Ctrl+C at all.
  private func submit(_ text: String) {
    if accessory.ctrlArmed, let folded = TerminalKeyMap.ctrlFolded(text) {
      accessory.ctrlArmed = false
      store.sendInput(folded)
      return
    }
    store.sendInput(text)
  }
}

/// Thin thumb on the trailing edge while scrolled into history.
struct ScrollPositionIndicator: View {
  var offset: Int

  var body: some View {
    GeometryReader { geo in
      let track = max(geo.size.height - 24, 1)
      // Approximate: more offset → thumb closer to top. Cap visual travel.
      let progress = min(1, CGFloat(offset) / 200)
      let thumbH: CGFloat = 36
      let y = 12 + (1 - progress) * (track - thumbH)
      Capsule()
        .fill(TetherColors.textSecondary.opacity(0.55))
        .frame(width: 3, height: thumbH)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .offset(y: y)
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}
#endif
