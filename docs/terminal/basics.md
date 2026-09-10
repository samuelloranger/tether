# Terminal basics

The mobile terminal is a full VT emulator with a key layer built for a phone. Desktop has no on-screen bar — type on the physical keyboard; see [Desktop app](/desktop#how-it-differs-from-ios).

## Typing

- **Double-tap** the terminal to bring up the keyboard and type. Input is sent straight to the shell as you type — dictation, swipe, and autocomplete all work.
- **Long-press** the terminal to open a selectable, copyable view of the displayed transcript.
- Scrolling never pops the keyboard; only a genuine tap does.
- **Mouse reporting** (vim, tmux, htop, …): tap = click, one-finger drag = drag-select, two-finger drag = wheel. Turn it off from the overflow menu (`⋯`) if you want native scroll/tap instead; the choice persists.

## The soft-key bar

A row of keys the on-screen keyboard doesn't give you: **Ctrl** (arms the next key for a Ctrl-combo), **Tab**, **Esc**, **/**, a **D-pad** (all four arrows, with key-repeat), **paste**, **hide keyboard**, **Del**, **Home**, **End**, **PgUp**, **PgDn**. The row scrolls horizontally.

On **iPad**, a hardware keyboard hides the accessory bar. The session drawer can pin as a sidebar at regular width.

## Font size

Adjust from the overflow menu (`⋯`) → Font size, between 8 and 24px. The terminal re-fits its grid and resizes the remote PTY to match.
