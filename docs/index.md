---
layout: home

hero:
  name: Tether
  text: Persistent remote shells, on your phone
  tagline: Real PTY shells on your server, streamed to the mobile app over WebSocket. They keep running when you disconnect — and survive server restarts.
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
  - title: Built for the phone
    details: A full VT emulator with a mobile key layer — Ctrl, Tab, Esc, arrows, paste — plus voice/swipe input, tabs, saved commands, and transcript search.
  - title: One binary to self-host
    details: Install with one command, no bun or node_modules on the box. A shared password gates access; tether update swaps the binary atomically.
---
