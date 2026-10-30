# tether

The Tether host tool for the v5 SSH host (formerly `tether-notify`): encrypted push, agent state, and the ACP chat holder. Replaces the old server's `push/` path:
a phone registers its APNs token + a per-device AES-256-GCM key (generated on
the phone, sent over SSH), and `tether` encrypts each notification to
that key and posts the ciphertext to the shared relay. The relay and Apple
never see the plaintext; the iOS Notification Service Extension decrypts it.

## Build

    go build -o ~/.local/bin/tether .
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
    tether register <apns-token> <secretKeyB64> [label]

    # agent hooks run this to raise a notification:
    tether notify --title "homelab · claude" --body "Waiting for input" \
      --link "tether://session/work?host=homelab" --collapse work

    # agent hooks run this on every state change; waiting/done also push,
    # unless `zmx ls` shows a client attached to the session:
    tether state --session work --agent claude --state waiting \
      --title "proj · needs you" --body "Allow Bash?" \
      --link "tether://session/work?host=devbox"

    # waiting/done pushes with a tether://session link to their own session carry
    # category tether.agent.waiting / tether.agent.done plus the state and its
    # version, which gives them Approve / Deny / Reply on the phone.

    # the app runs this over SSH to answer an action; it types the input with
    # `zmx send` only while the agent is still in that state (exit 3 otherwise,
    # exit 4 if it moved on between the text and Return):
    tether answer --session work --state waiting --version 3f9a… \
      --input DQ== [--submit]

    # the Claude Code mod runs these when a permission prompt would show and no
    # client is attached: hold records + pushes it (exit 3 when it won't hold),
    # wait blocks until the phone answers, someone attaches, or it goes stale.
    # `answer` then hands the decision to `wait` instead of typing keys.
    tether hold --session work --kind permission --tool Bash \
      --body "Allow Bash: npm test?"
    tether wait --session work --version 3f9a…

    # a question (AskUserQuestion) is held the same way, in any permission mode;
    # the questions go in as JSON on stdin. One single-choice question gets a
    # button per option on the phone; every question push offers Answer…:
    tether hold --session work --kind question --tool AskUserQuestion \
      --body "Which DB?" --questions-stdin < questions.json
    tether pending --session work      # the app's answer sheet reads this
    tether answer --session work --state waiting --version 3f9a… --option 2
    tether answer --session work --state waiting --version 3f9a… \
      --answers <base64 JSON {"question": "answer"}>

    # the app runs this to badge sessions; prunes dead agents and gone sessions:
    tether status

    tether version [--json]    # `tether <version>` then `protocol <N>`; the app checks both
    tether list
    tether remove <apns-token>

## ACP holder

`acp` keeps an ACP agent (for example `npx -y @agentclientprotocol/claude-agent-acp`)
alive on the host while the SSH connection comes and goes. The stream stays plain
newline-delimited JSON-RPC; nothing is injected into it.

    # run as a non-PTY ssh exec; stdin/stdout are the agent's, byte for byte
    tether acp attach chat1 --spawn 'npx -y @agentclientprotocol/claude-agent-acp' --cwd ~/src/app
    tether acp attach chat1 --from 4096   # resume from a byte offset of the agent's output log
    tether acp attach chat1 --client a1b2c3   # name this client so the others see what it sends
    tether acp ls                         # name, running|ended, log bytes, cwd, created, command
    tether acp status [chat1 ...]         # one JSON object per session (see below)
    tether acp sessions ~/src/app --limit 20   # the agent's saved conversations for a folder
    tether acp workflows --session <id> --json   # background Workflow runs of a Claude Code session
    tether acp kill chat1                 # stop the agent and remove the session

The first `attach --spawn` starts a detached daemon that owns the agent and appends
everything it prints to `acp/<name>/out.log`; an `attach` replays that log from `--from`
and then follows it live, so a client that tracks `from + bytesReceived` sees no gap and
no duplicate. Any number of clients can be attached at once; each one follows the log and
writes to the agent. Only an attach with the same `--client` closes the previous one, which
exits 5 (a holder started by a tether older than protocol 2 closes any previous client). Without `--spawn`, a missing session exits 3. When the agent exits, `attach` drains the log and
exits 0; the session stays in `ls` as `ended` until killed. After stdin EOF, `attach`
sends what is already logged and exits; `--linger 30s` keeps following until output has
been idle that long.

### Several clients

The log only ever grows by whole lines: agent output after its last newline is held until the
line ends. A client attached with `--client <id>` (letters, digits, `-`, `_`) gets what it sends
written into the log, just before the line goes to the agent, as an ACP extension notification:

    {"jsonrpc":"2.0","method":"_tether/client","params":{"client":"a1b2c3","message":{…the line…}}}

