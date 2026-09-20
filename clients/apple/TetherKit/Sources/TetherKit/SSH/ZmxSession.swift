import Foundation

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
