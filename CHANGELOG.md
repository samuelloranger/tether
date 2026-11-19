# Changelog

One version ships every platform at once: iPhone, iPad and Mac through [TestFlight](https://testflight.apple.com/join/j7rPkfhq), Windows and Linux as installers on the [latest release](https://github.com/samuelloranger/tether/releases/latest). Each version's notes below are the same text as its GitHub release, without the per-release download instructions.

## [6.7.1](https://github.com/samuelloranger/tether/releases/tag/v6.7.1) — 2026-11-19

### Fixed
- **An agent's question shows all of its text (iPhone, iPad and Mac).** A long question was cut off after four lines, each choice after two and its description after one, with no way to read the rest. The card now wraps to whatever the question and its choices need, and every choice sits with its description.

- **Desktop line art joins at cell edges, whatever the font.** Box-drawing characters, braille, Powerline separators and legacy-computing sextants are drawn against the cell itself instead of shaped from the font, so TUI borders no longer show seams between cells and Powerline prompt segments no longer stripe between rows.

### Under the hood
- Hosts need no update for this release.
- The README now lists Mac among the platforms, carries a CHANGELOG.md that mirrors each release's notes, and links TestFlight as the way in for iPhone, iPad and Mac. The desktop files staying unsigned is written down as a decision in the Security section, with what stands in its place.
- Desktop: the box-drawing stroke widths and the legacy-computing mappings follow Alacritty's builtin font (Apache-2.0); the per-character arm weights match the iOS client, so both apps draw the same junctions.

Pull requests: #365, #366

**Full Changelog**: https://github.com/samuelloranger/tether/compare/v6.7.0...v6.7.1

## [6.7.0](https://github.com/samuelloranger/tether/releases/tag/v6.7.0) — 2026-11-17

### Security
- **The Windows and Linux app's self-updater uses a patched zip library.** The updater unpacks downloaded update packages with the `zip` crate, which had a critical and several high advisories (GHSA-m665-v7pm-7grj, GHSA-hjqx-j4rw-g7xv, GHSA-9hj8-73fh-9963, GHSA-q7v9-x93c-xqv3). It now uses zip 9.6.1 through Velopack 1.3.39. Nothing changes in how updates look or install.
- **A damaged host-key file no longer means trusting any host (Windows and Linux).** If the file of pinned host keys could not be read, the app treated it as empty and pinned whatever key the next host presented. It now refuses to connect and says the file is corrupt and where it is, so a mismatch is still never accepted silently.
- **Session names are checked before they reach the terminal (iPhone and Mac).** A session name with a line break or a leading dash could run extra input or pass a flag when the app typed `zmx attach`, `kill` or `history` for it. Such names are now refused, and sessions with them are left out of the list, matching the desktop app.

### New
- **Pick the app font and the chat font (iPhone and Mac).** Settings → Appearance has **App font** and **Chat font**, with 27 choices including easy-reading faces such as Atkinson Hyperlegible Next, Lexend and OpenDyslexic. Code stays in the system monospaced font.
- **A better image viewer in chat (iPhone and Mac).** Tool results that return images open straight to the picture, with the text behind **Details**. The full-screen viewer swipes through every image in the chat and closes with a drag down; long-press an image to copy, save to Photos or share it.
- **A compact chat header (iPhone and Mac).** The header has its own row so the title keeps its width, Git changes moved into the ⋯ menu, and the session drawer has a Settings button.

### Fixed
- Messages queued while the agent was busy now go to the agent when the app goes to the background, and run after the current turn, instead of waiting until the app is opened again (iPhone).
- A chat that finished loading while idle now saves its resume point right away, so reopening it doesn't replay the whole conversation (iPhone and Mac).

### Known issues
- The bundled fonts ship regular and bold only, so italic text shows upright in them.

Pull requests: #360, #361, #362, #363, #364

**Full Changelog**: https://github.com/samuelloranger/tether/compare/v6.6.1...v6.7.0

## [6.6.1](https://github.com/samuelloranger/tether/releases/tag/v6.6.1) — 2026-11-13

### Changed
- **Compact queued messages (iPhone and Mac).** A message waiting for the agent is now a slim pill: a clock, the text, then **Send now** and **Remove** side by side.

### Fixed
- Messages queued in a chat you aren't looking at are sent once the app comes back from the background, instead of waiting until you open that chat again (iPhone).
- A message sent to Codex just as its turn ends no longer reaches it twice (iPhone, Mac and desktop).
- A Codex subscription that has ended disappears from the chat sidebar instead of showing its last usage under "Couldn't refresh".

### Known issues
- While the app is in the background, queued messages wait until you come back to it (iPhone).

### Under the hood
- Hosts need the updated `tether` (`bash install.sh`) for an ended Codex subscription to disappear. With an older host, it keeps showing its last usage as stale.

Pull requests: #358, #359

**Full Changelog**: https://github.com/samuelloranger/tether/compare/v6.6.0...v6.6.1

## [6.6.0](https://github.com/samuelloranger/tether/releases/tag/v6.6.0) — 2026-11-13

### New
- **Messages reach a busy agent sooner.** A message you send while the agent is working now goes into the running turn as soon as the agent finishes a tool call, like in the Claude Code CLI, instead of waiting for the whole turn to end. A queued message has a **Send now** button that sends it right away. On the iPhone, the Mac and the desktop app.
- **Edit or remove queued messages (iPhone and Mac).** A message sent while the agent is busy waits in a queue. Tap its text to bring it and its images back into the composer, or tap × to remove it. A draft you are already writing is not overwritten.
- **Compact subscription quotas.** The chat sidebar shows one compact row per active subscription instead of large blocks, including accounts you can't use. Tap a row for usage bars, reset times and how fresh the reading is. OpenCode Go (5-hour, weekly and monthly usage) and GitHub Copilot (monthly credits) are listed beside Claude and Codex. On the iPhone, the Mac and the desktop app.
- **Right-click to manage machines and keys (desktop).** Right-clicking a machine on the home screen opens Chat, Edit and Remove, so a machine you no longer use can be removed. Right-clicking a key opens Copy public key and Delete.

### Changed
- **The session picker lists running chats (iPhone and Mac).** Running chats appear beside terminal sessions, with chats waiting for you first. The chat you had open on a host is opened again after a relaunch, if it is still running.

### Fixed
- A subagent started in the background no longer shows as finished between its tool calls; its row keeps spinning until the subagent has actually ended.

### Known issues
- **Queued messages can wait in a chat you aren't looking at (iPhone and Mac).** After the app has been in the background, a chat kept open behind another one reconnects only when you open it again, so messages queued in it are sent then. While the app is in the background, queued messages wait until you come back.

### Under the hood
- Hosts need the updated `tether` (`bash install.sh`) for:
  - the OpenCode Go and Copilot quotas. An older host shows only Claude and Codex.
  - background subagents staying "running". With an older host, their rows behave as before.
  - other devices and later replays showing a message sent into a running turn. An older host still delivers it.
- Linux and Windows packages build with Rust 1.100.

Pull requests: #350, #351, #352, #353, #354, #355, #356, #357

**Full Changelog**: https://github.com/samuelloranger/tether/compare/v6.5.0...v6.6.0

## [6.5.0](https://github.com/samuelloranger/tether/releases/tag/v6.5.0) — 2026-11-07

### New
- **Choose, check and create a new chat's folder.** The New chat form checks the working folder on the host as you type, and Start chat stays disabled until it is a usable directory. A browse button opens a folder chooser with breadcrumbs, a filter and **Use this folder**; a missing folder can be created from the form or from the chooser. On the iPhone, the Mac and the desktop app.
- **Chats stay connected when you switch.** The last four chats you opened keep their connection while you look at another chat or a terminal, so coming back is instant instead of a reconnect and replay. Your unsent draft is kept too. On the desktop, the number of terminal tabs that can be attached at once leaves room for these chats.

### Changed
- **Copying part of a chat table keeps its columns (desktop).** Empty and unselected cells keep their place, so a partial table pasted into a spreadsheet lands in the right columns.
- **Long tool output scrolls more smoothly (iPhone and Mac).** A message's "Copy message" text is now built only when you copy it, not on every update while a tool's output streams in. What gets copied is unchanged.

### Fixed
- OpenCode and Codex subagents now nest under the step that started them instead of spilling their thinking and tool calls into the main chat.
- Sending several messages to an OpenCode chat while it is busy no longer fails: they are queued and sent one at a time, including after you disconnect and come back.
- An OpenCode chat no longer gets stuck after Stop when OpenCode never answers the stopped message: after a short grace period it is marked cancelled and the next queued message is sent.

### Under the hood
- Hosts need the updated `tether` (`bash install.sh`) for the OpenCode message queue and its release after Stop. With an older host, OpenCode chats behave as before (a message sent while one is running is rejected). A chat already running keeps the holder it started with until it is restarted.
- The OpenCode queue also recognises OpenCode started through `npx`/`bunx opencode-ai` or a quoted `sh -c`.

Pull requests: #343, #344, #345, #346, #347, #348, #349

**Full Changelog**: https://github.com/samuelloranger/tether/compare/v6.4.0...v6.5.0

## [6.4.0](https://github.com/samuelloranger/tether/releases/tag/v6.4.0) — 2026-11-05

### New
- **Chat with GitHub Copilot and Antigravity.** New chat now offers GitHub Copilot and Antigravity next to Claude, Codex and opencode, on the iPhone, the Mac and the desktop app. Each chat shows its agent's mark. An agent the host cannot run is dimmed in the picker, with the reason shown.
- **Branch a chat and organize chats into projects.** Branch & edit starts a new chat from an earlier message. Chats are grouped by project, with pin, rename and archive. Your plan's usage limits show in the drawer (iPhone and Mac) and the sidebar (desktop).
- **Background workflows in a chat.** A running Claude Code `Workflow` shows above the composer as a strip (title, phase, agents done), and a sheet lists its phases and agents, what each is doing, and the summary when it ends. A run quiet for ten minutes says so but is not called done.
- **Cards from the agent.** Claude and Codex chats can show native weather, image and Docker cards. Docker actions (Refresh, Show logs, Request restart) send an ordinary prompt to the agent, so its usual permission flow applies.
- **Chat defaults are remembered.** The model, effort and mode you pick are applied to your next new chats, and never over a choice you made in that chat.
- **Background commands, notices and compaction in the chat.** Commands an agent runs in the background, turns it starts itself, notices and context compaction now show in the chat on every client.
- **Select text across a message.** On the iPhone, the Mac and the desktop app you can select and copy part of a finished chat message, across paragraphs, lists and code blocks. Copied prose is one paragraph; code keeps its line breaks and indentation. Streaming replies stay unselectable until they finish.
- **Send any file from a chat (desktop, iPhone, Mac).** The chat's + attaches images and uploads other files, putting their path in the draft. Chats on the iPhone and the Mac also get the Git screen and file upload.
- **Desktop sidebar.** The top bar and tabs are replaced by a closable sidebar listing terminals and chats, with one shared header. It opens and closes with the window shortcuts, remembers its state, and hides on its own in a narrow window. Ctrl+Tab and Ctrl+Shift+1…9 walk chats as well as terminals; Ctrl+Shift+N and Ctrl+Shift+B are new.
- **Git panel on the desktop.** It opens on a chat's folder and shows any new file as an all-added diff.
- **Ahead and behind in Git.** The branch's distance ahead of and behind its upstream shows in the iPhone Git screen and the desktop git panel.
- **Animated desktop interface.** Menus, sheets, dialogs, pages, panels and the sidebar fade or slide in and out, and the hover and focus states are animated. Branch & edit is now an icon in a message's left margin, shown on hover.

### Changed
- **The iPhone drawer is redesigned.** Terminals and chats share one row layout (name, then folder and status), the selected row has a tint and a leading bar, and chats waiting on you sort first. The header shows the host's state and a + menu; ended chats fold into one group. Rows have context menus (Open, Copy, Git, Continue in terminal, Delete or Kill).
- **The git screen's pull request list loads faster.** The list is fetched in two parallel parts (open pull requests, and the latest merged ones without file counts), and on the desktop it no longer holds up the diff. The "N files" chip shows only where the count is known, which is open pull requests.
- **"Writing command…" instead of a bare Terminal row.** A shell command the agent is still writing no longer looks stuck.
- **Chat tables keep their columns.** Wide tables scroll sideways in bounded, wrapping columns instead of being flattened into text.
- **The desktop usage panel is compact,** and the chat actions (pin, rename, archive, delete) open as a popover under the row's "…" button.
- **Catching up no longer moves the composer.** On a reconnect the note shows in the composer's placeholder (desktop) or floats above the bottom bar (iPhone), so the composer stays put.

### Fixed
- A terminal session you did not choose is no longer created: a chat agent's Stop hook, a launch or a redial could attach a missing `default` session, and a failed first session listing on the iPhone no longer creates one. The desktop chat has one attach button instead of three.
- The desktop git panel no longer takes the index lock while git runs in your terminal.
- Git: staged files show in a repository with no commits, diffs read paths under `diff.noprefix`, a diff cut for size says so, and removed `-- comment` or added `++x` lines are kept.
- A GitHub Copilot turn ends when its answer is over, even while a shell it started keeps running. opencode chats start with their install folder on the PATH.
- A background command shows as running, not done; a chat that failed to load is treated as the session's answer.
- Desktop: table alignment is preserved, chat file attach and drawer slide no longer misbehave, and a long connection badge stays on one line in the chat header.

### Under the hood
- Hosts need the updated `tether` (`bash install.sh`) for chat organization and plan usage, background workflow progress, agent cards, and the Copilot and Antigravity checks. With an older host the app still works; those features are missing or empty (workflows are asked about once, then left alone).
- Chat tools need the agent's CLI on the host's `PATH` (Copilot, opencode, Antigravity). Workflow progress reads Claude Code's own session files, so it follows whatever that layout allows.
- Edge builds now run alongside CI on every push to `main` and publish only after that commit's CI passes.
- Dependency updates: russh 0.65, base64 0.23, Biome 2.6.

Pull requests: #302, #303, #304, #305, #306, #307, #308, #309, #310, #311, #312, #313, #314, #315, #316, #317, #318, #319, #320, #321, #322, #326, #327, #328, #329, #330, #334, #335, #336, #338, #340, #341, #342

**Full Changelog**: https://github.com/samuelloranger/tether/compare/v6.3.0...v6.4.0

## [6.3.0](https://github.com/samuelloranger/tether/releases/tag/v6.3.0) — 2026-10-27

### New
- **Continue a chat in a terminal (iPhone, iPad and Mac).** The chat's new ⋯ menu, beside the link state, has Continue in terminal: the chat ends and a new terminal session opens in its folder with the same conversation resumed in Claude Code (a new tab on the Mac). Claude Code's own `/resume` list does not show conversations started from an app such as Tether, so this is the way to pick one up at a terminal. The menu also copies the `claude --resume` command and the folder path.
- **Claude's spinner words.** A running turn shows one of Claude Code's words ("Pondering…", "Brewing…") instead of Working. Tether reads them from the Claude Code installed on the host and applies your `spinnerVerbs` setting (`append` adds your words, `replace` uses only yours).

### Changed
- **Queued messages float above the composer.** A message sent while the agent works now floats as a chip just above the bottom bar, right-aligned like your messages, on the iPhone, the Mac and the desktop app.
- **Stop sends what was waiting, as in Claude Code.** Stop ends the running turn and the queued messages go out right away as the next message, instead of staying in the conversation as if they had run. Pictures attached to queued messages are not sent again; a notice says so.

### Fixed
- Tapping a chat notification on the iPhone opens the chat and keeps it open, instead of returning to the first terminal session a moment later.
- An answer that was still streaming no longer splits into two rows on the iPhone when a message is queued behind it.

### Under the hood
- No new host steps: hosts need `tether` from 6.2 (`bash install.sh`). Continue in terminal needs `claude` on the host's `PATH`. Without Claude Code on the host, the spinner words come from Tether's own short list.

Pull requests: #301

**Full Changelog**: https://github.com/samuelloranger/tether/compare/v6.2.0...v6.3.0

## [6.2.0](https://github.com/samuelloranger/tether/releases/tag/v6.2.0) — 2026-10-26

### New
- **One chat on every device at once.** A chat started on your iPhone can be opened live on your Mac, Windows or Linux computer, and the other way round. Every device sees the messages, answers and Stop sent from the others as they happen, and any of them can write. Before, a chat opened on a device that had not started it was read only and missing the other device's messages.
- **Chat on Windows and Linux.** The desktop app gets the chat with the agent on your host that the iPhone app has. Chats are tabs after your sessions: the `+` in the tab strip opens New session, New chat and Continue a chat, and each machine card on Home has a Chat button. It supports permissions and questions, images, plans, the slash and `@` file palettes, mode controls, and resuming after a restart. Desktop notifications cover a chat that starts waiting on you.

### Changed
- **Queued messages wait above the composer (desktop).** A message you send while the agent is working sits in a strip above the input. It joins the conversation, below the agent's previous answer, once the agent starts it, instead of appearing mid-answer marked "Queued".
- **Tidier chat layout.** Your messages fit their text instead of spanning the column (desktop and iPhone). On the desktop, a collapsed tool row shows at most two lines of a long command and expands to show all of it. The composer is taller, and the model and mode button in the chat header highlights as one piece with its arrow.

### Fixed
- The end of a long chat on the desktop is no longer out of reach under the composer. Wrapped paragraphs, and tools that ran long multi-line commands, made the conversation measure shorter than it was drawn.

### Under the hood
- Hosts need the updated `tether` (`bash install.sh`, protocol 2) to share a chat between devices. Chats started before the update keep their old behaviour until they end: one device at a time, read only on the others. With an older `tether` on the host, everything works as in 6.1.
- A shared chat's holder writes each device's prompts, answers and stops into the chat log as an ACP extension notification (`_tether/client`), so devices that attach later replay them. Each device sends its own request ids and replaces its own stale connection on reconnect, so a dropped phone does not hold back notifications.

Pull requests: #297, #298, #299, #300

**Full Changelog**: https://github.com/samuelloranger/tether/compare/v6.1.1...v6.2.0

## [6.1.1](https://github.com/samuelloranger/tether/releases/tag/v6.1.1) — 2026-10-26

### New
- **Images in chat (iPhone).** Pictures the agent reads or shows now appear in the conversation instead of as raw data. Tap one to open it full screen with pinch-to-zoom and Share; photos you attach show as thumbnails in your own message.

### Fixed
- The transcript no longer goes blank after you send a message in a long chat.
- A chat now opens at its latest message and keeps following while an earlier conversation replays in.
- The Claude Code mod (0.3.0) calls the host tool as `tether`. Installed copies of 0.2.x kept calling the old `tether-notify` name after the rename; restart Claude Code after updating the mod.

### Under the hood
- Image files are stored on the phone, protected until first unlock, excluded from backups and capped at 300 MB (oldest removed first). Saved chat snapshots from earlier versions are discarded once, so each chat replays from the start the first time you open it.
- The README now has screenshots of the app.
- No new host steps beyond 6.1.0: hosts need `tether` (`bash install.sh`).

Pull requests: #293, #294, #295, #296

**Full Changelog**: https://github.com/samuelloranger/tether/compare/v6.1.0...v6.1.1

## [6.1.0](https://github.com/samuelloranger/tether/releases/tag/v6.1.0) — 2026-10-26

### New
- **Chat with Claude Code from your phone (iPhone).** Chats sit beside your terminal sessions in the Sessions drawer. The header shows the model, mode, context use and cost; tap it to change mode, model and effort. The agent keeps working when you lock the phone or lose the connection, and reconnecting picks the conversation back up.
- **Push when the agent needs you.** If the agent asks for approval or asks a multiple-choice question while you are away, a notification arrives with a button per choice, and a quiet one when a turn finishes. Plan approvals always keep a way to say no.
- **Slash commands, files and images.** Type `/` for the agent's commands, `@` to mention a file from the chat's folder, and use the + button to attach photos.
- **Type ahead.** You can send while the agent is working; the message queues, and Stop cancels both.
- **Plans, questions and subagents are shown properly.** A plan appears as a readable card, questions as a card with the choices (or a form), and a subagent as one expandable row with its own tool calls nested under it.
- **Continue an earlier conversation.** New chat → Continue lists the saved Claude conversations for a folder.
- **Chat status in the drawer.** Each chat shows working, needs you, idle or ended, and the drawer button gets a dot when another chat is waiting on you.

### Changed
- **The host tool is now called `tether`.** It was `tether-notify`; it now also runs the chat holder (`tether acp`) and reports a version and protocol number (`tether version`).
- **Home machine cards** show Chat and Open on one row.

### Fixed
- The Claude Code mod no longer makes Claude Code print a "hook was skipped" line on every session start, prompt and tool call when its built-in guard is active.

### Under the hood
- **Update every host with `bash install.sh`.** It installs `tether`. An older program named `tether` on the host (the retired v4 server) is moved aside to `tether.v4`, and your old `tether-notify` files are left in place with a notice that they can be removed. The app and the host tool need to be updated together: with the old name only, the app asks you to install `tether` on that host.
- **Re-wire agent hooks** with `scripts/install-agent-hooks.sh`. Entries that point at the old names are replaced in place; hooks left on the old names keep running the old tool until you do. Registered phones stay in `~/.tether-notify`.
- **Chat needs Node.js on the host** (the pinned agent adapter runs through `npx`) and Claude signed in there (run `claude` once). A chat started before an update keeps the old behaviour until it ends.
- **Chat limits on the host:** an idle chat ends after 12 hours, a chat log is capped at 256 MiB, and ended chats are removed after 14 days (`TETHER_ACP_IDLE`, `TETHER_ACP_LOG_MAX`, `TETHER_ACP_KEEP_ENDED`).
- Build tooling moved to Bun 1.4.4.

Pull requests: #288, #289, #292

**Full Changelog**: https://github.com/samuelloranger/tether/compare/v6.0.2...v6.1.0

## [6.0.2](https://github.com/samuelloranger/tether/releases/tag/v6.0.2) — 2026-10-20

### Changed
- **The desktop terminal finds more system fonts.** On Linux, symbols and color emoji appear on systems with different font layouts; on Windows, fallback fonts cover more scripts and use the intended face in font collections.
- **Emoji and block characters render more clearly on desktop.** Emoji sequences draw together, and block elements align with the cell grid.

### Fixed
- **Permission buttons stay inside the dialog** when the desktop window is short; prompt details and the reply area can scroll.
- **Terminal shortcuts work while the desktop terminal has focus.** Ctrl+click opens links, Shift+click selects locally when an app captures the mouse, and Ctrl+wheel changes font size.
- **The iOS empty terminal no longer exposes the host shell.** With no session open, the empty state covers the shell, hides the keyboard, and stops input.

### Known issues
- **Some joined emoji leave extra space after them** because the terminal still counts the width of their individual parts.

### Under the hood
- **Hosts need no update for this release.**
- **Release CI polling tolerates a brief missing response** after it has found a run.
- **The iOS SSH handshake test retries a stalled runner connection** using a fresh connection.

Pull requests: #280, #281, #282, #283, #284, #285, #286, #287

**Full Changelog**: https://github.com/samuelloranger/tether/compare/v6.0.1...v6.0.2

## [6.0.1](https://github.com/samuelloranger/tether/releases/tag/v6.0.1) — 2026-10-12

### Changed
- **The terminal draws like a real terminal on iPhone, iPad and Mac.** Box-drawing lines and blocks join without gaps, emoji sequences and flags show whole, wide characters sit centred in their two cells, italic text uses the font's italic, and underlines cross spaces with their style and colour. The block cursor shows the character under it in the cell's colours, so it stays readable on light themes.
- **The Git view is more accurate and faster.** Changes are shown against the last commit, staged and unstaged together, and untracked files are listed with a NEW badge. A failed refresh keeps the last list and says it couldn't refresh instead of showing "No uncommitted changes". Long files open folded, and a hunk or file is copied from its context menu.
- **The agent "done" banner floats over the terminal** instead of pushing it down for a few seconds.

### Fixed
- The terminal no longer resizes, and the program in it no longer redraws, when the session drawer or a sheet opens over it with the keyboard up.
- The key bar no longer draws over the session drawer.
- The bottom row no longer runs under the key bar when the keyboard comes up while the drawer is open.
- Switching sessions keeps the session you are leaving on screen until the next one has drawn, instead of flashing an empty terminal with the switch command in it.
- Switching sessions quickly no longer types a switch command into another session, such as an agent's prompt.
- A full-screen program you switch to no longer shows the rows of the previous one.
- A link the terminal wrapped onto the next line opens in full.
- ✔, ✖, ➜ and Claude Code's ⏺ no longer show as empty boxes or oversized emoji in fonts that lack them.
- An image in the terminal stays with its line after a font change or a rotation instead of covering the text that moved under it.
- "No earlier prompt" no longer claims your shell doesn't mark prompts when it does.
- Large outputs such as a long `cat` no longer slow the app down or grow its memory: the terminal does less work per byte and slows the host instead of buffering.
- The Git diff no longer drops removed lines that start with `--` or added lines that start with `++`, and shows binary files, renames, mode changes and deleted files as such.
- On Windows and Linux, a `~/.ssh/config` host with no `IdentityFile` imports with your default key (`~/.ssh/id_ed25519`, `id_ecdsa` or `id_rsa`) when no SSH agent is running, as OpenSSH does, instead of failing with "No SSH agent was found".

### Under the hood
- Hosts need no update for this release.

Pull requests: #270, #272, #273, #274, #275, #276, #278, #279

**Full Changelog**: https://github.com/samuelloranger/tether/compare/v6.0.0...v6.0.1

## [6.0.0](https://github.com/samuelloranger/tether/releases/tag/v6.0.0) — 2026-10-10

### New
- **Tether for Linux.** The desktop app now runs on Linux as an AppImage that updates itself. It is a native Wayland and X11 app that keeps saved passwords and key passphrases in the desktop keyring, signs in through `ssh-agent`, shows desktop notifications, copies and pastes text, files and images, opens links, picks files through the desktop's file chooser, and reconnects after sleep, a screen lock or a network change.
- **One version for every platform.** iPhone, iPad, Mac, Windows and Linux now share one version number and ship in one release. The desktop app moves from 0.1.0 to 6.0.0.
- **Choose how often the desktop app updates.** Settings → About → Update channel. Stable gets releases. Edge gets a build of every change as soon as it passes the tests. Going back to Stable keeps your current build until a newer release is out. **Check now** looks for an update without waiting for the next launch.
- **Tether Light.** A light version of the Tether theme, second in the theme list.

### Changed
- **The terminal theme colours the whole app.** Home, sheets, the session drawer, git, history, Settings, the key bar and the system UI follow your color scheme on iPhone, iPad, Mac and Windows, and so does the Windows title bar. Picking Dracula makes the app look like Dracula. Text, accent and status colours are lifted where a theme would make them hard to read.
- **Color scheme is the only appearance setting.** The System / Dark / Light choice is gone. If you used Light, or System while your device was in light mode, on the Tether theme, you move to Tether Light once.
- **Faint text on the Tether theme is a little brighter on iPhone, iPad and Mac**, so it matches the desktop app.
- **Desktop Settings sections are easier to tell apart**, with readable headings and space between groups.

### Fixed
- On Windows, clicking a tab works again while a session animates its title, such as an agent's spinner.
- On the desktop app, the working and attention dots on a tab sit level with the tab's title instead of riding low.

### Under the hood
- Hosts need no update for this release.
- The Linux AppImage needs glibc 2.39 or later (Ubuntu 24.04, Debian 13, Fedora 40 or later).
- Every change that passes the tests on main now reaches TestFlight and the desktop Edge channel on its own; a release collects them into a version.
- Desktop release builds reuse the build cache from the tests, so a release takes minutes instead of half an hour.
- The desktop client's source moved to `clients/desktop`.

Pull requests: #259, #260, #261, #262, #263, #264, #265, #266, #267, #268, #269, #271

**Full Changelog**: https://github.com/samuelloranger/tether/compare/v5.11.0...v6.0.0
