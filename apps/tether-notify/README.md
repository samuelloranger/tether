# tether-notify

Encrypted push for the v5 SSH host. Replaces the old server's `push/` path:
a phone registers its APNs token + a per-device AES-256-GCM key (generated on
the phone, sent over SSH), and `tether-notify` encrypts each notification to
that key and posts the ciphertext to the shared relay. The relay and Apple
never see the plaintext; the iOS Notification Service Extension decrypts it.

## Build

    go build -o ~/.local/bin/tether-notify .
    # or, from the repo root:  bash install.sh

Wire it into agent hooks (Claude Code, Codex, Gemini CLI, Cursor Agent CLI) with
`bash scripts/install-agent-hooks.sh [host-label]`. Each agent reports what its hooks
can see:

- Claude Code: working, needs you, done. With the Tether mod, the phone's
  Approve / Deny / Reply is the real decision; every other agent gets typed keys.
- Codex: working, needs you (permission requests), done. Codex runs a hook only
  after it is trusted: open `/hooks` in Codex once; the installer names any entry
  still untrusted. Its questions have no hook, so they don't show as needs you.
- Gemini CLI: working, needs you (confirmations; a question shows without its
  text), done.
- Cursor Agent CLI: working and done only. Cursor has no hook before its approval
  prompt, and print mode (`-p`) fires no turn events.

## Use

    # the app runs this over SSH on connect:
    tether-notify register <apns-token> <secretKeyB64> [label]

    # agent hooks run this to raise a notification:
    tether-notify notify --title "homelab · claude" --body "Waiting for input" \
      --link "tether://session/default?host=homelab" --collapse default

    # agent hooks run this on every state change; waiting/done also push,
    # unless `zmx ls` shows a client attached to the session:
    tether-notify state --session work --agent claude --state waiting \
      --title "proj · needs you" --body "Allow Bash?" \
      --link "tether://session/work?host=devbox"

    # waiting/done pushes with a tether://session link to their own session carry
    # category tether.agent.waiting / tether.agent.done plus the state and its
    # version, which gives them Approve / Deny / Reply on the phone.

    # the app runs this over SSH to answer an action; it types the input with
    # `zmx send` only while the agent is still in that state (exit 3 otherwise,
    # exit 4 if it moved on between the text and Return):
    tether-notify answer --session work --state waiting --version 3f9a… \
      --input DQ== [--submit]

    # the Claude Code mod runs these when a permission prompt would show and no
    # client is attached: hold records + pushes it (exit 3 when it won't hold),
    # wait blocks until the phone answers, someone attaches, or it goes stale.
    # `answer` then hands the decision to `wait` instead of typing keys.
    tether-notify hold --session work --kind permission --tool Bash \
      --body "Allow Bash: npm test?"
    tether-notify wait --session work --version 3f9a…

    # a question (AskUserQuestion) is held the same way, in any permission mode;
    # the questions go in as JSON on stdin. One single-choice question gets a
    # button per option on the phone; every question push offers Answer…:
    tether-notify hold --session work --kind question --tool AskUserQuestion \
      --body "Which DB?" --questions-stdin < questions.json
    tether-notify pending --session work      # the app's answer sheet reads this
    tether-notify answer --session work --state waiting --version 3f9a… --option 2
    tether-notify answer --session work --state waiting --version 3f9a… \
      --answers <base64 JSON {"question": "answer"}>

    # the app runs this to badge sessions; prunes dead agents and gone sessions:
    tether-notify status

    tether-notify list
    tether-notify remove <apns-token>

Devices live in `~/.tether-notify/devices.json`, session state in
`~/.tether-notify/sessions/` (override the directory with `TETHER_NOTIFY_HOME`).
zmx is found at `TETHER_ZMX`, else `~/.local/bin/zmx`, else on `PATH`. Relay URL defaults to the official one; override with
`TETHER_PUSH_RELAY_URL`. `--dry-run` prints the relay requests instead of
sending — used to prove wire-format parity with the server/NSE.
