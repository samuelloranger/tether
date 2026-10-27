import Foundation

/// What a host needs before a chat can start: a `tether` of this app's protocol, and Node for
/// the adapter. One exec reports both, so a new chat never fails silently later.
enum ACPHostCheck {
  /// The lowest `tether version` protocol this app works with; bump with the host tool's `protocol`.
  static let requiredProtocol = 1
  /// From this protocol a new chat's holder lets several clients attach (`attach --client`).
  static let multiClientProtocol = 2

  enum Problem: Equatable {
    case tetherMissing
    case tetherForeign
    case tetherOutdated
    case nodeMissing
  }

  /// A POSIX script run through `sh -c` so the host's login shell (fish, say) does not matter. It
  /// reports on stdout, because the control exec returns neither stderr nor an exit status. The
  /// `tether` found may be the retired v4 server, so the probe is time-boxed and judged by its JSON.
  static let script = [
    "PATH=\"$HOME/.local/bin:$PATH\"; export PATH",
    "T=\"\"; if command -v timeout >/dev/null 2>&1; then T=\"timeout 5\"; fi",
    "if command -v tether >/dev/null 2>&1; then echo tether=found; "
      + "echo \"version=$($T tether version --json </dev/null 2>/dev/null | head -n 1)\"; "
      + "else echo tether=missing; fi",
    "if command -v npx >/dev/null 2>&1; then echo node=ok; else echo node=missing; fi",
  ].joined(separator: "; ")

  static var command: String { "sh -c \(shellQuote(script))" }

  private struct Version: Decodable {
    var name: String?
    var protocolNumber: Int?
    enum CodingKeys: String, CodingKey {
      case name
      case protocolNumber = "protocol"
    }
  }

  /// A line the host did not report is not a problem: only what it said counts.
  static func problems(in output: String) -> [Problem] {
    var found: [Problem] = []
    let lines = output.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
    if lines.contains("tether=missing") {
      found.append(.tetherMissing)
    } else if lines.contains("tether=found") {
      let json = lines.first { $0.hasPrefix("version=") }.map { String($0.dropFirst("version=".count)) } ?? ""
      let version = json.data(using: .utf8).flatMap { try? JSONDecoder().decode(Version.self, from: $0) }
      if version?.name != "tether" {
        found.append(.tetherForeign)
      } else if (version?.protocolNumber ?? 0) < requiredProtocol {
        found.append(.tetherOutdated)
      }
    }
    if lines.contains("node=missing") { found.append(.nodeMissing) }
    return found
  }

  /// Whether the host's `tether` starts holders that take several clients.
  static func multiClient(in output: String) -> Bool {
    output.split(whereSeparator: \.isNewline)
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { $0.hasPrefix("version=") }
      .compactMap { Data($0.dropFirst("version=".count).utf8) }
      .compactMap { try? JSONDecoder().decode(Version.self, from: $0) }
      .contains { $0.name == "tether" && ($0.protocolNumber ?? 0) >= multiClientProtocol }
  }

  static func message(for problems: [Problem], host: String) -> String? {
    guard !problems.isEmpty else { return nil }
    var parts: [String] = []
    if problems.contains(.tetherMissing) {
      parts.append("Install tether on \(host) (install.sh). tether-notify is now called tether.")
    } else if problems.contains(.tetherForeign) {
      parts.append(
        "Another program named tether is installed on \(host) (the old Tether server). Run install.sh there to replace it.")
    } else if problems.contains(.tetherOutdated) {
      parts.append("Update tether on \(host) (install.sh).")
    }
    if problems.contains(.nodeMissing) {
      parts.append("Node.js is required on \(host).")
    }
    return parts.joined(separator: " ")
  }

  /// `problem` is nil when the host is ready or cannot be checked: a failed connection is reported
  /// by the chat's own dial.
  /// `needsNode` is false for an agent that is not run through npx.
  static func verify(
    host: String, needsNode: Bool = true, exec: (String) async throws -> String
  ) async -> (problem: String?, multiClient: Bool) {
    guard let output = try? await exec(command) else { return (nil, false) }
    let found = problems(in: output).filter { needsNode || $0 != .nodeMissing }
    return (message(for: found, host: host), multiClient(in: output))
  }
}

enum ChatStart: Equatable {
  case ready(ChatRoute)
  case failed(String)
}

extension ChatRoute {
  /// A fresh chat, after the host checks. The failure text is for the new-chat UI as it stands.
  static func start(
    cwdText: String, host: String, agent: ChatAgentProfile = ChatAgents.claude, picks: [String: String]? = nil,
    changed: Set<String> = [], exec: (String) async throws -> String
  ) async -> ChatStart {
    let check = await ACPHostCheck.verify(host: host, needsNode: agent.key != ChatAgents.opencode.key, exec: exec)
    if let message = check.problem { return .failed(message) }
    guard var route = await fresh(cwdText: cwdText, exec: exec) else {
      return .failed("Couldn't read the host's home folder.")
    }
    route.multiClient = check.multiClient
    route.agentKey = agent.key
    route.optionPicks = picks
    route.changedPicks = changed
    route.startedHere = true
    return .ready(route)
  }
}
