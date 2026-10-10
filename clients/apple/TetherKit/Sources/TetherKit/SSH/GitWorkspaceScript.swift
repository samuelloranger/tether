import Foundation

/// A patch as the screen shows it: parsed files, plus whether the host cut it short.
public struct GitPatch: Equatable, Sendable {
  public var body = ""
  public var files: [DiffFile] = []
  public var truncated = false

  public static let empty = GitPatch()

  /// Parses off the caller's actor: a large patch is too much work for the main thread.
  static func parse(_ output: String, splittingCommitMessage: Bool = false) async -> GitPatch {
    await Task.detached(priority: .userInitiated) {
      let (capped, truncated) = GitWorkspaceScript.capped(output)
      let shown = splittingCommitMessage ? GitDiffModel.commitShow(capped) : (body: "", patch: capped)
      return GitPatch(body: shown.body, files: DiffFile.group(GitDiffModel.classify(shown.patch)), truncated: truncated)
    }.value
  }
}

/// What one refresh of the git screen read.
enum GitWorkspaceRead: Equatable, Sendable {
  case notRepository(cwd: String)
  case repository(GitWorkspaceSections)
  case unreadable
}

struct GitWorkspaceSections: Equatable, Sendable {
  enum Commits: Equatable, Sendable {
    /// HEAD has not moved since the list on screen was read.
    case unchanged
    case list(head: String, [GitCommit])
  }

  var cwd: String
  var branch: String
  var untracked: [String]
  var untrackedTruncated: Bool
  var commits: Commits
  var diff: String
  var diffTruncated: Bool
}

/// The git screen's shell side. Each refresh is one exec: the session shell's working
/// directory is resolved on the host in the same command, not in a round trip of its own.
enum GitWorkspaceScript {
  /// A patch past this is cut at the last whole line; the screen says so.
  static let byteCap = 2 * 1024 * 1024
  static let untrackedCap = 200
  static let noCwd = "__TETHER_NOCWD__"
  static let notRepository = "__TETHER_NOTREPO__"
  /// The commits section when HEAD is where it was.
  static let unchanged = "="
  static let git = "git -c core.quotePath=false --no-pager"

  /// `cd` into the shell's live cwd (or the one it last reported), then print it, so every
  /// command after this runs where the user is. Prints `noCwd` and stops when there is none.
  static func enterCwd(pid: Int, fallback: String?, announce: Bool = true) -> String {
    let fallbackWord = fallback.map(shellQuote) ?? "''"
    return "d=$(readlink /proc/\(pid)/cwd 2>/dev/null); [ -n \"$d\" ] || d=\(fallbackWord); "
      + "if [ -z \"$d\" ] || ! cd \"$d\" 2>/dev/null; then printf '%s' \(noCwd); exit 0; fi; "
      + (announce ? "printf '%s\\034' \"$d\"; " : "")
  }

  /// Splits `enterCwd`'s announcement from the command's output; nil when there was no cwd.
  static func splitCwd(_ output: String) -> (cwd: String, output: String)? {
    guard output != noCwd, let marker = output.firstIndex(of: "\u{1C}") else { return nil }
    return (String(output[..<marker]), String(output[output.index(after: marker)...]))
  }

  /// Head-capped so a huge patch can't flood the link or the phone.
  static func capping(_ command: String) -> String {
    "\(command) 2>&1 | head -c \(byteCap + 1)"
  }

  /// The working tree against HEAD: staged and unstaged together. An unborn branch has no
  /// HEAD, so it diffs against the empty tree instead.
  static let workingTreeDiff = capping(
    "base=$(git rev-parse -q --verify HEAD 2>/dev/null || git hash-object -t tree /dev/null); "
      + "\(git) diff \"$base\" --no-ext-diff --no-color")

