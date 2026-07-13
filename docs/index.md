---
layout: home

hero:
  name: Tether
  text: Persistent remote shells, on every device
  tagline: Real PTY shells on your server, streamed to native apps over WebSocket — on your phone and your desktop. They keep running when you disconnect, and survive server restarts.
  image:
    src: /icon.svg
    alt: Tether
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Development
      link: /architecture

features:
  - title: Sessions that survive
    details: Each shell lives in a detached holder process, logged to SQLite. Disconnect, sleep your phone, restart the server — reconnect and replay exactly where you left off.
  - title: Phone and desktop
    details: The same VT emulator, tuned per device — a mobile key layer (Ctrl, Tab, arrows, voice/swipe) on iOS, and a docked session sidebar with a real physical keyboard and mouse selection on the Linux/Windows/macOS desktop app.
  - title: One binary to self-host
    details: Install with one command, no bun or node_modules on the box. A shared password gates access; tether update swaps the binary atomically.
---
