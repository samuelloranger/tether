/// What the terminal says when prompt navigation or "copy last output" finds nothing.
enum PromptNotice {
  /// The OSC 133 hint only when the shell marked no prompt: with marks, there simply is
  /// nothing in that direction.
  static func text(_ message: String, shellMarksPrompts: Bool) -> String {
    shellMarksPrompts ? message : "\(message) — needs a shell that marks prompts (OSC 133)"
  }
}