  /// Branch, untracked files, commits, then the patch last: a patch may hold any byte,
  /// including the section separator, so nothing is parsed after it.
  static func workspace(diff: Bool, commits: Bool, knownHead: String?) -> String {
    let untracked = diff
      ? "\(git) ls-files --others --exclude-standard 2>/dev/null | head -n \(untrackedCap + 1)"
      : "printf ''"
    let log: String
    if commits {
      let known = shellQuote(knownHead ?? "-")
      log = "h=$(git rev-parse -q --verify HEAD 2>/dev/null); "
        + "if [ \"$h\" = \(known) ]; then printf '%s' \(shellQuote(unchanged)); else printf '%s\\n' \"$h\"; "
        + "\(git) log -n 50 --format='%h%x1f%s%x1f%an%x1f%ct%x1e'; fi"
    } else {
      log = "printf ''"
    }
    return "if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then "
      + "git branch --show-current; printf '\\035'; "
      + "\(untracked); printf '\\035'; "
      + "{ \(log); }; printf '\\035'; "
      + "\(diff ? "{ \(workingTreeDiff); }" : "printf ''"); "
      + "else printf '%s' \(notRepository); fi"
  }

  static func untrackedDiff(_ path: String) -> String {
    capping("\(git) diff --no-index --no-ext-diff --no-color -- /dev/null \(shellQuote(path))")
  }

  static func commitDiff(_ id: String) -> String {
    // %x1e ends the message: git's own `---` separator reads as a removed line.
    capping("\(git) show \(shellQuote(id)) --patch --no-ext-diff --no-color --format=%b%x1e")
  }

  static func pullRequestDiff(_ number: Int) -> String {
    capping("gh pr diff \(number) --color=never")
  }

  static let pullRequests: String = {
    // Keep gh's stderr: swallowing it into an empty list made the screen blame
    // a missing CLI for a repository with nothing open.
    let missing = shellQuote(GitRepositoryModel.ghMissingSentinel)
    return "if command -v gh >/dev/null 2>&1; then gh pr list --state all --limit 50 "
      + "--json number,title,headRefName,baseRefName,url,isDraft,changedFiles,reviewDecision,state 2>&1; "
      + "else printf '%s' \(missing); fi"
  }()

  /// Output of `enterCwd(...) + workspace(...)`, already split from its cwd.
  static func parse(cwd: String, _ output: String) -> GitWorkspaceRead {
    if output == notRepository { return .notRepository(cwd: cwd) }
    let parts = output.split(separator: "\u{1D}", maxSplits: 3, omittingEmptySubsequences: false)
    guard parts.count == 4 else { return .unreadable }
    var paths = parts[1].split(separator: "\n").map { DiffFile.unquote($0) }
    let untrackedTruncated = paths.count > untrackedCap
    if untrackedTruncated { paths.removeLast(paths.count - untrackedCap) }
    let commits: GitWorkspaceSections.Commits
    if parts[2] == Substring(unchanged) {
      commits = .unchanged
    } else {
      let head = parts[2].prefix { $0 != "\n" }
      commits = .list(head: String(head), GitRepositoryModel.commits(from: String(parts[2].dropFirst(head.count + 1))))
    }
    let (diff, truncated) = capped(String(parts[3]))
    return .repository(GitWorkspaceSections(
      cwd: cwd,
      branch: GitRepositoryModel.branch(from: String(parts[0])),
      untracked: paths,
      untrackedTruncated: untrackedTruncated,
      commits: commits,
      diff: diff,
      diffTruncated: truncated))
  }

  /// Output past the cap ends mid-line, maybe mid-character: keep only whole lines.
  static func capped(_ output: String) -> (String, Bool) {
    guard output.utf8.count > byteCap else { return (output, false) }
    let bytes = output.utf8.prefix(byteCap)
    guard let lastNewline = bytes.lastIndex(of: UInt8(ascii: "\n")) else { return ("", true) }
    return (String(Substring(output.utf8[..<lastNewline])), true)
  }
}
