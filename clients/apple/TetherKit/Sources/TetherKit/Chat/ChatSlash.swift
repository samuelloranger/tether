import Foundation

enum ChatSlash {
  /// The filter text while the draft is still just a command name: "/co" gives "co", "/" gives "".
  static func query(in draft: String) -> String? {
    guard draft.hasPrefix("/") else { return nil }
    let rest = draft.dropFirst()
    return rest.contains(where: \.isWhitespace) ? nil : String(rest)
  }

  /// Name prefix first, then name contains, then description contains; each tier alphabetical.
  static func matches(query: String, commands: [ACPCommand], limit: Int = 20) -> [ACPCommand] {
    let needle = query.lowercased()
    func ordered(_ list: [ACPCommand]) -> [ACPCommand] {
      list.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }
    guard !needle.isEmpty else { return Array(ordered(commands).prefix(max(limit, 0))) }
    var prefix: [ACPCommand] = []
    var inName: [ACPCommand] = []
    var inDescription: [ACPCommand] = []
    for command in commands {
      let name = command.name.lowercased()
      if name.hasPrefix(needle) {
        prefix.append(command)
      } else if name.contains(needle) {
        inName.append(command)
      } else if command.description.lowercased().contains(needle) {
        inDescription.append(command)
      }
    }
    return Array((ordered(prefix) + ordered(inName) + ordered(inDescription)).prefix(max(limit, 0)))
  }

  /// What the composer shows after the user picks a command; `wantsInput` keeps the keyboard up for arguments.
  static func insertion(for command: ACPCommand) -> (text: String, wantsInput: Bool) {
    ("/\(command.name) ", command.hint != nil)
  }
}