This covers `session/new`, `session/load`, `session/prompt`, `session/cancel` and responses to
the agent's requests, so every client, live or replaying later, sees the others' sessions,
prompts, stops and answers in order. A client that attaches again with the same `--client` (or
with none, as a client that predates echoes) replaces its older connection, which exits 5: a
connection the host never saw drop would otherwise count as attached and hold back pushes. An answer
`tether acp answer` writes is echoed with `"client":"host"`. Clients use their own request ids
(for example strings prefixed with their id) so two clients never send the same id. An answer to
a request that was already answered, from any client or from `acp answer`, is not sent to the
agent. A client without `--client` is never echoed.

### Status and saved conversations

`acp status` reads the holder and organization metadata, so it works without talking to the daemon. It prints one
JSON line per named session, or per session when no name is given (exit 3 for an unknown name):

    {"name":"chat1","state":"running","turn":"working","title":"Fix the thing","cwd":"/home/me/src/app","created":1790000000,"logBytes":4096,"endedReason":"","multiClient":true}

`state` is `running` or `ended`. `turn` is `working` between a client's `session/prompt` and
its response, and during a turn Claude Code starts by itself (agent output while no prompt is in
flight, until the usage report that carries its cost), `waiting` while a permission or elicitation request is outstanding (this wins
over `working`), else `idle`; an ended session is always `idle`. `title` is the latest
`session_info_update` title. `multiClient` is true when the session's holder lets several clients
attach (see below); a holder started by an older tether leaves it out. `spawn` is the command that started the agent (absent from older holders), so a client can tell
which agent a chat runs. `tasks`, when present,
counts the background commands still running: Bash calls with a display terminal (the client
declared `_meta.terminal_output`) whose result named a `backgroundTaskId`, until their
`terminal_exit`. Tasks do not keep a session from being stopped for being idle. The end of a
turn the agent started itself sends the same quiet done push as a prompt's end. The daemon
refreshes `title`, `turn` and `tasks` in `meta.json` as the stream moves, writing only when one of
them changes. `acp ls` is unchanged.

### Chat organization and account usage

`acp organize NAME --json PATCH` merges selected organization fields without touching the
agent's live state. For example:

    tether acp organize chat1 --json '{"pinned":true,"title":"Review retry handling"}'
    tether acp organize chat1 --json '{"archived":true}'
    tether acp organize chat1 --json '{"archived":false}'

Supported fields are `pinned`, `archived`, `title` (empty clears a custom name), and
`parent: {"name":"source-chat","title":"Source title","method":"copy"}`. Titles and
parents can be saved before a new holder starts; pin/archive changes require an existing
holder record. Status adds `customTitle`, `pinned`, `archived`, `parent`, and `projectRoot`
(the nearest `.git` directory or worktree marker, falling back to the working directory).
These fields are additive; the original `title` still means the agent's title. Organization
is stored in private sidecar files outside the holder directory, so daemon writes cannot
overwrite it. Archive does not stop or delete a chat. Pinned and archived histories are
exempt from automatic retention; restoring/unpinning grants a fresh normal retention period.
Unreadable organization metadata leaves the agent visible with an `organizationError` and
conservatively prevents pruning until the metadata can be recovered.

`acp usage --json` reads the Claude and Codex accounts signed in on this host:

    {"claude":{"fiveHour":{"usedPercent":42,"resetsAt":1800000000},"weekly":null,"updatedAt":1799999000,"stale":false},"codex":{"fiveHour":null,"weekly":null,"updatedAt":0,"stale":false,"error":"codex is not available on this host"},"checkedAt":1799999000}

The readings include all activity using those accounts, not just this chat. Missing windows
are `null`; genuine zero usage is `usedPercent: 0`. Codex windows are matched by their reported
duration (300 and 10080 minutes), rather than assuming primary always means five hours.
Reset times are Unix seconds. A failed refresh retains a previous successful reading with its
original `updatedAt`, `stale: true`, and an error. Refreshes, including failed attempts, are
shared across devices and throttled to once per minute.

The host queries `codex app-server` through `account/rateLimits/read`, and Claude's stream-JSON
control protocol through `initialize` then `get_usage` with `skip_behaviors: true`. The Claude
control is experimental and unavailable on older CLIs. Its helper disables hooks and MCP,
does not persist a conversation, and never submits a prompt. Both helpers have a 12-second
timeout and are terminated after the reading. Tether never reads or exports provider
credentials. Unsupported CLIs/sign-in methods produce an unavailable state, not an estimate
from token counts. Update the host tool and provider CLIs to enable these optional commands.

