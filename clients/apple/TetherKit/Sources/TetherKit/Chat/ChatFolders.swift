import Foundation

struct ChatFolder: Equatable, Sendable {
  var status = ""
  var path = ""
  var children: [String] = []

  var ready: Bool { status == "ready" }
  var missing: Bool { status == "missing" }
  var parent: String {
    guard let slash = path.lastIndex(of: "/"), slash != path.startIndex else { return "/" }
    return String(path[..<slash])
  }
  var message: String? {
    switch status {
    case "ready": return nil
    case "missing": return "This folder doesn't exist on the host."
    case "not_directory": return "This path is a file, not a folder."
    case "denied": return "You don't have permission to open this folder."
    case "invalid": return "Enter an absolute path or a path starting with ~/."
    case "create_failed": return "Couldn't create this folder. Check the parent folder and its permissions."
    default: return "Couldn't check the folder on the host. Try again."
    }
  }

  static func parse(_ output: String) -> ChatFolder {
    guard let marker = output.range(of: "__TETHER_FOLDER__\0"), output.hasSuffix("\0") else { return ChatFolder() }
    let parts = output[marker.upperBound...].components(separatedBy: "\0")
    guard parts.count >= 3, parts[0] == "invalid" || parts[1].hasPrefix("/") else { return ChatFolder() }
    return ChatFolder(status: parts[0], path: parts[1], children: parts.dropFirst(2).filter { $0.hasPrefix("/") })
  }
}

enum ChatFolders {
  static func command(_ text: String, create: Bool = false) -> String {
    "sh -c \(shellQuote(script)) tether-folder \(shellQuote(text.trimmingCharacters(in: .whitespacesAndNewlines))) \(create ? "create" : "check")"
  }

  static let script = #"""
path=$1
case "$path" in ''|'~') path=$HOME;; '~/'*) path=$HOME/${path#\~/};; esac
while [ "$path" != / ] && [ "${path%/}" != "$path" ]; do path=${path%/}; done
status=invalid
case "$path" in /*) status=missing;; esac
if [ "$status" != invalid ]; then
  if [ "$2" = create ]; then
    if ! mkdir -p -- "$path" 2>/dev/null; then status=create_failed; fi
  fi
  if [ "$status" != create_failed ]; then
    if [ -d "$path" ]; then
      if [ -r "$path" ] && [ -x "$path" ]; then status=ready; else status=denied; fi
    elif [ -e "$path" ] || [ -L "$path" ]; then status=not_directory
    fi
  fi
fi
printf '__TETHER_FOLDER__\000%s\000%s\000' "$status" "$path"
[ "$status" = invalid ] && exit 0
base=$path
prefix=
if [ "$status" != ready ]; then base=${path%/*}; prefix=${path##*/}; fi
[ -n "$base" ] || base=/
[ -r "$base" ] && [ -x "$base" ] && [ -d "$base" ] || exit 0
count=0
for entry in "${base%/}"/* "${base%/}"/.[!.]* "${base%/}"/..?*; do
  [ -d "$entry" ] || continue
  name=${entry##*/}
  case "$name" in "$prefix"*) ;; *) continue;; esac
  printf '%s\000' "$entry"
  count=$((count + 1))
  [ "$count" -lt 200 ] || break
done
exit 0
"""#
}
