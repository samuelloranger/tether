import Foundation

/// POSIX single-quote escaping for a shell argument (zmx/git/notify commands run
/// over `ssh exec`).
public func shellQuote(_ value: String) -> String {
  "'" + value.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
}

/// The attach line is typed into a shell, so a control character (a newline above all) would end
/// the command line early and a leading `-` would be read as a flag. Mirrors `valid_session_name`
/// in tether-core; the control-character check also covers surrounding whitespace.
public func isValidZmxSessionName(_ name: String) -> Bool {
  let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
  return !trimmed.isEmpty && !trimmed.hasPrefix("-")
    && !name.unicodeScalars.contains { $0.properties.generalCategory == .control }
}

public struct ZmxSession: Equatable, Identifiable, Sendable {
  public var name: String
  public var pid: Int
  public var clients: Int
  public var created: Int
  public var cwd: String

  public var id: String { name }

  public var displayCwd: String {
    guard cwd.hasPrefix("file://") else { return cwd }
    let afterScheme = cwd.dropFirst("file://".count)
    guard let slash = afterScheme.firstIndex(of: "/") else { return String(afterScheme) }
    return String(afterScheme[slash...])
  }

  public static func parse(_ output: String) -> [ZmxSession] {
    output.split(separator: "\n").compactMap { line in
      var fields: [String: String] = [:]
      for pair in line.split(separator: "\t") {
        let trimmed = pair.trimmingCharacters(in: .whitespaces)
        guard let eq = trimmed.firstIndex(of: "=") else { continue }
        fields[String(trimmed[..<eq])] = String(trimmed[trimmed.index(after: eq)...])
      }
      guard let name = fields["name"], !name.isEmpty else { return nil }
      return ZmxSession(
        name: name,
        pid: Int(fields["pid"] ?? "") ?? 0,
        clients: Int(fields["clients"] ?? "") ?? 0,
        created: Int(fields["created"] ?? "") ?? 0,
        cwd: fields["cwd"] ?? ""
      )
    }
  }
}
