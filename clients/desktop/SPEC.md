# Tether for Windows

Date: 2026-10-05

A native Windows client for the same hosts the iOS app already talks to. Rust, Slint, one window. It is a port of Home, terminal appearance, and file send. The visual source of truth stays `DESIGN.md`: for the default Tether theme that is night chrome, periwinkle accent, terminal well `#1E1E2E`; every colour follows the chosen terminal theme.

The screen map is `design-preview/index.html`, next to this file. Open it in a browser.

Target: Windows 10 22H2 and Windows 11, x64. ARM64 is a later build target, not a later design.

## What this is

Someone at a Windows PC opens a machine they already SSH to. The host runs `zmx`. The session stays alive after the window closes, because `zmx` owns it. Tether on Windows is a client, the same way Tether on iOS is a client. It has no server of its own and adds nothing to the host.

v1 is the loop they can do without the phone:

1. Keep machines and keys on this PC.
2. Open a machine and land in its `zmx` sessions, one tab per session: switch, create, and kill them.
3. Change the terminal's colors, font, and cursor.
4. Drop a file, or paste a screenshot, and have it uploaded and its remote path pasted into the session, so Claude Code attaches the image.
5. Hear from a session that needs them: a Windows toast and a taskbar flash or progress bar, while the window is in the background.

## Out of scope

Push, notification actions on toasts, the phone key bar as a bar (snippets replace it, see Snippets), and the app-icon picker. Tabs replace the iOS session drawer; there is no drawer. Keyboard-interactive auth is a later slice.

Apple faces (Menlo, SF Mono, Courier) are not offered. Cascadia takes their place.

## Window

One window. On Windows 11 the platform title bar is painted with `DWMWA_CAPTION_COLOR` to the chosen theme's chrome background so it meets the client area, caption "Tether". `DWMWA_USE_IMMERSIVE_DARK_MODE` is set for dark themes. Windows 10 ignores caption color: there the bar only gets the dark mode flag. Slint draws everything under that bar.

Window size and position persist. Minimum client size is 640 × 420.

Opening a machine replaces Home with the terminal. Back returns to Home and drops the SSH connection and every tab's channel; the remote `zmx` sessions keep running. Closing the window does the same. Settings is the same page from a gear on Home and from a gear in the terminal header. iOS only puts the gear on the terminal. On Windows, Home is where you are before any machine exists, and appearance applies there too.

Destructive confirms (remove a machine, delete a key, kill a session) are dialogs. Every other form is a page in the window, with Back. Esc is Back on every page except the terminal, where Esc belongs to the PTY.

Tether (night) is the default theme. The terminal colour scheme colours the whole window, and a light theme gives light chrome. Tether Light is Aurora light.

## Home

Header: "Home", and under it a mono line.

- Machines, with at least one: `2 machines`
- Machines, empty: `no machines yet`
- Keys: `2 keys · on this PC`

A plus on the right adds a machine, on either tab. A gear opens Settings.

Tabs: Machines, Keys. The selected tab is a raised segment.

### Machines

A card per machine, in insertion order:

- A periwinkle lamp, the name, and a `saved` capsule.
- `user@host:port · <key name, "agent", or "password">` in mono.
- `Open` in the accent, with a chevron.

Click or Enter opens the machine. Right-click, or the keyboard menu key, offers **Edit** and **Remove**. Remove confirms:

> Remove devbox?
>
> Its sessions keep running on the host — only this PC forgets it.

Action: **Remove machine**. Cancel leaves it. Removing a machine deletes its stored password. The host-key pin stays, so adding the same host back is still protected.

A machine whose key was deleted shows `key missing` in place of the key name. Open lands on Couldn't connect with "This machine's key was deleted. Edit the machine and choose another key."

Empty:

> No machines tethered yet
>
> Add a server to open a shell that stays alive between visits.

Primary action: **Add a server**.

### Import from SSH config

**Import** on Home (and **Import from SSH config** under the empty state) reads `%USERPROFILE%\.ssh\config` with the OpenSSH rules Tether needs: `Host` blocks with `*`, `?` and `!` patterns, first value wins, `Include` (relative to `.ssh`, with globs), and keywords in any case. `Match` blocks are skipped. Every alias written out in a `Host` line becomes a row; wildcard-only blocks only supply defaults.

Each row shows the alias, `user@host:port`, how it authenticates, and `via <jump>`:

- `HostName`, `Port`, and `User` fill the machine; with no `User`, the Windows user name.
- `IdentityFile` brings that key into the vault (named after the file). A key already in the vault is reused, a key shared by several hosts comes in once, and a key with a passphrase, or a missing file, leaves the machine on the SSH agent; the row says why.
- `ProxyJump` sets **Connect through**: an alias points at that alias's row, and `[user@]host[:port]` gets a row of its own. With a hop list, the last hop is the machine connected through; a hop that is not an alias passes through the hops before it.
- A host whose user, host and port are already saved reads "already on Home" and can't be checked; a jump through it points at the saved machine.

New hosts start checked. Unchecking a host that another checked host goes through keeps it checked. **Import N machines** saves the keys first, then the machines, and returns to Home; if saving the machines fails, the keys come back out.

### Add a server, Edit server

One form, two titles. Add starts empty; Edit starts from the machine and its button reads **Save changes**.

Fields, in order: Name, Host, Port (default `22`), User, then Authentication.

Authentication is a segment: **Private key**, **SSH agent**, or **Password**. Private key is a picker of vault keys. With an empty vault the picker reads: "No keys in the vault — generate or paste one first." SSH agent has no field; its line reads "Uses the keys in the Windows OpenSSH agent (1Password's too when it serves that agent), or in Pageant when that agent isn't running." Password is a concealed field.

**Connect through** (shown once there is another machine) is a picker: **Direct**, then every other machine by name. Choosing one makes this machine a ProxyJump target: Tether connects to the chosen machine first and opens the session through it. The chosen machine may itself connect through another, up to 4 hops.

On Edit, the password field starts empty and reads "Leave empty to keep the saved password". Switching away from Password deletes the stored password on save. Changing host or port means a different host-key pin: the old pin stays under the old `host:port`, and the new one is pinned on first connect. Edits apply the next time the machine is opened; an open machine keeps its connection.

Under the fields, the trust note:

> First connect pins this host's key. A later change is refused.

**Save server** stays quiet until the form is ready. The hint under it is the first missing piece, in field order:

| Missing | Hint |
|---|---|
| Name | Name this machine to save it |
| Host | Add a host to save it |
| User | Add a user to save it |
| Password, when that segment is on (Add, or Edit of a machine without a saved password) | Enter a password to save it |
| A key, when that segment is on and none is chosen | Choose a key to save it |

Whitespace is empty. Host and User are trimmed before they are saved. A port that is not an integer from 1 to 65535 saves as 22.

### Keys

A card per key:

- Randomart thumbnail, drawn from the public key the way the iOS card draws it.
- Name, and an origin capsule: `generated`, `imported`, or `pasted`.
- `<algorithm> · created Oct 5`. The algorithm is the first token of the public line (`ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-nistp256`), not a constant. iOS records every key as `ssh-ed25519`; Windows does not copy that.
- A shortened `SHA256:` fingerprint.
- `used by devbox`, or `not used yet`.
- **Copy public key**.

The bottom bar is three actions: **Generate** (accent), **Import**, **Paste**.

Right-click a card, or press Delete on a focused card, to confirm:

> Delete key id_ed25519?
>
> The private key is erased from this PC and cannot be recovered.

When machines use the key, a second line names them: "devbox won't be able to sign in until it gets another key."

**Delete key** removes the record and the secret. It does not edit `authorized_keys` on any host. Cancel leaves it.

Empty keys, in place of the list: "No keys yet. Generate one, or paste an existing key." The three actions stay.

### Generate, import, paste

**Generate.** A name. The line under it: "A new ed25519 key is created on this PC. Only its public half is shown — paste that into the host's authorized_keys." **Generate key** needs a name. Hint when it is missing: "Name this key to save it."

**Import.** A name, **Load private key file…**, a private key field, and an OpenSSH public key field. Loading a file fills the private key and, when the name is still empty, the file's base name. When a `<file>.pub` sits beside it, that fills the public key too.

**Paste.** The same fields, without the file button.

Save hints, in order: "Name this key to save it", then "Paste the private key to save it" (the text must contain `PRIVATE KEY`), then "Paste the public key to save it" (the trimmed text must start with `ssh-` or `ecdsa-`), then "This key needs a passphrase — Tether can't use it yet" (an encrypted private key: OpenSSH with a cipher other than `none`, or `ENCRYPTED PRIVATE KEY`), then "The public key doesn't match the private key" (the public half derived from the private key differs from the pasted line).

Accepted private formats: OpenSSH (`BEGIN OPENSSH PRIVATE KEY`), PKCS#8, and PKCS#1 RSA. Passphrase keys are a later slice.

Generate stores an Ed25519 key. The record keeps the OpenSSH public line, the algorithm, the `SHA256:` fingerprint, and the origin. The PKCS#8 PEM goes to the secret store under that record's id. The public list is JSON and holds no secret.

