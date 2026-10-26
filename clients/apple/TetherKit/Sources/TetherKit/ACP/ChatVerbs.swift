import Foundation

/// The word a running turn shows, as Claude Code's spinner picks one: its own list, read from the
/// Claude Code installed on the host, with the user's `spinnerVerbs` setting applied. The list never
/// travels over ACP, so the host is asked once; without it Tether's own words stand in.
enum ChatVerbs {
  /// Shown when the host's Claude Code cannot be read.
  static let fallback = [
    "Working", "Thinking", "Pondering", "Tinkering", "Puzzling", "Mulling", "Sketching", "Untangling",
    "Wrangling", "Brewing", "Noodling", "Assembling", "Weaving", "Polishing", "Sifting", "Juggling",
  ]

  private static let settingsMark = "--- settings"

  /// One exec: the list from the installed `claude`, then the user's settings file.
  static var command: String {
    let script = [
      #"PATH="$HOME/.local/bin:$PATH"; "#,
      #"c=$(command -v claude) && LC_ALL=C grep -aoE '\["Accomplishing"(,"[^"]{1,40}")+\]' "#,
      #""$(readlink -f "$c")" 2>/dev/null | head -n 1; "#,
      #"echo '--- settings'; cat "$HOME/.claude/settings.json" 2>/dev/null"#,
    ].joined()
    return "sh -c \(shellQuote(script))"
  }

  /// The words to pick from: the official list (or `fallback`) with `spinnerVerbs` applied the way
  /// Claude Code applies it (`replace` with an empty list keeps the default).
  static func parse(_ output: String) -> [String] {
    let parts = output.components(separatedBy: settingsMark)
    let list = parts.first ?? ""
    let settings = parts.count > 1 ? parts[1] : ""
    var base = list.split(whereSeparator: \.isNewline)
      .first { $0.trimmingCharacters(in: .whitespaces).hasPrefix("[\"") }
      .map { jsStrings(String($0)) } ?? []
    if base.isEmpty { base = fallback }
    guard let data = settings.trimmingCharacters(in: .whitespacesAndNewlines).data(using: .utf8),
      let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let custom = object["spinnerVerbs"] as? [String: Any]
    else { return base }
    let verbs = (custom["verbs"] as? [Any] ?? []).compactMap { ($0 as? String)?.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
    if custom["mode"] as? String == "replace", !verbs.isEmpty { return verbs }
    return base + verbs
  }

  /// The turn's word, the same for the whole turn: `seed` is anything that changes per turn.
  static func pick(_ verbs: [String], seed: Int) -> String {
    let words = verbs.isEmpty ? fallback : verbs
    let mixed = (UInt64(bitPattern: Int64(seed)) &* 0x9E37_79B9_7F4A_7C15) >> 32
    return words[Int(mixed % UInt64(words.count))] + "…"
  }

  /// The string literals of a minified JS array, unescaped (`\xE9`, `’`, `\'`).
  static func jsStrings(_ line: String) -> [String] {
    var out: [String] = []
    var chars = Array(line)[...]
    while let c = chars.popFirst() {
      guard c == "\"" else { continue }
      var word = ""
      while let c = chars.popFirst() {
        if c == "\"" { break }
        guard c == "\\" else { word.append(c); continue }
        guard let escaped = chars.popFirst() else { break }
        switch escaped {
        case "x", "u":
          let digits = String(chars.prefix(escaped == "x" ? 2 : 4))
          chars = chars.dropFirst(digits.count)
          if let value = UInt32(digits, radix: 16), let scalar = Unicode.Scalar(value) { word.append(Character(scalar)) }
        case "n": word.append("\n")
        default: word.append(escaped)
        }
      }
      if !word.trimmingCharacters(in: .whitespaces).isEmpty { out.append(word) }
    }
    return out
  }
}

/// One read per host for the app's life: the list changes only when the host's Claude Code does.
actor ChatVerbCache {
  static let shared = ChatVerbCache()
  private var byHost: [String: [String]] = [:]

  func verbs(config: SSHConnectionConfig, store: HostKeyStore) async -> [String] {
    let key = "\(config.username)@\(config.host):\(config.port)"
    if let known = byHost[key] { return known }
    guard let output = await ACPHostExec.run(command: ChatVerbs.command, config: config, store: store, deadline: 15)
    else { return [] }
    let verbs = ChatVerbs.parse(output)
    byHost[key] = verbs
    return verbs
  }
}
