# tether-notify

Encrypted push for the v5 SSH host. Replaces the old server's `push/` path:
a phone registers its APNs token + a per-device AES-256-GCM key (generated on
the phone, sent over SSH), and `tether-notify` encrypts each notification to
that key and posts the ciphertext to the shared relay. The relay and Apple
never see the plaintext; the iOS Notification Service Extension decrypts it.

## Build

    go build -o ~/.local/bin/tether-notify .
    # or, from the repo root:  bash install.sh

Wire it into agent hooks (Claude Code Notification + Stop) with
`bash scripts/install-agent-hooks.sh [host-label]`.

## Use

    # the app runs this over SSH on connect:
    tether-notify register <apns-token> <secretKeyB64> [label]

    # agent hooks run this to raise a notification:
    tether-notify notify --title "homelab · claude" --body "Waiting for input" \
      --link "tether://session/default?host=homelab" --collapse default

    tether-notify list
    tether-notify remove <apns-token>

Devices live in `~/.tether-notify/devices.json` (override with
`TETHER_NOTIFY_HOME`). Relay URL defaults to the official one; override with
`TETHER_PUSH_RELAY_URL`. `--dry-run` prints the relay requests instead of
sending — used to prove wire-format parity with the server/NSE.
