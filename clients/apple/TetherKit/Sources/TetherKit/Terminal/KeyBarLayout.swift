import Foundation

/// A key the app provides for the bar above the keyboard.
public enum BuiltInKey: String, CaseIterable, Codable, Identifiable, Sendable {
  case ctrl, alt, tab, esc, slash, dpad, paste, hide, del, home, end, pgUp, pgDn, fn
  case pipe, tilde, dash, underscore, colon, backtick
  case ctrlC, ctrlD, ctrlZ, ctrlL

  public var id: String { rawValue }

  /// What the key face shows.
  public var label: String {
    switch self {
    case .ctrl: "Ctrl"
    case .alt: "Alt"
    case .tab: "Tab"
    case .esc: "Esc"
    case .slash: "/"
    case .dpad: "D-pad"
    case .paste: "Paste"
    case .hide: "Hide"
    case .del: "Del"
    case .home: "Home"
    case .end: "End"
    case .pgUp: "PgUp"
    case .pgDn: "PgDn"
    case .fn: "Fn"
    case .pipe: "|"
    case .tilde: "~"
    case .dash: "-"
    case .underscore: "_"
    case .colon: ":"
    case .backtick: "`"
    case .ctrlC: "^C"
    case .ctrlD: "^D"
    case .ctrlZ: "^Z"
    case .ctrlL: "^L"
    }
  }

  /// What the key does, for the editor's list.
  public var detail: String? {
    switch self {
    case .ctrl: "Modifier for the next key"
    case .alt: "Sends Esc before the next key"
    case .slash: "Hold for \\"
    case .dpad: "Arrow keys"
    case .hide: "Hide the keyboard"
    case .fn: "F1–F12"
    case .ctrlC: "Interrupt"
    case .ctrlD: "End of input"
    case .ctrlZ: "Suspend"
    case .ctrlL: "Clear the screen"
    default: nil
    }
  }

  /// The bytes a plain key sends before any armed modifier; nil for keys that do
  /// something else (modifiers, menus, paste, the D-pad).
  var bytes: String? {
    switch self {
    case .tab: "\t"
    case .esc: "\u{1B}"
    case .del: "\u{1B}[3~"
    case .home: "\u{1B}[H"
    case .end: "\u{1B}[F"
    case .pgUp: "\u{1B}[5~"
    case .pgDn: "\u{1B}[6~"
    case .pipe: "|"
    case .tilde: "~"
    case .dash: "-"
    case .underscore: "_"
    case .colon: ":"
    case .backtick: "`"
    case .ctrlC: "\u{03}"
    case .ctrlD: "\u{04}"
    case .ctrlZ: "\u{1A}"
    case .ctrlL: "\u{0C}"
    case .ctrl, .alt, .slash, .dpad, .paste, .hide, .fn: nil
    }
  }

  /// Whether armed Ctrl/Alt apply to this key. Esc, Del, PgUp/PgDn and the control
  /// presets send exactly their bytes and leave a latch armed.
  var takesModifiers: Bool {
    switch self {
    case .tab, .home, .end, .pipe, .tilde, .dash, .underscore, .colon, .backtick: true
    default: false
    }
  }

  /// F1–F12 as xterm sends them.
  static let functionKeys: [(label: String, bytes: String)] = [
    ("F1", "\u{1B}OP"), ("F2", "\u{1B}OQ"), ("F3", "\u{1B}OR"), ("F4", "\u{1B}OS"),
    ("F5", "\u{1B}[15~"), ("F6", "\u{1B}[17~"), ("F7", "\u{1B}[18~"), ("F8", "\u{1B}[19~"),
    ("F9", "\u{1B}[20~"), ("F10", "\u{1B}[21~"), ("F11", "\u{1B}[23~"), ("F12", "\u{1B}[24~"),
  ]
}

/// A key you made that types a string. `text` keeps its escapes; see `MacroText`.
public struct MacroKey: Codable, Equatable, Identifiable, Sendable {
  public var id: UUID
  public var label: String
  public var text: String

  public init(id: UUID = UUID(), label: String, text: String) {
    self.id = id
    self.label = label
    self.text = text
  }

  /// Longer labels don't fit a key face.
  public static let maxLabelLength = 6
}

public enum KeyBarItem: Equatable, Identifiable, Sendable {
  case builtIn(BuiltInKey)
  case macro(MacroKey)

  public var id: String {
    switch self {
    case let .builtIn(key): "key.\(key.rawValue)"
    case let .macro(macro): "macro.\(macro.id.uuidString)"
    }
  }
}

/// The keys in the bar, in order.
public struct KeyBarLayout: Equatable, Sendable {
  public var items: [KeyBarItem]

  public init(items: [KeyBarItem]) {
    self.items = items
  }

  /// The bar as it shipped before it could be edited.
  public static let `default` = KeyBarLayout(items: [
    .builtIn(.ctrl), .builtIn(.tab), .builtIn(.esc), .builtIn(.slash), .builtIn(.dpad),
    .builtIn(.paste), .builtIn(.hide), .builtIn(.del), .builtIn(.home), .builtIn(.end),
    .builtIn(.pgUp), .builtIn(.pgDn),
  ])

  /// Built-in keys not in the bar, in catalog order.
  public var availableKeys: [BuiltInKey] {
    BuiltInKey.allCases.filter { !items.contains(.builtIn($0)) }
  }

  public mutating func add(_ key: BuiltInKey) {
    guard !items.contains(.builtIn(key)) else { return }
    items.append(.builtIn(key))
  }

  public mutating func save(_ macro: MacroKey) {
    if let index = items.firstIndex(where: { $0.id == KeyBarItem.macro(macro).id }) {
      items[index] = .macro(macro)
    } else {
      items.append(.macro(macro))
    }
  }

  private struct Stored: Codable {
    var key: String?
    var macro: MacroKey?
  }

  /// One malformed entry must not cost the rest of the bar.
  private struct Lenient: Decodable {
    var stored: Stored?
    init(from decoder: Decoder) throws { stored = try? Stored(from: decoder) }
  }

  public func encoded() -> Data {
    let stored = items.map { item -> Stored in
      switch item {
      case let .builtIn(key): Stored(key: key.rawValue)
      case let .macro(macro): Stored(macro: macro)
      }
    }
    return (try? JSONEncoder().encode(stored)) ?? Data()
  }

  /// Keys from a newer or older build that this one doesn't know are dropped, as are
  /// repeats; nil when the data isn't a saved bar at all.
  public static func decode(_ data: Data) -> KeyBarLayout? {
    guard let entries = try? JSONDecoder().decode([Lenient].self, from: data) else { return nil }
    let stored = entries.compactMap(\.stored)
    var seen = Set<String>()
    let items = stored.compactMap { entry -> KeyBarItem? in
      let item: KeyBarItem
      if let macro = entry.macro {
        item = .macro(macro)
      } else if let raw = entry.key, let key = BuiltInKey(rawValue: raw) {
        item = .builtIn(key)
      } else {
        return nil
      }
      return seen.insert(item.id).inserted ? item : nil
    }
    return KeyBarLayout(items: items)
  }
}