## Settings

One page.

**Appearance.** Colour scheme is the only appearance choice. It colours the whole window, not just the terminal, and changes live. Tether Light is the old Light scene; a saved Light, or System while Windows was light, migrates to it once, and only when the scheme is Tether (any other scheme is kept).

**Terminal.**

| Control | Range | Default on Windows |
|---|---|---|
| Font | the faces below | Cascadia Mono |
| Size | 8–24 pt, step 1 | 14 |
| Line spacing | 1.00×–1.60×, step 0.05 | 1.00× |
| Padding | 0–24 pt, step 2 | 8 |
| Cursor | Block, Bar, Underline | Block |
| Blink cursor | on or off | off |

The phone default size is 11. Fourteen is the Windows default because the window sits on a monitor. Saved values still clamp to the same ranges. Points are converted at the monitor's scale factor, so 14 pt reads the same on a 100% and a 200% display. Ctrl+= and Ctrl+- (and Ctrl+wheel) change the size from the terminal and save it; Ctrl+0 resets to 14, as in Windows Terminal.

A live preview sits beside the form when the window is at least 800 px wide, and under the blink toggle when it is narrower. The preview is a few lines in the chosen face, colors, spacing, padding, and cursor. It is not a live PTY.

Color scheme and Font are their own pages, opened from those rows.

### Color scheme

A search field filters by name. Each row is a swatch and a name. The swatch is `~ git main` in that theme's blue, foreground, and green, plus six ANSI dots, on that theme's background. A secondary line says Light or Dark from the background luminance, same rule as iOS (relative luminance above 0.5 is Light). The active row has a check. Choosing a row applies it immediately.

The catalog is the iOS `TerminalThemes.json`, embedded in the binary from its iOS path at build time, with Tether's own themes first (Tether, then Tether Light), then the shared JSON. One file, so the two clients never drift. Its `TerminalThemes-LICENSE.txt` ships with the app. An unknown stored id falls back to Tether.

### Font

Rows: Cascadia Mono, Cascadia Code, JetBrains Mono, Monaspace Neon, Monaspace Radon, Maple Mono, Comic Mono. The name is drawn in that face. The active row has a check. Choosing a row applies it immediately. An unknown stored id falls back to Cascadia Mono.

Every face is bundled in the binary, regular and bold, with the iOS font files and `LICENSES.md`. Cascadia is bundled too: it ships with Windows Terminal, not with every Windows install. Stored ids use the iOS form: `cascadia-mono`, `cascadia-code`, `jetbrains-mono`, `monaspace-neon`, `monaspace-radon`, `maple-mono`, `comic-mono`.

Below the bundled rows, a **Google Fonts** section downloads more families (see Google Fonts).

Glyphs the chosen face lacks fall back to the bundled Symbols Nerd Font Mono (prompt and powerline glyphs), then to Segoe UI Emoji and the system fallback chain. Cascadia Code's ligatures are drawn; the others are drawn without ligatures, as on iOS.

## Terminal

The header is a surface bar:

- **Back**, to Home.
- A lamp and a status word. The word is always present; the lamp is not the only signal.
- The machine name, and under it the active session name, a midpoint, and the status word in the lamp color.
- **Snippets** and **History** (see those sections).
- **Send file…**
- **Settings** (the gear).

Under the header, a tab strip: one tab per `zmx` session on the host (see Sessions).

The lamp follows the iOS connection lamp, not the agent heat ramp. Agent state is out of scope, and `waiting` red must not mean two things.

| Status | Word | Lamp |
|---|---|---|
| TCP and auth in progress | connecting | warning `#F2B34C` |
| Session up | connected | success `#6EE7A8` |
| The socket died, redialing | reconnecting | warning `#F2B34C` |
| Gave up | disconnected | danger `#FF7050` |

Colours come from the chosen theme's chrome palette; the table shows the Tether theme.

The grid fills the rest of the window. Its background is the active theme's background, which for Tether is `#1E1E2E`. Padding around the grid is the padding setting. The grid is bottom-anchored. A full repaint of the cell buffer, not a row diff, coalesced to at most one frame per display refresh. The grid itself does not animate, and padding does not animate: a resizing grid would report sizes the PTY then has to honor. A window drag-resize redraws the grid locally at once and sends the PTY resize only once the size settles (about 150 ms quiet), the same split iOS uses to avoid a SIGWINCH storm.

### Input