`acp sessions <cwd> [--limit N]` starts the agent itself for a moment (not a holder session):
the same `$SHELL -lc` path as the holder, `initialize`, then `session/list` with `{cwd}`
(following `nextCursor`), then the process group is killed. It prints one JSON line per saved
conversation, newest first:

    {"sessionId":"…","title":"…","updatedAt":"2026-03-01T00:00:00Z","cwd":"/home/me/src/app"}

The agent command is `--agent-cmd`, else `TETHER_ACP_AGENT_CMD`, else the pinned
`npx -y @agentclientprotocol/claude-agent-acp@0.95.0`. A failure or a 15 s timeout prints
the reason on stderr and exits 1.

`acp workflows --session <sessionId> [--json]` reports the background Workflow runs of a Claude
Code session, which ACP itself never says anything about after launch. It reads Claude Code's own
files (`$CLAUDE_CONFIG_DIR`, default `~/.claude`): the session transcript (the newest
`projects/<dir>/<sessionId>.jsonl`) for the launch and the `<task-notification>` that ends a run (any
status other than `completed` is passed through), the run's `journal.jsonl` for which agents
started and finished, the saved script's `meta` for the title and phase order, and a bounded tail
of each agent's transcript for its latest tool call. That layout is private to Claude Code and may
change between releases; a session or file that is missing yields no output and exit 0. One JSON
line per run, in launch order:

    {"toolCallId":"toolu_…","runId":"wf_…","title":"review","description":"…","status":"running","startedAt":1790000000,"lastActivityAt":1790000090,"agents":{"total":3,"running":1,"done":2},"phases":[{"title":"Scan","agents":[{"label":"a","state":"done","startedAt":1790000001,"endedAt":1790000090},{"label":"b","state":"running","startedAt":1790000002,"activity":"Bash: go test ./..."}]}]}

`status` is `running` until the notification arrives, then `completed`, `failed`, `killed` or
whatever Claude Code reports, with `endedAt` and `summary`. An agent is `running` or `done`; once
the run has ended, an agent with no result is `stopped` (counted in `agents.stopped`, not in
`running`). `activity` is only given for a running agent of a running run. `lastActivityAt` is the
newest write to the run's journal or agent transcripts: a run whose notification never arrives
stays `running`, and a client can show how long it has been quiet. Times are Unix seconds.

The transcript is scanned incrementally: `~/.tether-notify/workflows/<sessionId>.json` keeps the
file's identity, the offset scanned so far and the launches and endings found, and a call reads
only what was appended. A file that shrank or whose start changed is scanned again from the top.
A transcript line over 1 MiB is never held whole; only its start is read, enough for a
notification that carries a large result.

### Lifecycle and retention

A held agent is a long-lived process and `out.log` is the whole conversation in plaintext, so
the daemon ends idle agents and old sessions are pruned.

- **Idle shutdown.** When all of these hold for the idle window, the daemon ends the agent
  (SIGTERM to its process group, SIGKILL after 3 s) and keeps the log: no client attached, no
  outstanding permission or elicitation request, no `session/prompt` turn in flight, and no
  agent output. Default 12 h; `TETHER_ACP_IDLE` takes a Go duration (`30m`), `0` disables.
- **Log cap.** If `out.log` passes `TETHER_ACP_LOG_MAX` bytes (default 268435456, 256 MiB; `0`
  disables) the daemon ends the agent. The log is never truncated, so offsets stay valid.
