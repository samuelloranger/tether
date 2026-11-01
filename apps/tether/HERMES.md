# Hermes in Tether

Hermes is a personal agent conversation alongside the coding-agent chats. In the New chat sheet, select **Hermes → Open Hermes**. Tether opens the same conversation on that SSH host. It uses the existing SSH transport, ACP holder, transcript replay, and encrypted APNs notifications. No new HTTP endpoint or Tether server is introduced.

The iPhone composer has **Commands** and **New** actions. Commands are discovered from the running Hermes gateway, including its built-ins, quick commands, plugin commands and interactive skills. Search the command browser or type `/` in the composer. A command has a native action/argument module; `/model` has a model picker plus a model-name field, `/compress` explains context summarization, and `/new` asks before clearing active context. Ordinary text remains ordinary chat. Commands unavailable on this surface receive Hermes's refusal rather than a fabricated result.

`/new` resets active context in the same conversation, retaining Hermes's memory and tools. Earlier messages remain visible in Tether's thread. Cancel keeps the draft and attachments; executing New sends only the command. The generic command modules preserve unrelated drafts too.

## Host setup

Install the updated host tool with the repository's `bash install.sh`, then verify:

```sh
tether hermes --check
```

The default finds a native Hermes interpreter at `~/hermes-agent/.venv/bin/python` or `~/.hermes/hermes-agent/.venv/bin/python`. Otherwise it uses the running `hermes` Docker container as its unprivileged `hermes` user. Configuration overrides, set in the SSH user's login environment (the app's checks run outside a login shell, so they read missing overrides from it):

- `TETHER_HERMES_PYTHON`: absolute path to a native Hermes virtualenv interpreter.
- `TETHER_HERMES_CONTAINER`: another Docker container name. Explicitly setting it selects Docker rather than native discovery.

Keep model/provider credentials in Hermes's existing configuration. Tether receives no API key. Docker uses Hermes's workspace (`TERMINAL_CWD`, else `$HERMES_HOME/workspace`); a native installation uses the holder’s home folder.

Every New chat host check runs `tether hermes --available`, a quick probe that finds the interpreter or the running container without starting Hermes. The full check runs only when the user opens Hermes: the app runs `tether hermes --prepare NAME`, which checks Hermes before starting a holder. Under a host lock it reuses an existing live Hermes holder, or restarts its ended holder. A fresh holder clears the old local replay identity, then replays the upstream conversation. The embedded ACP viewer stores the conversation pointer in `$HERMES_HOME/tether-conversation.json` (mode 600) and protects creation with a file lock. Keep that pointer with Hermes's state backup. An unreadable/corrupt pointer, or one naming a conversation Hermes no longer has (its state was reset or restored from an older backup), fails explicitly rather than silently replacing the conversation, and the error names the file. Delete `$HERMES_HOME/tether-conversation.json` on the host to start a new conversation. Deleting a Tether holder does not delete Hermes's own session records.

Tested against Hermes **0.22.5**. The viewer adapts Hermes's gateway ACP implementation and live `commands.catalog`; changes to those upstream interfaces require verifying this adapter. `--check` fails if the required adapter imports no longer exist. The command catalog refreshes on attach and commands; ordinary messages do not depend on plugin discovery. A failed post-command refresh does not misreport a successfully completed command as failed.

## Notifications

When Tether is detached/backgrounded, the existing ACP holder pushes reply completion and approval requests through Tether's encrypted APNs relay. Notification actions use the existing SSH answer path. Permissions, notification registration, and relay setup are unchanged. Production APNs delivery requires a distribution/TestFlight build; simulator screenshots and development installs cannot prove delivery to the phone.

This integration does not import transcripts from other Hermes front ends. Messages Hermes starts on its own, such as scheduled jobs, keep following Hermes's own delivery configuration; Tether does not relay them. The desktop client can select Hermes and use its dynamic slash commands; the guided command modules are currently in the Apple client.

## Validation

- `go test ./...` and `go vet ./...` in `apps/tether`. The embedded adapter also has ten isolated async Python regressions in `hermes_adapter_test.py`; run them with Hermes’s virtualenv (`python -m unittest hermes_adapter_test`) after making both Python files available on that interpreter’s import path.
- `macbuild sync`, `macbuild build`, and `macbuild test` from this checkout. `ChatHermesTests` covers command routing, profile checks and persistent conversation selection.
- `cargo test -p tether-core --lib`, `cargo test -p tether-app`, and `cargo clippy --workspace --all-targets -- -D warnings` in `clients/desktop`.
- DEBUG screenshot fixtures: `TETHER_DEBUG_CHAT_FIXTURE=hermes`, `hermes-commands`, `hermes-model`, `hermes-new`.
- Live ACP verification: initialize, resume/create, live command catalog, ordinary prompt, `/version`, `/new`, and model config options against the running Docker Hermes gateway. Use a separate conversation pointer for QA so the owner's conversation is preserved.