- Keys, paste, and resize go to the PTY. Keys follow the table under Keyboard below: xterm sequences, with the iOS `TerminalKeyMap` rules for Ctrl and Alt.
- Paste is Ctrl+V, Ctrl+Shift+V, and Shift+Insert, as in Windows Terminal. Copy is Ctrl+Shift+C, and Ctrl+C copies too while a selection exists (the selection then clears); with no selection Ctrl+C sends `0x03`. Right-click pastes when nothing is selected and copies when something is. An image or files on the clipboard paste as an upload (see Files and images).
- Ctrl+V never reaches the PTY as `0x16`. Ctrl+Q stays `0x11`, which vim already takes for block select and readline for quoted-insert, so nothing needs remapping.
- Paste goes through bracketed paste when the program asked for it (`?2004h`). Newlines are sent as CR.
- Mouse: drag selects; double-click selects a word, triple-click a line. When the program enables mouse reporting (`?1000/1002/1003/1006h`, e.g. Claude Code fullscreen), clicks, drags, and the wheel go to the program, and Shift held down selects locally instead.
- Wheel without mouse reporting scrolls the local scrollback of this attach (alacritty's own buffer, 10 000 lines). On the alternate screen it sends arrow keys. `zmx history` stays out of scope.
- IME composition (CJK, dead keys, emoji panel) commits text to the PTY as UTF-8.
- OSC 52 copies to the Windows clipboard, only while the window has focus. Programs cannot read the clipboard.
- The bell flashes the header lamp once in the active tab, marks a background tab, and flashes the taskbar button when the window is not focused. A burst rings once: at most once per 200 ms per session, the iOS `BellThrottle` window. No sound.
- The window title is `<machine> · <session>`, followed by the active tab's OSC 0/2 title when it set one.

### Inline images

`alacritty_terminal` has no image support, so `tether-core::graphics::Splitter` lifts the sequences out of the PTY stream before the grid sees them, and `tether-term` places them. Everything else reaches the grid unchanged and in order. A byte that might start an image sequence (a trailing `ESC`, `ESC _`, a prefix of `ESC ] 1337 ; File =`) is held until the next read decides it, so a split read never half-feeds the grid.

Supported:

- **Kitty graphics** (`ESC _ G … ESC \`), direct transmission only (`t=d`): `a=t` transmit, `a=T` transmit and display, `a=p` display by `i` or `I`, `a=d` delete, `a=q` query. Formats `f=24`, `f=32` (with `s`/`v`) and `f=100` (PNG), optional `o=z`, chunked `m=1`. Placement keys `c`, `r`, `x`/`y`/`w`/`h` (source rectangle), `X`/`Y` (pixel offset), `C=1` (do not move the cursor), `p` (a repeated placement id replaces the old one), `z` (kept for deletes only), `q`. Deletes: `d=a`/`A` (placements on the live screen), `i`/`I`, `n`/`N`, `c`/`C`, `p`/`P`, `x`/`X`, `y`/`Y`, `z`/`Z`; an uppercase letter also frees the picture data.
- **iTerm2** `OSC 1337 ; File=…:base64` with `inline=1` (PNG or JPEG), `width`/`height` as cells, `Npx`, `N%` or `auto`, and `preserveAspectRatio`. `inline=0` (a download) is swallowed and not shown.

Answers are honest: `a=q` replies `OK` only when the same command would be accepted. A transmission by file, temp file or shared memory replies `ENOTSUP`, as do animation (`a=f`/`a=a`/`a=c`), Unicode placeholders (`U=1`) and unknown formats. Bad data replies `EINVAL`, a pixel size over the cap `EFBIG`, and a missing image `ENOENT`. Nothing is sent when the command carries no `i`/`I`; `q=1`/`q=2` silence OK/everything.

Placement. The image goes at the cursor. Its box is the picture's natural size in whole cells, scaled down (never clipped) to the room left on the line and `MAX_IMAGE_ROWS` (64) rows. The cursor then moves down `rows - 1` lines (scrolling like a line feed) and to the column after the image, the same as kitty. A pending synchronized update (`?2026`) is flushed first, because the cursor has to be real.

Anchoring. A placement is a set of private-use zero-width characters, one per image row, written into the first column of the image in the grid itself. They scroll into history with their lines, are dropped with them at the 10 000-line limit, reflow on resize, are erased by clear screen and live on the alternate screen only while it does. The anchors are stripped from snapshots and selected text. Text written over a row's cell erases that row's anchor; the image stays while any of its rows keeps one. A tag index is reused only after the grid is scrubbed of the old one.

Drawing. The rasterizer composites each visible image after the text with a box filter, clipped to the viewport (a half-scrolled image is cut, not wrapped), with the scaled copy cached per size. Z-index below zero is not honored: images always draw over text.

Limits. 128 MiB of decoded pixels and 128 pictures per tab, oldest evicted first, and a picture whose placements have all left the grid is freed before any eviction. One picture is at most 16 Mpixel and 8192 px a side; one transmission at most 48 MiB of base64. Over the cap, the sequence is swallowed to its terminator and replied to with an error.

Known gaps: the inactive screen's anchors cannot be scrubbed while the alternate screen is up; text over every anchored row drops the image even where a program meant it to stay; images are not part of search or copy.

### Keyboard

The iOS map only covers what a phone keyboard can press. Windows needs the whole xterm set. `mod` below is the xterm modifier parameter: 1 + Shift 1 + Alt 2 + Ctrl 4.

| Key | Sends | With modifiers |
|---|---|---|
| Up, Down, Right, Left | `CSI A`…`D`; `SS3 A`…`D` in application cursor mode (`?1h`) | `CSI 1;mod A`…`D` (Ctrl+Left is word-left in readline) |
| Home, End | `CSI H`, `CSI F`; `SS3 H`, `SS3 F` in application cursor mode | `CSI 1;mod H`, `CSI 1;mod F` |
| Insert, Delete | `CSI 2~`, `CSI 3~` | `CSI 2;mod~`, `CSI 3;mod~` |
| PageUp, PageDown | `CSI 5~`, `CSI 6~` | `CSI 5;mod~`, `CSI 6;mod~`. Shift+PageUp/PageDown scroll local scrollback instead, outside the alternate screen and mouse reporting |
| F1–F4 | `SS3 P`…`S` | `CSI 1;mod P`…`S` |
| F5–F12 | `CSI 15~ 17~ 18~ 19~ 20~ 21~ 23~ 24~` | `CSI <n>;mod~` |
| Tab | `0x09` | Shift+Tab `CSI Z` |
| Enter | `0x0D` | Alt+Enter and Shift+Enter `ESC CR`, which Claude Code and readline-style prompts take as a newline without submitting |
| Backspace | `0x7F` | Ctrl `0x08`, Alt `ESC 0x7F` (delete word back) |
| Esc | `0x1B` | |
| Space | `0x20` | Ctrl `0x00`, Alt `ESC SP` |
| Numpad | digits and operators; `SS3 p`…`y`, `SS3 M` for Enter in application keypad mode (`DECKPAM`) | |

Ctrl and Alt on everything else follow iOS `TerminalKeyMap`: Ctrl folds `@`–`_` and letters onto `0x00`–`0x1F` (so Ctrl+[ is Esc, Ctrl+\\ is `0x1C`, Ctrl+] `0x1D`, Ctrl+^ `0x1E`, Ctrl+_ and Ctrl+/ `0x1F`), Alt prefixes `ESC` (Meta), and Ctrl+Alt does both. Folding uses the character the layout produces without modifiers, not the physical key, so it works on any layout.

**AltGr.** On Windows, AltGr arrives as Ctrl+Alt. When the layout turns Ctrl+Alt+key into a printable character (Canadian French AltGr+2 is `@`, AltGr+7 is `|`, AltGr+[ is `[`), that character is sent as text and no Ctrl/Alt rule applies. Only a Ctrl+Alt combination that produces no character is treated as Ctrl+Alt.

**Alt alone.** Pressing and releasing Alt must not open the window's system menu, and F10 must not activate the menu bar. The app swallows `SC_KEYMENU`, so a tapped Alt or F10 reaches the PTY (F10 as `CSI 21~`) and focus stays on the grid.

**Kept by Windows:** Alt+Tab, Alt+F4 (closes the window, same as the close button), the Windows key and its combos, Ctrl+Alt+Del, Print Screen.

**Kept by Tether:** Ctrl+V, Ctrl+Shift+V, Shift+Insert (paste); Ctrl+Shift+C, and Ctrl+C with a selection (copy); Ctrl+=, Ctrl+-, Ctrl+0 (font size); Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+Shift+1…9, Ctrl+Shift+T (tabs); Ctrl+Shift+F (find); Ctrl+click (open link). Everything else goes to the PTY, including Ctrl+W, Ctrl+T, Ctrl+PageUp/PageDown, Ctrl+Alt+digits (AltGr symbols), and Esc.
**Kept by Tether:** Ctrl+V, Ctrl+Shift+V, Shift+Insert (paste); Ctrl+Shift+C, and Ctrl+C with a selection (copy); Ctrl+=, Ctrl+-, Ctrl+0 (font size); Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+Shift+1…9, Ctrl+Shift+T (tabs); Ctrl+Shift+P (snippets); Ctrl+Shift+H (history); Ctrl+click (open link). Ctrl+P and Ctrl+H still reach the PTY; only the Shift forms are taken. Everything else goes to the PTY, including Ctrl+W, Ctrl+T, Ctrl+PageUp/PageDown, Ctrl+Alt+digits (AltGr symbols), and Esc.

Key repeat sends repeats. Dead keys and IME go through text composition, never through this table. The kitty keyboard protocol and `modifyOtherKeys` are not advertised in v1.

### Sessions

Tether is the client for `zmx`, so its sessions are the window's tabs. iOS shows them in a drawer and moves one PTY between them; a desktop has the room to keep them all in view.

**The strip.** One tab per session in `zmx ls`, ordered by `created`, oldest left. A tab shows the session name and, when its directory is known, the last path component of its cwd in mono. A `+` at the end adds a session. The strip scrolls sideways when it overflows; it never wraps.

The list is refreshed on the control connection when the machine opens, after every create or kill, every 10 s while the window is focused, and on focus. A session that appears on the host (created from the phone or a shell) gets a tab at its place. A session that disappears loses its tab, and its channel closes; when it was the active tab, the neighbor to the left becomes active, else the right one, else the empty state.

**One channel per open tab.** The terminal connection carries one PTY channel per tab that has been opened, each a login shell into which Tether types `~/.local/bin/zmx attach '<name>'`, the same attach iOS does. A tab is opened the first time it is selected, and stays attached until the machine is closed, so background tabs keep streaming: switching to one is instant and shows its live grid, not a replay, and its bell, notifications, and progress keep arriving. Each tab has its own `alacritty_terminal` grid, scrollback, and selection. At most 10 tabs are attached at once, the default `MaxSessions` of OpenSSH's sshd, so the host never refuses a channel; opening an 11th detaches the least recently viewed one, which re-attaches when selected again.

Typing the detach key and a second attach into one PTY, as iOS does, is not used: it needs a 250 ms settle between writes and lands in an agent's prompt when the timing slips. Separate channels have neither problem, and `russh` multiplexes them without the stall that made iOS avoid a second channel under libssh2.

All attached channels are resized together when the window size settles.

**Choosing the first tab.** On open, the iOS rule picks the active tab: `default` if it exists, else the newest by `created`. With no sessions, the strip is just `+` and the well shows the iOS empty state: "No session on devbox", "Nothing runs until you start one.", and **New session**. Keystrokes do not reach a bare shell.

**New session.** `+`, Ctrl+Shift+T, or New session adds a tab with an inline name field, prefilled with the iOS rule: `default` on an empty host, else the first free `session-N`, counting from the number of sessions plus one. Enter attaches it, which makes `zmx` create it. Esc cancels. A name already in use selects that tab instead.

**Switching.** Click a tab, Ctrl+Tab and Ctrl+Shift+Tab (next, previous, wrapping), Ctrl+Shift+1…8 (that position), Ctrl+Shift+9 (the last tab). Middle-click does nothing: closing a tab would only detach, and the tab would come back on the next refresh.

**Kill.** Right-click a tab: **Kill session**. Confirm:

> Kill session build?
>
> Everything running in it stops. This can't be undone.

Action: **Kill session**. The client switches away first when it is the active tab, then runs `~/.local/bin/zmx kill '<name>' --force` on the control connection, as iOS does. Killing the last session leaves the empty state; nothing is recreated.

**Attention.** A background tab that rang the bell or sent a notification shows a dot in the warning color until it is viewed. Plain output does not mark a tab: a clock or a spinner would mark it forever.

**Leaving the PC.** An attached client tells the Claude Code mod someone is watching, so it does not hold a prompt for the phone. When Windows locks the workstation, every channel detaches after a 15 s grace (iOS `backgroundGrace`), and re-attaches on unlock. Minimizing does not detach.

### Search

**Find** in the header, or Ctrl+Shift+F, opens a find bar at the top right of the grid and focuses it. Ctrl+F still goes to the shell.

- The query is literal text, not a pattern. It ignores case unless it has an uppercase letter.
- It searches the active tab's scrollback and screen, including text wrapped across rows.
- Every visible match is tinted with the theme's yellow; the current match is filled with it.
- Enter steps to the next older match, Shift+Enter to the next newer one, and the arrows do the same. Stepping wraps around, and scrolls the grid to show the match.
- The bar reads `2 of 14`, `14 matches`, or `No matches`. The count refreshes at most once a second while output arrives.
- While the field has focus, keys go to it, not the PTY. Clicking the grid gives the keyboard back to the session, with the bar left open.
- Switching tabs applies the query to the new tab. Esc in the field, or the close button, closes the bar and clears the highlights.

### Links

Same rules as iOS `LinkSpans`: an OSC 8 hyperlink wins over text that only looks like one, and plain `http://` and `https://` URLs are detected in the grid, including a URL wrapped across rows and one cut by Claude Code's box characters (`│ ┃ ⎿`).

Holding Ctrl underlines the link under the pointer and shows a hand. Ctrl+click opens it in the default browser with `ShellExecuteW`. This works under mouse reporting too: Ctrl+click is never sent to the program. Hovering an OSC 8 link with Ctrl held shows its target in a tooltip, since the visible text can differ from where it goes. Only `http`, `https`, and `mailto` targets open; anything else is ignored. Right-click on a link adds **Copy link**.

### Replies to the program

Programs ask the terminal questions, and a wrong or missing answer changes what they draw. Every reply `alacritty_terminal` produces (`PtyWrite`, `ColorRequest`, `TextAreaSizeRequest`) is written back to that tab's channel:

- OSC 10, 11, 12 queries get the theme's foreground, background, and cursor color as `rgb:rrrr/gggg/bbbb`. Claude Code reads the background this way to choose its light or dark palette, so a theme change answers with the new color.
- OSC 4 queries get the palette entry. OSC 4 sets and OSC 104 resets override the palette for that tab, like iOS `PaletteOverrides`; OSC 110/111/112 reset the dynamic colors. A theme change keeps the overrides.
- Device attributes (DA1, DA2), cursor position (DSR 6), and window-size reports (CSI 14t / 18t) are answered. Title push/pop is supported; title reporting (CSI 21t) is not, so a program cannot echo a title back as input.

### Notifications and progress

Push stays out of scope; what reaches the window directly does not.

**Notifications.** OSC 9 (`ESC ] 9 ; <text> BEL`, but not `9;4`) and OSC 777 (`ESC ] 777 ; notify ; <title> ; <body> BEL`) become a Windows toast when the window is not focused or the session is not the active tab. The toast reads `<machine> · <session>` over the text. Clicking it brings the window forward and selects that tab. At most one toast per session per 5 s; later ones in the window replace the pending one. With the window focused on that very tab, nothing shows: the user is looking at it. Focus Assist and the Windows notification settings apply as they do to any app.

Toasts need an app identity, `Tether.Terminal`. The installer's Start menu shortcut carries it. The portable zip registers its own `Tether (portable)` shortcut with it on first run, never the installer's; without one, toasts are skipped and only the taskbar flash remains.

**Progress.** OSC 9;4 sets progress the way iOS reads it (`OSCReports`): state 1 with a percent is normal, 2 is error, 3 is indeterminate, 4 is paused, 0 clears, and a prompt mark (OSC 133;A) clears it too. The active tab's progress draws as a thin bar under the header in the accent (error in danger, paused in warning), and drives the taskbar button through `ITaskbarList3::SetProgressState` / `SetProgressValue`. A background tab's progress shows only on its tab, as a bar under the tab label.

### Agents

The host's `tether-notify` knows each zmx session's agent: `working`, `waiting` or `done`, since when, a message, and whether the Claude Code mod is holding a prompt. Windows reads it the way iOS does and shows it; it adds nothing to the host.

**Reading.** On the control connection, every 10 s while connected (focused or not, unlike the `zmx ls` refresh: a toast for a background window needs the read), one exec: `if [ -x ~/.local/bin/tether-notify ]; then ~/.local/bin/tether-notify status 2>/dev/null; else echo __tether_notify_missing; fi`. The output is a JSON array; a banner ahead of it is ignored, a row that does not parse is skipped, and the rest still count. The first read after every connect is a baseline: nothing toasts for state that was already there.

**Degrading.** Nothing here can break the terminal. A failed exec keeps the last read for 30 s, then shows no badges. A missing binary, or output that is not a status array (an older `tether-notify` without `status`), shows no badges and stops polling until the next connect. No error is shown for either.

**Badges.** Every tab with an agent carries a small pill after its name, in words with colour only reinforcing them: `working` (accent), `needs you` (warning), `done 5m` (faint; the age is `now`, `Nm`, `Nh`, `Nd`, as on iOS). It is not the attention dot, which still means an OSC notification or bell arrived in a background tab. The active session's state and message also read in the header after the connection word: `· needs you · <message>`.

**Held prompts.** When the mod holds a question or a permission request, nobody is attached to that session, so the terminal shows nothing to answer. The active tab's held prompt opens a sheet over the terminal, as the iOS answer sheet does:

- A **question** loads with `tether-notify pending --session <name>` and lists every question with its options (radio for one choice, check for "Pick any") and an "Other" field. A typed answer replaces the pick on a single-choice question and is appended on a multi-select one. Send is enabled once every question has an answer; the answers go out as `tether-notify answer --session <name> --state <state> --version <version> --answers <base64 JSON by question text>`, multi-select labels joined with `, ` in option order. The host refuses the answer if the agent has moved on since the version the sheet names.
- A **permission** shows the agent's message with **Approve** (Return), **Deny** (Esc) and a one-line reply (typed, then submitted), through `answer --input <base64>` and `--submit`. A reply is one line, at most 2000 characters.
- Every argument is shell-quoted; typed text only ever travels as base64.

Not now closes the sheet and leaves a bar under the tab strip ("The agent is asking a question" with Answer). Opening a tab again surfaces its held prompt even if it was closed. A prompt answered from another client, or replaced by a newer one, updates or closes the sheet on the next read. A refused answer (exit 3, "the agent has moved on") keeps the sheet open and says so. Keys do not reach the terminal while the sheet is up.

A held prompt on a tab that is not active shows only its `needs you` pill and the toast; it opens when that tab does.

**Toast.** A session entering `waiting` (or getting a new prompt while waiting) raises the usual toast: `<machine> · <session>` over `<Agent>` and the agent's message, under the same rule as OSC notifications (not shown for the focused, active tab), the same 5 s per-session throttle, and the same click: window forward, that tab selected. With the window unfocused the taskbar button also flashes. `working` and `done` never toast; this is narrower than iOS, which also alerts on `done`, because a desktop window left open would fire one for every finished prompt.

**Not ported.** The iOS in-app banner for another session on the same host (the pill and the toast cover it), and Approve/Deny/Reply buttons on the toast itself: Windows toasts here carry no actions.

### Connect

Opening a card:

1. Dial `host:port` with a 10 s connect timeout.
2. Read the server host key. Fingerprint is SHA-256 of the host key blob, lowercase hex, colon-separated bytes. The same string format the iOS client pins.
3. Nothing pinned for this host and port: pin it and continue. Pinning happens before auth, as on iOS.
4. Pinned and different: stop. Do not offer a way to replace the pin.
5. Authenticate with the machine's key, the agent, or its password. The secret is loaded for the attempt and not kept in the profile JSON or in memory afterwards. Agent auth connects to `\\.\pipe\openssh-ssh-agent` and offers its identities in the agent's order; when that pipe does not exist it tries Pageant instead. On Linux it connects to the socket named by `SSH_AUTH_SOCK` and has no second agent to try. The private key never leaves the agent. Agent forwarding is never requested. Keepalive is set after auth, every 15 s; set before the handshake it breaks strict KEX on modern OpenSSH.
6. Run `~/.local/bin/zmx ls` on a control connection (see below) to build the tab strip and choose the first tab (see Sessions). The binary path is `~/.local/bin/zmx`, same as iOS.
7. For the chosen tab, open a PTY channel sized to the grid on the terminal connection, start the login shell, and push the current size.
8. Type `~/.local/bin/zmx attach '<name>'` plus newline into that shell, name shell-quoted. Tether attaches by typing into the login shell, not by exec, exactly as iOS does, so the user lands in their shell if they detach.

Transport failures retry up to three attempts, 500 ms apart. Auth failures and a host-key mismatch never retry.

The connecting screen is the terminal header on an empty well, status `connecting`.

**Through a jump host.** With **Connect through** set, steps 1–5 run for each hop in turn, first hop first: dial it (directly, or through a `direct-tcpip` channel on the previous hop), pin or check its host key under its own `host:port`, and authenticate it with its own key, agent, or password. A refused key on any hop stops the chain there, before anything is sent to the next. The target's connection holds the chain open, and keepalive runs on the target only: its packets cross every hop, so a dead jump host drops the session like a dead network.

### Reconnect

A drop after the session was up keeps the terminal page, the strip, and every tab's grid. Status goes to `reconnecting`, input is dropped (not queued), and the client redials with the same steps, then re-attaches every tab that was attached, each on a fresh channel, active tab first. It tries three times with 1 s, 2 s, 4 s backoff, and again whenever Windows reports the network back, the window regains focus, or the PC resumes. After that the status is `disconnected` and a capsule on the grid offers **Reconnect** and **Back to Home**.

A drop is a socket error, or two missed keepalive replies. A mismatch on redial lands on the refused page.

**Sleep.** A socket that slept through a suspend often still looks open, and waiting for keepalives to notice takes 30 s. On `PBT_APMRESUMEAUTOMATIC` the client drops the connection and redials at once, without waiting for a failure. A network change (`INetworkListManager` connectivity event) does the same when the route to the host changed. Unlock after a lock re-attaches what the lock detached.

### Host key refused

This page uses Home chrome. The session never opened, so there is no terminal well.

> Host key changed — refused.
>
> Expected
> `aa:bb:…`
>
> Got
> `11:22:…`

Both fingerprints are selectable for copying. The only action is **Back to Home**.

### Couldn't connect

Same chrome. One sentence, then **Retry** and **Back to Home**.

| Cause | Sentence |
|---|---|
| Auth rejected | Authentication failed. Check the key or password. |
| Key deleted | This machine's key was deleted. Edit the machine and choose another key. |
| Agent not running | No SSH agent is running. Start the OpenSSH Authentication Agent service or Pageant, or choose a key. (Linux: no agent socket answers on `SSH_AUTH_SOCK`.) |
| The machine to connect through was removed, or the jumps loop | The machine this one connects through is gone. Edit the machine and choose another, or Direct. |
| Agent has no key the host accepts | The SSH agent has no key this host accepts. |
| Connect timeout, or no reply after the handshake | The host stopped answering. |
| TCP, handshake, or other transport | Could not connect: \<detail\> |

`zmx ls` failing is not a connect failure: the client opens one `default` tab as if the list were empty of matches, and the next refresh fills the strip.

## History

A tab attached late shows only what arrives after the attach: `zmx` runs the program on an alternate screen, so the local scrollback never holds the session's earlier output. iOS reads it with `zmx history` into a read-only, selectable text view. Windows does the same, and for the same reason it does not try to prefill the live grid: replaying a transcript into the terminal would put text where the program's own screen is about to be redrawn, and the two would interleave.

**History** (header button, or Ctrl+Shift+H) opens a read-only page over the terminal area, tab strip included, so the session it shows cannot change underneath it. The title names the session. The text is monospaced in the terminal theme's foreground on its background, wraps, opens scrolled to the newest line, and is selectable with the mouse; Ctrl+C copies a selection. **Copy all** puts the whole text on the clipboard. **Reload** asks again. **Done** or Esc closes it. Keys do not reach the PTY while it is open.

The command is `~/.local/bin/zmx history '<session>'` (the iOS binary path, no flags), run with `exec` on the control connection, so a slow answer never holds up PTY output. The session name goes through `valid_session_name` and `shell_quote`; an invalid name runs nothing. Only the newest answer is used: a reply for an older request is dropped.

The text is cleaned before it is shown: escape sequences and other control bytes are removed, CRLF becomes LF, trailing spaces and blank lines at either end go. It is capped at 256 KiB, keeping the newest whole lines, with a note when the start was cut: a text view that lays out the whole transcript stalls well before a terminal's 10,000-line scrollback fills it. iOS has no cap; it does not need one because its text view is native.

When the host answers with nothing, fails, or the tab is not attached, the page falls back to this window's own scrollback for that tab (the iOS fallback), and says so. With nothing in either, it reads "Nothing in this session's scrollback yet." with Reload.

Search inside the history is the scrollback search's job, not this page's.

## Snippets

iOS has a customizable key bar of macro keys for the keys a phone keyboard lacks. A PC keyboard has them, so Windows keeps the part that still matters: saved text you send with one action. A snippet is a name and a text. The text uses the iOS `MacroText` escapes, byte for byte: `\r` and `\n` send Return (terminals expect CR), `\t` Tab, `\e` Esc, `\cX` Ctrl-X (`\c?` is DEL), `\xHH` one ASCII byte below 0x80, `\\` a backslash. Any other backslash stays as typed.

**Palette.** **Snippets** (header button) or Ctrl+Shift+P opens a centered list with a search field focused. Typing filters it: names that start with the query, names that contain it, names with its letters in order, then snippets whose text contains it. Up and Down move, Enter or a click sends, Esc or a click outside closes. Each row shows the name and the text with control bytes made visible (`⏎`, `⇥`, `⎋`, `^C`). With no snippets the palette says so and links to Settings. It opens only on a tab whose channel is up.

Ctrl+Shift+P is free in terminals: Ctrl+P (previous history entry) is untouched, because only the Shift form is taken.

**Sending.** The expanded text is written to the active tab as typed input, not as a bracketed paste. Bracketed paste turns a newline into text the shell edits, so a snippet ending in `\n` would never run. That is also the iOS behaviour for macro keys. A snippet without a trailing `\n` types its text and waits. The view snaps to the bottom first, as for any typed key.

**Settings → Terminal → Snippets** is its own page: a name field, a text field with the escape table under it, **Add snippet** (**Save changes** while editing, with **Cancel**), and the list in saved order with move up, move down, Edit, and Delete. Delete asks first. The form says why a snippet can't be saved: no name, no text, a name over 48 characters, a text over 2048, more than 100 snippets.

Stored in `snippets.json` next to `preferences.json`, in saved order. A file that exists but cannot be read is never overwritten: the page says nothing is saved. Snippets are per PC, not per machine.

## Google Fonts

The Font page gets the iOS "download a family" flow under the bundled rows. A field takes a `fonts.google.com/specimen/…` link, a `fonts.googleapis.com/css2?family=…` link, a share link, or just a family name; **Download** starts it, and one-tap chips offer the iOS list of monospaced families. Only those link forms and plain names are accepted, and only `https://fonts.googleapis.com` and `https://fonts.gstatic.com` are ever requested.

1. The CSS API is asked for the family with weights 400 and 700 (400 alone when it answers "no such weight"). A client that is not a browser gets TrueType URLs, which the rasterizer reads; WOFF2 is never requested.
2. The face closest to 400 is the regular, and a 700 is the bold when the family has one. A family without a bold draws bold text with its regular face.
3. Each file must be at most 12 MiB, must start like a font file, and is written with the other into a staging folder that is moved to `fonts\<slug>\` under `%LOCALAPPDATA%\Tether\` only when both are complete. A failure leaves nothing behind.
4. The rasterizer parses it and refuses a face that is not monospaced (narrow and wide glyphs have different advances), with a message that says so.
5. The family joins the Font page's list, is selected at once, and is saved in `fonts\fonts.json` with its stored id `gf-<slug>` (the iOS form). At launch each stored family is read and registered before the first frame; one whose files are gone or no longer parse is dropped from the list. Folders the list does not name, and staging folders, are deleted at launch.

**Remove** deletes the files and the entry; if that font was selected, the selection falls back to Cascadia Mono. A family cannot be downloaded twice; remove it first. Fonts are drawn by the Tether rasterizer, so the Font page's own rows, which Slint draws, show a downloaded family's name in the UI face rather than in itself.

Offline or blocked: the status line under the field says Google Fonts could not be reached, and the form keeps the text. HTTP errors say the status. An unknown family says so by name. Redirects are not followed, so a download can never be sent to another host. Everything runs off the UI thread. Up to 24 families.

Re-adding a removed family with different bytes in the same session asks for a restart, because the glyph cache is keyed by font id for the life of the process. The bundled faces are unchanged and remain first.

## Files and images

Three ways in, one path out: drop on the grid, **Send file…** (system picker, multi-select), and paste an image from the Windows clipboard. All three upload to the host and then paste the remote path into the session, the iOS photo trick: a TUI like Claude Code attaches an image when its path arrives as a paste, and leaves it as plain text when the same characters are typed.

### Clipboard images

Every paste (Ctrl+V, Ctrl+Shift+V, Shift+Insert, right-click) checks the clipboard first:

| Clipboard holds | Paste does |
|---|---|
| Text | Pastes the text, as today |
| An image and no text (a Win+Shift+S snip, Copy image in a browser) | Uploads it as `paste-<unix seconds>.png` and pastes its path |
| Files copied in Explorer (`CF_HDROP`) | Sends them as if they were dropped |

Text wins when the clipboard holds both text and an image. An empty clipboard pastes nothing.

The image is read from the `PNG` clipboard format when present, else from `CF_DIBV5` / `CF_DIB`, and encoded as PNG so a screenshot stays lossless. Alpha is kept.

### Image formats

Same rule as iOS `MediaTransfer.jpegName`: `png`, `jpg`, `jpeg`, `gif`, and `webp` are sent as they are. Any other image a TUI would not attach (HEIC, HEIF, AVIF, BMP, TIFF, JXR) is decoded with WIC and re-encoded as JPEG at quality 0.9, under the same base name with `.jpg`. When WIC cannot decode it (HEIC without the Windows HEIF extension), the file is sent unchanged and its path still pasted. Non-image files are never touched.

The 200 MB limit applies to what is sent, after re-encoding. A file over it is refused before it is read:

> That's 214 MB — Tether sends up to 200 MB at a time.

Folders are refused with "Tether sends files, not folders."

### Upload

Everything goes to the uploads folder, never into the shell's working directory, so a screenshot does not land in whatever repo the shell is in. The folder is resolved once per send on the control connection with the iOS command:

```sh
mkdir -p "$HOME/.tether/uploads" && cd "$HOME/.tether/uploads" && pwd && echo __TETHER_UPLOADS_OK__
```

The client trusts the line before the last `__TETHER_UPLOADS_OK__` marker only when it is an absolute path. The pasted path must be absolute so a TUI in any directory can open it. If that fails, the file goes to the active tab's session directory. The remote path is `directory/filename`, or the bare filename when no directory resolved. Transfer is SCP sink mode (`scp -t`) on its own SSH connection per file, shell-quoted target, so a large file does not block the live session or the others. A file with the same name is overwritten, as iOS does.

### Paste back

Each file that arrives is pasted, into the tab that was active when the send began, as soon as it lands: its shell-quoted absolute path, as one paste through the PTY paste path (bracketed when the program asked for it, markers in the text stripped), never as typed keystrokes. Files go in order; every paste after the first starts with a space, so several images become one line of quoted paths and each still arrives as its own paste, which is what makes Claude Code attach each one.

While a send is in flight the header stays, and a capsule at the bottom of the grid reads `Sending paste-1791082819.png (2/3)`. On success it reads `Sent ~/.tether/uploads/paste-1791082819.png`. A failure stops the queue: files already sent stay on the host and stay pasted, and the capsule names the file that failed and why. The capsule leaves on the next keystroke, or after 4 seconds.

## Repository and documents

A **Git** button in the terminal header opens a side panel next to the grid (the grid resizes to what is left; the panel is at most 440 px or half the window). It follows the active tab: switching tabs reloads it for that session. There is no iOS sheet here because a desktop window has the room, and the terminal stays usable beside it.

The directory is the session shell's live cwd, `readlink /proc/<pid>/cwd` on the control connection, with the OSC 7 report and then the `zmx ls` cwd as fallbacks (the iOS order, plus OSC 7). Nothing else is read from the host than what these commands print; there is no server component.

### Panel

Header: a Back button when a diff or pull request is open, the branch in mono (the title of the open page otherwise), a `+n −m` line, Refresh, Close. Four tabs, as an iOS segment:

- **Changes.** `git diff HEAD` (staged and unstaged, tracked files; `git diff` in a repository with no commit yet), listed per file with `+n −m`, followed by untracked files marked `new`. iOS lists `git diff` only; staged work vanishing from the list is wrong on a desktop where you stage in the terminal. A file opens its diff. A `.md` file has a Preview button.
- **Commits.** The last 50, `<subject>` over `<hash> · <author>`. A commit opens its message and diff (`git show --patch`, message split from the patch at an `0x1e` marker so git's `---` is never read as a deletion).
- **PRs.** `gh pr list --state all --limit 50`, closed-without-merge dropped, badge Open / Draft / Merged. `gh` missing prints a sentinel: the tab says GitHub CLI isn't installed on this host, which is different from `gh` refusing (its first line is shown) and from an empty list ("No pull requests").
- **Docs.** `.md` and `.markdown` files of the repository (`git ls-files --cached --others --exclude-standard`, 300 at most). Selecting one opens the markdown viewer. iOS has no equivalent; this is the desktop's way in to a file without a path-detection hook in the grid.

The list refreshes every 15 s (60 s on PRs) while it is the visible page, never under an open diff. A refresh in flight is never stacked, and an answer for a superseded request is dropped.

### Diff

One mono list, 20 px rows: a bold row per file with its stat, the hunk's full `@@ -a,b +c,d @@ context` line, old and new line numbers, `+` or `−` in the gutter, green and red row tints, context in the text colour. Git's own headers (`index`, `---`, `+++`, mode lines) are not rows. `Binary files … differ` and `\ No newline at end of file` are plain rows that take no line number. The list scrolls both ways (the width follows the longest of the first 400 columns). More than 20 000 rows are cut with a note; the host cuts a patch at 2 MB.

The parsing is the iOS `DiffFile`, `GitDiffModel` and `GitRepositoryModel` rules ported to `tether-core` with their test cases: a file is named by its new path, a hunk keeps only its context in `text`, a preamble before the first file (commit message) is kept as plain rows, and a patch with no marker is all patch.

### Pull request

Title, `head → base`, state chip, file count and review decision. A checks card: the rollup headline (`No checks`, `n failing`, `x of n running`, `n checks passed`; failing outranks running) and one row per check, a link when it has a URL. A merge card shows the gate. **Review changes** opens the PR diff (`gh pr diff`), **Open in GitHub** the page.

The gate is the iOS one, from `gh pr view --json mergeable,mergeStateStatus,isDraft`: a draft wins over everything, a conflict wins over `BLOCKED`, `UNKNOWN` is "Checking mergeability…", then `BEHIND`, `BLOCKED`, otherwise ready. Only a ready, open pull request enables the button, and only when `gh repo view` allows at least one method (`mergeCommitAllowed`, `squashMergeAllowed`, `rebaseMergeAllowed`; an unreadable answer allows none). The button is labelled with the default method, squash if allowed.

**Merge** opens a confirm dialog titled `Merge #n?` with the allowed methods as options (squash preselected) and Cancel / Merge. Confirming checks the gate again against the latest answer and refuses silently if the pull request stopped being mergeable while the dialog was open. Then `gh pr merge n --squash|--merge|--rebase`. On success the page flips to Merged without waiting for GitHub to propagate; on failure `gh`'s first line is shown and the detail is fetched again. While checks are running or the gate is being computed, the page re-reads every 10 s.

iOS also offers Close, Checkout and Update branch on a pull request, and streams `gh pr checks --watch` over a second connection. Those are not here: Checkout and Update change the working tree under the running shell, Close is one click from GitHub, and polling at 10 s needs no second connection.

### Markdown viewer

Opened from a Preview button (Changes, Docs) and covering the page, Close returns. It is read-only: headings (three sizes), paragraphs, bullet and numbered lists (nested items are flattened), block quotes, rules, fenced code and pipe tables in a mono block. Inline emphasis and code markers are dropped and `[label](url)` is kept as its label with a link chip under the block; bare URLs also become chips. A chip opens through the same safe-link rule as links in the grid (`http`, `https`, `mailto` only); `javascript:`, `file:` and relative links are plain text. Images show their alt text. The viewer is the iOS `MarkdownDocument` parser (pull request bodies there) plus tables, `+` bullets, `~~~` fences and the `3.14 is not a list` rule.

The file is read with `head -c 524289 -- <path>`, so a file over 512 KiB shows its start and a note. The path is always the repository root joined to a path the panel itself listed: it must be relative, free of control characters and of `..`, and is quoted as one argument.

Ctrl+click on a detected `.md` path in the grid is not implemented: it needs path detection across wrapped rows, and the Docs tab and the Changes list reach the same files.

### Remote commands

Every command is built in `tether-core` (`git`), passed through `shell_quote`, and run as `sh -c '<script>'` so it does not depend on the login shell (fish does not parse `{ }`). The script ends in `printf '\n__TETHER_RC__%s' "$?"`: the exec channel reports a non-zero exit as a failure and drops stdout, which would hide `gh`'s reason. Directories must be absolute with no control character, commit ids hexadecimal, pull request numbers are integers, repository paths are validated as above.

## How it is built

A Cargo workspace under `clients/desktop/`:

| Crate | Job |
|---|---|
| `tether-core` | Profiles, key records, key parsing and validation, host-key pin logic, form hints, theme catalog, font ids, preferences, upload path rules, the session list and tab rules (first tab, new-session name, refresh merge, kill order, attach cap), link detection, OSC notification and progress parsing, and the connection sequence behind a `Transport` trait. No UI, no network. |
| `tether-ssh` | The `Transport` trait implemented with `russh` on a tokio runtime that the app owns. Terminal connection with one PTY channel per attached tab, control connection, one connection per upload, and the Windows OpenSSH agent client. |
| `tether-term` | `alacritty_terminal` as the VT engine, plus a rasterizer that turns its grid into an RGBA buffer. Glyphs are shaped and rasterized with `swash` into a glyph atlas keyed by face, size, and scale. Themes, fonts, cursor, and padding are inputs to that buffer. |
| `tether-app` | The Slint window. Fluent widget style, recolored to the Tether tokens. The terminal page shows the active tab's buffer as an image at physical pixel size. Win32 glue: caption color, `SC_KEYMENU`, clipboard formats, toasts, `ITaskbarList3`, power and session-lock notifications, `ShellExecuteW`. |

Slint's default blue does not replace `#7C8CF8`.

### Why `russh`, not `ssh2`

The iOS app shares no Rust with this client, so libssh2 buys nothing here. On Windows, `libssh2-sys` builds against WinCNG unless OpenSSL is vendored in, and the WinCNG backend has no Ed25519, which is the only key Tether generates. `russh` is pure Rust: Ed25519, RSA-SHA2, ECDSA, ChaCha20-Poly1305, strict KEX, and OpenSSH, PKCS#8, and PKCS#1 key parsing, with no C toolchain or OpenSSL in the Windows build.

The client keeps iOS's connection split: one terminal connection for the PTYs (one channel per attached tab), a separate control connection for `zmx ls`, `zmx kill`, and the uploads directory, and one connection per upload. A stalled upload or a slow exec then cannot hold up PTY output.

### Stored on disk

`%LOCALAPPDATA%\Tether\`. Local, not roaming: secrets are bound to this PC, and records that point at them must not roam without them.

| File | Contents |
|---|---|
| `profiles.json` | Machine list. Auth is `password`, `agent`, or a key id. No passwords, no private keys. |
| `keys.json` | Key records: id, name, algorithm, public line, fingerprint, origin, created. |
| `preferences.json` | Appearance, terminal settings, window placement. |
| `hostkeys.json` | `host:port` → fingerprint. Public host identity, same role as iOS UserDefaults. |
| `snippets.json` | Saved snippets: id, name, text, in order. |
| `fonts\fonts.json`, `fonts\<slug>\` | Downloaded Google Fonts families and their font files. |
| `secrets\<account>.bin` | One DPAPI blob per secret. |

Writes go to a temp file and then rename, so a crash never leaves half a JSON file.

Secrets are encrypted with DPAPI (`CryptProtectData`, current-user scope, the app's own entropy bytes). That binds them to this Windows user on this PC, the same role as an iOS Keychain item that does not sync. Credential Manager is not used. It caps a secret at 2560 bytes, which a 4096-bit RSA key exceeds, and enterprise-persisted entries roam with a roaming profile.

| Account | Secret |
|---|---|
| `key-<uuid>` | Private key as imported, or PKCS#8 PEM when generated |
| `host-password-<uuid>` | The machine's password |

**On Linux** the folder is `$XDG_DATA_HOME/tether` (`~/.local/share/tether`). The v4 desktop app used the Tauri identifier `cloud.samlo.tether`, so that name never collides. There is no `secrets` folder: secrets live in the desktop's Secret Service keyring (GNOME Keyring, KWallet, KeePassXC) as items labelled `Tether (<account>)` with the attributes `application=tether` and `account=<account>`, in the default collection. A locked collection raises the keyring's own unlock prompt when a secret is read or saved; whether a password is saved is answered without unlocking. A call that shows no prompt gives up after 5 s and one waiting on a prompt after 2 minutes. With no Secret Service reachable, or an unlock that is dismissed, saving a password or key fails with a message saying so, and a connection is refused with that message and not retried; secrets are never written to a plaintext file. Logs go to `$XDG_STATE_HOME/tether/logs` (`~/.local/state/tether/logs`).

Deleting a machine deletes its password entry. Deleting a key deletes its secret.

### Linux platform layer

`tether-app/src/platform/linux/` implements the `Platform` trait for Linux, on X11 and on native Wayland. Every feature that is a Windows API there maps to a freedesktop interface, with pure-Rust dependencies and no GTK.

| Feature | Linux |
|---|---|
| Notifications | `org.freedesktop.Notifications` over the session bus (`zbus`), on a worker thread so the UI never waits on the daemon. Same shaping as the Windows toast: the header, then the first two non-empty body lines; the body is escaped only when the daemon advertises `body-markup`. One live notification per machine and session: a newer one passes `replaces_id`. The `default` action (a click) arrives as `Msg::ToastClicked`. |
| Taskbar flash, bring to front | winit `request_user_attention` and `focus_window`. |
| Progress | The `com.canonical.Unity.LauncherEntry` `Update` signal for `application://tether.desktop` (`progress`, `progress-visible`, `urgent`), read by KDE and dock extensions. It has one bar: paused and error show their value (error also sets `urgent`), indeterminate shows an empty bar. |
| Clipboard | X11: `arboard` (selections). Wayland: the app's own data device on winit's `wl_display` (see Wayland below). Text, `text/uri-list` as a file drop (GNOME's `x-special/gnome-copied-files` too), and an image as PNG (JPEG, BMP and TIFF are re-encoded). A file manager's text copy of the paths counts as a file drop. No DIB. |
| Open a link | `xdg-open`, detached, started without an AppImage's library variables (`tether_core::hostcmd`). |
| File picker | `rfd` on its XDG desktop portal backend, so the AppImage needs no GTK. The dialog is awaited from the event loop, so the window keeps painting while it is open. The error box runs `zenity` (the portal has no message dialog) and always writes to stderr. |
| Image re-encode | The `image` crate decodes BMP and TIFF and encodes JPEG at quality 90. HEIC, HEIF and AVIF would need C decoders, so they are sent as they are. |
| System light or dark | `org.freedesktop.portal.Settings` `color-scheme` (2 is light; 1, 0 and a missing portal are dark), read once at startup with a 500 ms limit. The window theme follows the palette through winit `set_theme`; there is no caption to colour. |
| Sleep, lock | logind on the system bus, subscribed only, started with the platform (the session is `GetSession("auto")`, which also covers an app launched from the desktop's own systemd scope): `PrepareForSleep(false)` is `Resumed`; the own session's `Lock` and `Unlock` signals and its `LockedHint` property (what desktops set on an idle lock) are `Locked` and `Unlocked`, once per change. |
| Network | A netlink route socket (link, address and route groups, settled for 300 ms) triggers a re-check of the route to the host: the interface of the source address the kernel picks, fed to the same `route_change` rule as Windows. Online means a route to the host exists. |

### Wayland

The window is a native Wayland client on GNOME and KDE (winit's Wayland backend with client-side decorations). XWayland is not needed.

- **App id.** `slint::set_xdg_app_id("tether")` sets the Wayland `app_id` and the X11 `WM_CLASS` class to `tether`, so a `tether.desktop` entry, the notification's `desktop-entry` hint and the launcher entry all name the same window. The X11 instance name is empty.
- **Decorations.** GNOME has no server-side decorations, so winit draws its own title bar (sctk-adwaita). The buttons follow the desktop's `button-layout` setting (GNOME shows only Close by default) and the bar is dark or light with the palette through `set_theme`. KDE draws server-side decorations.
- **Clipboard.** GNOME's compositor offers no data-control protocol, so no client can read the selection while unfocused, and arboard's Wayland backend falls back to XWayland, which a session without X11 does not have. The app instead opens a second event queue on winit's own display (`platform/linux/wayland.rs`), binds `wl_data_device_manager` and the seat, and runs one thread that dispatches it, as GTK does. Reading uses the offer the compositor gave this window; copying uses the serial of the last key or pointer event. So both work only while the window has focus, which is when a copy or paste is asked for. The mime types read are text (`text/plain;charset=utf-8` first), `text/uri-list` and `x-special/gnome-copied-files`, and `image/png`, `image/jpeg`, `image/bmp`, `image/tiff`. Copying offers UTF-8 text only; a Latin-1 `STRING` offer is read but never made. The primary selection is not used. If the data device cannot be bound or its thread ends, copy and paste fall back to arboard.
- **Keyboard.** AltGr symbols, dead keys, Compose and `Ime::Commit` arrive as text and are sent as typed; dead-key presses send nothing. On Linux a key pressed with Super held is never typed, because the desktop owns those shortcuts. The IME's preedit text and candidate popup position are not drawn: the app never sets an IME cursor area, so an input method's popup appears at the window corner.
- **Scale.** Window size is saved and restored in logical pixels, because a Wayland window does not know its monitor's scale until it is shown. The terminal grid is measured again once the window exists, since X11 sends no scale change for the scale a window starts with.
- **Placement.** Wayland can neither set nor read a window's position. The size restores; the saved position is kept as it was and ignored. On X11 a saved position whose title strip touches no monitor is moved to the primary monitor once the window exists (a 40 px strip, the rule the Windows build uses).
- **Focus from a notification.** A daemon sends `ActivationToken(id, token)` just before `ActionInvoked`. The app keeps a token only for one of its own notifications and, on that notification's click (within 10 s), passes it to `xdg_activation_v1.activate` for its surface. Without a token or the protocol, bringing the window to front can only flash the window with `request_user_attention`, and the compositor may then show it as demanding attention instead of raising it. Whether the compositor raises it depends on its focus-stealing rules and the token's age.

### Build, CI, and packaging

- `ci.yml` has a `windows-latest` job: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` for the workspace, and a release build of `tether-app`. A `desktop-linux` job runs the same gates with `--locked` inside an `ubuntu:22.04` container on `ubuntu-latest`, then builds the AppImage and uploads it as a workflow artifact. The old base is on purpose: a binary links the glibc of the machine that built it, so building on 22.04 (glibc 2.35) keeps the AppImage starting on every distro at least that recent. A container rather than the `ubuntu-22.04` runner image, which is being retired and would otherwise block the Windows release that waits on the Linux build. Its apt build dependencies are `pkg-config` and `libfontconfig1-dev` (plus a compiler, `squashfs-tools` and the .NET SDK for `vpk`); the windowing, GL and D-Bus libraries are loaded at run time.
- Every crate's tests run on Linux in CI. The Secret Service round trip in `tether-core/tests/secret_service.rs` runs only on a private session bus the caller sets up, and the Unix agent test starts a real `ssh-agent`. On Linux the terminal's emoji, symbol and CJK fallbacks come from fontconfig, and the window chrome uses its `system-ui` family. `tether-app` builds on Linux too.
- `desktop-release.yml` releases on a `desktop-vX.Y.Z` tag (`windows-vX.Y.Z` before 0.0.5), whose version must equal the workspace version. One tag builds Windows and Linux into one release, "Tether desktop X.Y.Z", with a single `SHA256SUMS.txt` covering every file. Windows ships a Velopack installer (per-user, no admin, installed to `%LOCALAPPDATA%\TetherTerminal`, never the data folder) and a portable zip. Neither is code-signed yet; the MSIX is built but not shipped until it is. Linux ships `Tether-<version>-x86_64.AppImage`.
- Installed apps update themselves: at launch they read their OS's rolling feed release (`windows-feed`, `linux-feed`), download a newer version in the background, and apply it on the next launch or from **Settings → About → Restart**. Each feed holds the newest full package and the one before it, and never moves backwards. The portable zip does not update.
- On Linux the AppImage is built by `packaging/linux/package.sh` with `vpk pack`. The pack id is `tether`: Velopack derives the AppImage's own desktop entry from it (`Icon=tether`, `StartupWMClass=tether`, matching the window's app id), and would keep its downloaded packages in `/var/tmp/velopack/tether`, a folder shared by every user whose newer packages are installed at launch without any check. The app therefore points both the startup hook and the updater at a private folder, `$XDG_CACHE_HOME/tether/updates` (default `~/.cache/tether/updates`), created mode 0700, refused if it is a symlink or not owned by the user, and passed on to the updater as its package directory. If that folder cannot be had, the app is left unmanaged and never touches `/var/tmp`. The script fails if that entry stops carrying `StartupWMClass=tether`. `packaging/linux/tether.desktop`, the hicolor icons and the AppStream metainfo are the entry for source and distro installs; `vpk` cannot take them into the AppImage. The updater replaces the AppImage file in place, so it must live somewhere the user can write. A run outside a mounted Velopack AppImage (a dev build, a distro-installed binary, an unpacked tree) reports "Not running from the AppImage, updates not managed". Debug builds read `TETHER_UPDATE_FEED` to point the updater at an http(s) feed, such as a local web server; release builds ignore it. An `--appimage-extract-and-run` copy is managed like a mounted one: `APPIMAGE` still names the original file, and the updater beside the extracted binary replaces it.
- The AppImage bundles the app binary and its licenses only. It links the host's `libfontconfig`, `libfreetype`, `libpng` and glibc; the windowing (X11 or Wayland), GL and D-Bus libraries are loaded at run time from the host, and running it directly needs FUSE 2.
- Slint is used under GPLv3, which matches this repo's license.

## Tests

`tether-core`, `tether-ssh`, and `tether-term` test without a live host and without a window.

- Form hints, in field order, including whitespace, port range, and the key hints: encrypted key, public/private mismatch.
- Key parsing: OpenSSH, PKCS#8, and PKCS#1 accepted; the algorithm comes from the public line; a generated key round-trips through PKCS#8 and signs.
- Upload path: marker required, relative lines ignored, join with the filename, 200 MB rejection copy, folders refused.
- Image rule: attachable extensions pass through, others map to `.jpg`, an undecodable image is sent unchanged, the limit is checked after re-encoding.
- Clipboard paste: text pastes text; image-only becomes `paste-<ts>.png`; `CF_HDROP` becomes a drop; text wins over an image; Ctrl+V and Ctrl+Shift+V behave the same; Ctrl+C copies with a selection and sends `0x03` without one; Ctrl+Q sends `0x11`.
- Host key: first seen is pinned before auth, match continues, mismatch is the refused error, does not write, and is never retried.
- Session choice: `default` wins, else newest by `created`, else none; `zmx ls` failure opens `default`.
- Tabs: strip order by `created`; refresh adds and removes tabs and picks the neighbor when the active one vanishes; new-session name (`default`, then first free `session-N`); an existing name selects its tab; kill switches away first and leaves the empty state on the last one; the 11th attach detaches the least recently viewed; tab shortcuts wrap and Ctrl+Shift+9 is the last tab.
- Attach command: name is shell-quoted; nothing is typed on an empty host; each tab gets its own channel and grid; reconnect re-attaches every attached tab, active first.
- Lock: detach after the 15 s grace, not before; unlock re-attaches; minimize does nothing.
- Links: OSC 8 wins over detected text; a URL wrapped across rows and one cut by `│ ┃ ⎿` resolve to the whole URL; only `http`, `https`, `mailto` open; Ctrl+click is never reported to the program.
- Replies: OSC 10/11/12 and OSC 4 answer in `rgb:` form with the current theme and overrides; DA and DSR answered; CSI 21t ignored.
- Notifications: OSC 9 and OSC 777 parse, `9;4` is never a toast, the 5 s per-session throttle, no toast for the focused active tab.
- Progress: each OSC 9;4 state maps to the taskbar state; OSC 133;A clears it.
- Edit: an empty password keeps the saved one; leaving Password deletes it; a new host or port leaves the old pin in place.
- Theme lookup falls back to Tether. Font lookup falls back to Cascadia Mono. Size, spacing, and padding clamp.
- The connection sequence against a fake transport: pin, refuse, auth failure, retry count, keepalive after auth, reconnect re-attaches the same name.
- Send queue: order, one bracketed paste per file with a leading space after the first, stop on failure with earlier pastes kept.
- Resize: local redraw per step, one PTY resize after the settle window.
- Key table: every row above in normal and application cursor/keypad mode, each modifier parameter, Ctrl folding, Alt as `ESC` prefix, AltGr text on a Canadian French layout, Shift+Enter as `ESC CR`, and the keys Tether keeps never reaching the PTY.
- Secret store: DPAPI round-trip and delete (Windows job only), and an in-memory store for the rest.
- Rasterizer: a known cell buffer produces a buffer of the expected size at 1× and 2×, the theme background is the well color, and a missing glyph falls back to the symbols font.
- Macros: `\r \n \t \e \cX \c? \xHH \\` expand as on iOS; an unknown or unfinished escape stays as typed; `\x80` is not a byte; control bytes show as `⏎ ⇥ ⎋ ^C`.
- Snippets: validation messages and caps, trimmed names, replace in place, move clamps at the ends, palette ranking (name prefix, name contains, letters in order, text), a snippet sends typed bytes with no bracketed paste, the palette needs a live tab, Esc closes it, and the selection stays in range when the list changes.
- History: the command quotes the name and refuses an invalid one; escapes, CRLF, and control bytes are cleaned; the 256 KiB cap keeps whole newest lines and never splits a character; an empty or failed host answer falls back to the tab's own scrollback; an older answer is dropped; Copy all sends the text; the driver runs it on the control connection.
- Google Fonts: link and name parsing (specimen, css2, share, `|`-lists, junk and other hosts refused); only gstatic TrueType sources are taken; regular nearest 400 and a distinct 700; install writes both files or nothing; a missing 700 retries unweighted; unknown family, HTTP error, offline, and a non-font file each give their own message; an installed family is refused without a request; the stored list drops unsafe slugs; launch cleanup removes staging and unlisted folders; registration refuses garbage and a changed font under a known id; bundled faces all pass the monospace check.
- `tether-ssh` against an in-process `russh` server: pin, auth by key, by agent (a fake agent pipe), and by password; several PTY channels on one connection, each with its own data; exec; SCP sink.

Live SSH tests against a real host stay off unless an env var opts in, same policy as the iOS suite.

## Decisions locked here

- Rust and Slint, one window, platform title bar.
- `russh`, not libssh2. Same connection shape as iOS.
- Gear on Home and on the terminal.
- Forms are pages. Only destructive confirms are dialogs.
- Windows font default is Cascadia Mono at 14 pt. All faces bundled.
- Secrets in DPAPI under `%LOCALAPPDATA%`, not Credential Manager.
- Sessions are tabs: one per `zmx` session on the host, each on its own PTY channel, attached on first view and kept live; lock detaches after 15 s.
- Attach by typing `zmx attach` into the login shell; an empty host waits for New session.
- Ctrl+click opens `http`, `https`, and `mailto` links, also under mouse reporting.
- OSC 9 and 777 become Windows toasts; OSC 9;4 drives the taskbar progress.
- Auth is a vault key, the Windows OpenSSH agent, or a password. Machines can be edited.
- Files and images come in by drop, picker, or clipboard paste; go to `~/.tether/uploads`, 200 MB each, own SSH connection per file; and come back as one paste per file, so a TUI attaches images. Non-attachable images are re-encoded to JPEG, clipboard images are PNG.
- A changed host key cannot be accepted from this app.
- History is `zmx history` on the control connection shown read-only, not a prefill of the live grid.
- Snippets are typed, not pasted, and use the iOS macro escapes; Ctrl+Shift+P opens them and Ctrl+Shift+H opens History.
- Google Fonts install per user under `%LOCALAPPDATA%\Tether\fonts`, TrueType only, monospace only, no redirects.