- **Ended sessions** stay replayable (`attach` drains the log, `ls` shows `ended`). `meta.json`
  records `ended` (unix time) and `endedReason`: `idle`, `log-limit`, `exited` (the agent quit
  on its own) or `killed` (the agent died from a signal that was not the daemon's).
- **Retention.** `acp ls` and `acp attach` remove ended sessions older than
  `TETHER_ACP_KEEP_ENDED` (default `14d`; a Go duration or whole days like `7d`; `0`
  disables), never one whose daemon is still alive. `ls` columns are unchanged.
- **Spawn failures.** An agent that exits with status 127, or whose `err.log` says `not found`,
  before printing anything is reported on stderr as `agent command not found on this host`,
  naming the missing program when it can be parsed (`node/npx not found: install Node.js on
  this host`). `attach` still exits 0.

### Permission requests while nobody is attached

The daemon reads the agent's stream (it still forwards every byte untouched) and tracks
`session/request_permission` and `elicitation/create` requests, `session_info_update` chat titles and the end of
each `session/prompt` turn. Outstanding requests live in `acp/<name>/pending.json`.

- When a permission request arrives and no client is attached, one encrypted push goes
  out for that request (category `tether.acp.permission`, urgent, body `Allow: <tool>?`).
  A request is never pushed twice, even across a daemon restart or a log replay. The push
  carries `acp` (session name), `requestId` (the JSON-RPC id as JSON text), `options`
  (button labels, at most 4, only when there are 2 or more), and parallel `optionIds` and
  `optionKinds`. Nothing is pushed when a client is attached.
- When a `session/prompt` turn ends and no client is attached, a quiet push
  (`tether.acp.done`, with `stopReason`) goes out.
- A response the attached client sends for a request clears it. Whole lines only are
  written to the agent's stdin, so a daemon-originated line never lands inside a client's
  half-written line (a partial line left by a dropped client is discarded).

    tether acp answer chat1 --request 7 --option allow   # or: --request 7 --cancel
    tether acp answer chat1 --request 0 --option green   # elicitation; also --cancel, --decline
    tether acp answers chat1                             # {"7":"allow"}

`answer` goes through the daemon, which writes the JSON-RPC response (`outcome` `selected`
with the `optionId`, or `cancelled`) to the agent and records it in `answers.json`.
`--request` is the id as JSON text (`7`, `"abc"`; a value that is not valid JSON is taken
as a string id). Exit 3 means the request is not outstanding (answered from elsewhere, or
the agent moved on); `answers` prints the recorded answers (`{}` when none) so a
reconnecting client can merge them into its transcript.

### Elicitation (the agent's multiple-choice questions)

When the client advertises `elicitation: {form: {}}` the agent asks questions with an
agent-to-client request `elicitation/create` (a form: `message` and `requestedSchema`). It is
tracked like a permission request: kept in `pending.json` with the message and, when the form's
first property is a single-select string with `oneOf`, its choices (`const` values); cleared by
the client's response or the end of the turn. With nobody attached, one push goes out per
request with the same category (`tether.acp.permission`), urgent level, thread key and collapse
scheme as a permission push, plus `elicitation: true`, `body` the form's message, `requestId`
the raw id, and, only when the form is that one question (an optional `<name>_custom` free-text
companion is ignored) with 2 to 4 choices, `options` (the choice titles), `optionIds` (the
`const` values) and `optionKinds` (`choice` each). Any other form (several questions,
multi-select, more than 4 choices, free text only) is a plain "needs your input" push without
`options` that opens the chat.

`answer` on an outstanding elicitation: `--option VALUE` replies
`{"action":"accept","content":{"<firstProperty>":"VALUE"}}`, `--cancel` replies
`{"action":"cancel"}`, `--decline` replies `{"action":"decline"}`; `answers` records `VALUE`,
`cancelled` or `declined`. An `--option` that is not one of the offered `const`s (including any
`--option` on a form with no choices) is refused: nothing is written, the request stays
outstanding, stderr says so and the exit status is 3. `--decline` is refused for permission
requests.

Devices live in `~/.tether-notify/devices.json`, session state in
`~/.tether-notify/sessions/` (override the directory with `TETHER_NOTIFY_HOME`).
zmx is found at `TETHER_ZMX`, else `~/.local/bin/zmx`, else on `PATH`. Relay URL defaults to the official one; override with
`TETHER_PUSH_RELAY_URL`. `--dry-run` prints the relay requests instead of
sending — used to prove wire-format parity with the server/NSE.

## Version

`tether version` prints `tether <version>` and `protocol <N>`; `tether version --json` prints
`{"name":"tether","version":"<v>","protocol":<N>}`. The version is set by `install.sh`
(`git describe --tags --always --dirty`) and is `dev` for a plain `go build`. `protocol` is a
constant in `version.go`, bumped when a command or wire format the app depends on changes
incompatibly; the app refuses a host whose protocol is lower than it requires.

## Migration

`tether-notify` is now `tether`, with no alias: the app and the host tool must be updated together.

1. Re-run `bash install.sh` on every host. A `tether` binary that is not this tool (the retired v4
   server) is moved to `tether.v4` (or `tether.v4.<unix time>`), never overwritten.
2. Re-run `bash scripts/install-agent-hooks.sh` so agent hooks call `tether` / `tether-hook`; entries
   that point at `tether-notify` / `tether-notify-hook` are replaced in place.
3. `~/.local/bin/tether-notify` and `tether-notify-hook` are no longer used and can be deleted.
4. State stays in `~/.tether-notify` (and `TETHER_NOTIFY_HOME`), so registered phones carry over.
