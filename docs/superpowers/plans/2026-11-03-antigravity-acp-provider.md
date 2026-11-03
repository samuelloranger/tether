# Antigravity ACP Chat Provider & Custom Select Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Google Antigravity as a first-class ACP chat provider across Tether's desktop and Apple clients, and replace the New Chat horizontal segmented agent row with a scalable custom select dropdown.

**Architecture:** Antigravity runs via the pinned npm supervisor `@simonepri/refined-antigravity-acp@1.6.3` over stdio JSON-RPC, launching and hardening Google's official `agy_acp_server.par`. Across both clients (`tether-core` in Rust and `TetherKit` in Swift), Antigravity is registered as a peer agent profile with remembered options (`["model", "effort", "mode"]`), requiring Node.js. The New Chat UI on both desktop (Slint) and Apple (SwiftUI) is upgraded to a custom select control to comfortably house 6+ providers.

**Tech Stack:** Rust (Slint, `tether-core`, `tether-app`), Swift / SwiftUI (`TetherKit`), Node.js (`npx`), Agent Client Protocol (ACP), SVG.

## Global Constraints
- Pinned spawn command: `npx -y @simonepri/refined-antigravity-acp@1.6.3 --yes`
- Agent key: `"antigravity"`, Label: `"Antigravity"`
- Sign-in command: `"agy"`
- Needs Node: `true`
- Icon tints: `true` (single-colour monochrome vector path)
- Maintain minimal comments per `CLAUDE.md`.
- No regression of existing Claude, Codex, OpenCode, Copilot, or Hermes behaviours.

---

### Task 1: Vector Icons & Attribution Assets

**Files:**
- Create: `clients/desktop/crates/tether-app/ui/icons/agent-antigravity.svg`
- Create: `clients/apple/TetherKit/Sources/TetherKit/Resources/Agents.xcassets/agent-antigravity.imageset/Contents.json`
- Create: `clients/apple/TetherKit/Sources/TetherKit/Resources/Agents.xcassets/agent-antigravity.imageset/agent-antigravity.svg`
- Modify: `clients/desktop/crates/tether-app/ui/icons/agent-icons-source.txt`
- Modify: `clients/apple/TetherKit/Sources/TetherKit/Resources/AgentIcons-SOURCE.txt`

**Interfaces:**
- Produces: SVG asset `agent-antigravity.svg` (24x24 monochrome path) accessible via `@image-url("icons/agent-antigravity.svg")` in Slint and `"agent-antigravity"` image asset in `TetherKit`.

- [x] **Step 1: Create the desktop SVG vector icon**

Create `clients/desktop/crates/tether-app/ui/icons/agent-antigravity.svg` with a 24x24 monochrome path representing Antigravity (a precision triangle / spark mark):
```xml
<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
  <path fill-rule="evenodd" clip-rule="evenodd" d="M12 2.5L21.5 19H2.5L12 2.5ZM12 6.8L5.7 17.5H18.3L12 6.8ZM12 10.2L15.2 15.8H8.8L12 10.2Z"/>
</svg>
```

- [x] **Step 2: Create the Apple imageset asset**

Create `clients/apple/TetherKit/Sources/TetherKit/Resources/Agents.xcassets/agent-antigravity.imageset/Contents.json`:
```json
{
  "images" : [
    {
      "filename" : "agent-antigravity.svg",
      "idiom" : "universal"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  },
  "properties" : {
    "template-rendering-intent" : "template"
  }
}
```

Copy the SVG file to `clients/apple/TetherKit/Sources/TetherKit/Resources/Agents.xcassets/agent-antigravity.imageset/agent-antigravity.svg`.

- [x] **Step 3: Update attribution documentation**

Update `clients/desktop/crates/tether-app/ui/icons/agent-icons-source.txt` and `clients/apple/TetherKit/Sources/TetherKit/Resources/AgentIcons-SOURCE.txt` to include `agent-antigravity`.

- [x] **Step 4: Commit assets**

```bash
git add clients/desktop/crates/tether-app/ui/icons/agent-antigravity.svg \
        clients/desktop/crates/tether-app/ui/icons/agent-icons-source.txt \
        clients/apple/TetherKit/Sources/TetherKit/Resources/Agents.xcassets/agent-antigravity.imageset/ \
        clients/apple/TetherKit/Sources/TetherKit/Resources/AgentIcons-SOURCE.txt
git commit -m "feat(chat): add Antigravity vector icon assets"
```

---

### Task 2: Core Agent Profile in `tether-core`

**Files:**
- Modify: `clients/desktop/crates/tether-core/src/acp/agent.rs`

**Interfaces:**
- Produces: `pub const ANTIGRAVITY: AgentProfile`
- Updates: `pub const ALL: [&AgentProfile; 6]`
- Updates: `for_spawn(spawn: &str) -> Option<&'static AgentProfile>`

- [x] **Step 1: Write failing unit tests in `acp/agent.rs`**

Add unit tests in `clients/desktop/crates/tether-core/src/acp/agent.rs` (under `mod tests`):
```rust
#[test]
fn antigravity_profile_definition_and_resolution() {
    assert_eq!(by_key("antigravity"), Some(&ANTIGRAVITY));
    assert_eq!(
        for_spawn("npx -y @simonepri/refined-antigravity-acp@1.6.3 --yes"),
        Some(&ANTIGRAVITY)
    );
    assert_eq!(
        for_spawn("npx -y @simonepri/refined-antigravity-acp"),
        Some(&ANTIGRAVITY)
    );
    assert_eq!(for_spawn("antigravity-acp"), Some(&ANTIGRAVITY));
    assert_eq!(for_spawn("/path/to/agy_acp_server.par"), Some(&ANTIGRAVITY));
    assert!(ANTIGRAVITY.needs_node);
    assert_eq!(ANTIGRAVITY.remembered, ["model", "effort", "mode"]);
}

#[test]
fn antigravity_sign_in_message() {
    assert!(sign_in_message(Some(&ANTIGRAVITY), "devbox").contains("run agy to sign in"));
}
```

- [x] **Step 2: Run test to verify it fails**

Run: `cargo test -p tether-core --manifest-path clients/desktop/Cargo.toml -- antigravity`
Expected: FAIL (`ANTIGRAVITY` not found)

- [x] **Step 3: Implement `ANTIGRAVITY` profile in `acp/agent.rs`**

Define `ANTIGRAVITY`:
```rust
pub const ANTIGRAVITY: AgentProfile = AgentProfile {
    key: "antigravity",
    label: "Antigravity",
    spawn: "npx -y @simonepri/refined-antigravity-acp@1.6.3 --yes",
    marker: "refined-antigravity-acp",
    remembered: ["model", "effort", "mode"],
    sign_in_command: "agy",
    needs_node: true,
};
```

Update `ALL`:
```rust
pub const ALL: [&AgentProfile; 6] = [&CLAUDE, &CODEX, &OPENCODE, &COPILOT, &ANTIGRAVITY, &HERMES];
```

Update `for_spawn` to also recognise `"antigravity-acp"` and `"agy_acp_server"` markers:
```rust
pub fn for_spawn(spawn: &str) -> Option<&'static AgentProfile> {
    let spawn = spawn.trim();
    if spawn.contains("antigravity-acp") || spawn.contains("agy_acp_server") {
        return Some(&ANTIGRAVITY);
    }
    ALL.into_iter()
        .find(|p| p.spawn == spawn)
        .or_else(|| ALL.into_iter().find(|p| spawn.contains(p.marker)))
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `cargo test -p tether-core --manifest-path clients/desktop/Cargo.toml`
Expected: PASS (all tests passing)

- [x] **Step 5: Commit**

```bash
git add clients/desktop/crates/tether-core/src/acp/agent.rs
git commit -m "feat(acp): add Antigravity agent profile to tether-core"
```

---

### Task 3: Apple Client Agent Profile in `TetherKit`

**Files:**
- Modify: `clients/apple/TetherKit/Sources/TetherKit/Chat/ChatAgents.swift`
- Modify: `clients/apple/TetherKit/Tests/TetherKitTests/ChatAgentsTests.swift`

**Interfaces:**
- Produces: `static let antigravity: ChatAgentProfile`
- Updates: `ChatAgents.all`

- [x] **Step 1: Write unit tests in `ChatAgentsTests.swift`**

Add tests for Antigravity:
```swift
func testAntigravityProfileAndSpawn() {
    XCTAssertEqual(ChatAgents.profile(forKey: "antigravity"), ChatAgents.antigravity)
    XCTAssertEqual(ChatAgents.profile(forSpawn: "npx -y @simonepri/refined-antigravity-acp@1.6.3 --yes"), ChatAgents.antigravity)
    XCTAssertEqual(ChatAgents.profile(forSpawn: "antigravity-acp"), ChatAgents.antigravity)
    XCTAssertEqual(ChatAgents.profile(forSpawn: "agy_acp_server"), ChatAgents.antigravity)
    XCTAssertTrue(ChatAgents.antigravity.needsNode)
    XCTAssertEqual(ChatAgents.antigravity.rememberedIds, ["model", "effort", "mode"])
    XCTAssertTrue(ChatSignInCopy.message(host: "box", agent: ChatAgents.antigravity).contains("run agy"))
}
```

- [x] **Step 2: Implement Antigravity profile in `ChatAgents.swift`**

In `ChatAgents.swift`:
```swift
static let antigravity = ChatAgentProfile(
    key: "antigravity", label: "Antigravity",
    spawn: "npx -y @simonepri/refined-antigravity-acp@1.6.3 --yes",
    marker: "refined-antigravity-acp",
    rememberedIds: ["model", "effort", "mode"],
    iconAsset: "agent-antigravity",
    tintsIcon: true,
    signInCommand: "agy",
    needsNode: true)
```

Include `antigravity` in `static let all = [claude, codex, opencode, copilot, antigravity, hermes]`.
In `profile(forSpawn:)`:
```swift
if command.contains("antigravity-acp") || command.contains("agy_acp_server") {
    return antigravity
}
```

- [x] **Step 3: Commit**

```bash
git add clients/apple/TetherKit/Sources/TetherKit/Chat/ChatAgents.swift \
        clients/apple/TetherKit/Tests/TetherKitTests/ChatAgentsTests.swift
git commit -m "feat(acp): add Antigravity profile to TetherKit"
```

---

### Task 4: Desktop Custom Select Component & Slint UI

**Files:**
- Modify: `clients/desktop/crates/tether-app/ui/chat.slint`

**Interfaces:**
- Produces: `component NcAgentSelect inherits Rectangle`
- Updates: `AgentMark` with index 4 for Antigravity, 5 for Hermes.
- Updates: Hermes index references in `chat.slint` from 4 to 5.

- [x] **Step 1: Update `AgentMark` in `chat.slint`**

In `clients/desktop/crates/tether-app/ui/chat.slint`:
```slint
if root.agent == 0: Image { width: 100%; height: 100%; image-fit: contain; source: @image-url("icons/agent-claude.svg"); }
if root.agent == 1: Image { width: 100%; height: 100%; image-fit: contain; source: @image-url("icons/agent-codex.svg"); colorize: root.ink; }
if root.agent == 2: Image { width: 100%; height: 100%; image-fit: contain; source: @image-url("icons/agent-opencode.svg"); colorize: root.ink; }
if root.agent == 3: Image { width: 100%; height: 100%; image-fit: contain; source: @image-url("icons/agent-copilot.svg"); colorize: root.ink; }
if root.agent == 4: Image { width: 100%; height: 100%; image-fit: contain; source: @image-url("icons/agent-antigravity.svg"); colorize: root.ink; }
if root.agent == 5: Image { width: 100%; height: 100%; image-fit: contain; source: @image-url("icons/agent-hermes.svg"); colorize: root.ink; }
```

- [x] **Step 2: Update Hermes checks from 4 to 5 in `chat.slint`**

Lines 2588, 2624, 2654, 2655, 2712: replace `!= 4` / `== 4` with `!= 5` / `== 5`.

- [x] **Step 3: Implement `NcAgentSelect` in `chat.slint`**

Replace the rigid `HorizontalLayout` for the agent picker with a dropdown `NcAgentSelect` using `PopupWindow`:
```slint
component NcAgentSelect inherits Rectangle {
    in property <int> current-agent;
    in property <[string]> agent-labels: ["Claude", "Codex", "opencode", "Copilot", "Antigravity", "Hermes"];
    in property <[bool]> unavailable;
    callback picked(int);

    height: 38px;
    background: Tokens.input;
    border-radius: Tokens.radius-control;
    border-width: 1px;
    border-color: trigger-touch.has-hover ? Tokens.accent.with-alpha(0.5) : Tokens.border;
    animate border-color { duration: Motion.fast; easing: ease-out; }

    HorizontalLayout {
        padding-left: 12px;
        padding-right: 12px;
        spacing: 8px;
        alignment: center;
        VerticalLayout {
            alignment: center;
            AgentMark {
                agent: root.current-agent;
                size: 16px;
                ink: Tokens.text;
            }
        }
        Text {
            horizontal-stretch: 1;
            text: root.agent-labels[root.current-agent];
            font-size: 13px;
            font-weight: 600;
            color: Tokens.text;
            vertical-alignment: center;
        }
        VerticalLayout {
            alignment: center;
            Image {
                width: 10px;
                height: 10px;
                source: @image-url("icons/chevron.svg");
                transform-rotation: 90deg;
                colorize: Tokens.text-secondary;
            }
        }
    }

    trigger-touch := TouchArea {
        mouse-cursor: pointer;
        clicked => { popup.show(); }
    }

    popup := PopupWindow {
        x: 0;
        y: root.height + 4px;
        width: root.width;
        height: min(list.preferred-height + 8px, 260px);

        Rectangle {
            background: Tokens.surface;
            border-radius: 9px;
            border-width: 1px;
            border-color: Tokens.border;

            Flickable {
                x: 4px;
                y: 4px;
                width: parent.width - 8px;
                height: parent.height - 8px;
                content-height: list.preferred-height;
                list := VerticalLayout {
                    spacing: 2px;
                    for label[i] in root.agent-labels: Rectangle {
                        height: 34px;
                        border-radius: 7px;
                        background: i == root.current-agent ? Tokens.raised : row-touch.has-hover ? Tokens.surface-hover : transparent;
                        opacity: root.unavailable[i] ? 0.4 : 1.0;
                        animate background { duration: Motion.fast; easing: ease-out; }

                        HorizontalLayout {
                            padding-left: 10px;
                            padding-right: 10px;
                            spacing: 8px;
                            alignment: center;
                            VerticalLayout {
                                alignment: center;
                                AgentMark { agent: i; size: 16px; ink: i == root.current-agent ? Tokens.text : Tokens.text-secondary; }
                            }
                            Text {
                                horizontal-stretch: 1;
                                text: label;
                                font-size: 13px;
                                font-weight: i == root.current-agent ? 650 : 500;
                                color: i == root.current-agent ? Tokens.text : Tokens.text-secondary;
                                vertical-alignment: center;
                            }
                        }

                        row-touch := TouchArea {
                            mouse-cursor: pointer;
                            clicked => {
                                root.picked(i);
                            }
                        }
                    }
                }
            }
        }
    }
}
```

Use `NcAgentSelect` in the dialog:
```slint
NcAgentSelect {
    current-agent: ChatVm.nc-agent;
    unavailable: ChatVm.nc-unavailable;
    picked(i) => { ChatVm.nc-agent-picked(i); }
}
```

- [x] **Step 4: Verify Slint syntax compilation**

Run: `PKG_CONFIG_PATH=/tmp/tether-chat-desktop-build/lib/pkgconfig cargo check -p tether-app --manifest-path clients/desktop/Cargo.toml`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add clients/desktop/crates/tether-app/ui/chat.slint
git commit -m "feat(ui): custom select dropdown for New Chat agent picker"
```

---

### Task 5: Desktop Screen Model & Dev Sample Updates

**Files:**
- Modify: `clients/desktop/crates/tether-app/src/terminal/model/chat/devsample.rs`
- Modify: `clients/desktop/crates/tether-app/src/terminal/model/chat/screen.rs`
- Modify: `clients/desktop/crates/tether-app/src/terminal/model/chat/tests.rs`

**Interfaces:**
- Updates: Devsample fixtures and test assertions to account for Antigravity in `agent::ALL`.

- [x] **Step 1: Check existing devsample fixtures and tests**

Verify if devsample fixtures or tests hardcode agent counts or Hermes index.
Update `tests.rs` where necessary to ensure Hermes conversation tests and agent mappings align.

- [x] **Step 2: Run all desktop app tests**

Run: `PKG_CONFIG_PATH=/tmp/tether-chat-desktop-build/lib/pkgconfig cargo test -p tether-app --manifest-path clients/desktop/Cargo.toml`
Expected: PASS

- [x] **Step 3: Commit**

```bash
git add clients/desktop/crates/tether-app/src/terminal/model/chat/
git commit -m "test(desktop): update chat models and tests for Antigravity"
```

---

### Task 6: Apple Client Custom Agent Menu in `EmbeddedChat.swift`

**Files:**
- Modify: `clients/apple/TetherKit/Sources/TetherKit/Chat/EmbeddedChat.swift`

**Interfaces:**
- Produces: Dropdown `Menu` in `EmbeddedChat.swift` for agent selection.

- [x] **Step 1: Refactor `agentPicker` in `EmbeddedChat.swift`**

Replace the horizontal `HStack` with a custom select `Menu`:
```swift
private var agentPicker: some View {
  VStack(alignment: .leading, spacing: 6) {
    Text("Agent").font(.caption).foregroundStyle(TetherColors.textSecondary)
    Menu {
      ForEach(ChatAgents.all.filter { $0 != ChatAgents.hermes }) { option in
        let missing = unavailable[option.key] != nil
        Button {
          pick(option)
        } label: {
          Label {
            Text(option.label)
          } icon: {
            ChatAgentMark(agent: option, size: 14)
          }
        }
        .disabled(missing)
      }
    } label: {
      HStack(spacing: 8) {
        ChatAgentMark(agent: agent, size: 16)
        Text(agent.label).font(.subheadline.weight(.semibold)).foregroundStyle(TetherColors.textPrimary)
        Spacer()
        Image(systemName: "chevron.up.chevron.down")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(TetherColors.textFaint)
      }
      .padding(.horizontal, 12).frame(height: 38)
      .background(TetherColors.input, in: RoundedRectangle(cornerRadius: 8))
      .overlay(
        RoundedRectangle(cornerRadius: 8)
          .strokeBorder(TetherColors.border, lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("sshNewChatAgentSelect")

    Button { pick(ChatAgents.hermes); mode = .new } label: {
      // Hermes card retained below for quick access
      ...
    }
  }
}
```

- [x] **Step 2: Commit**

```bash
git add clients/apple/TetherKit/Sources/TetherKit/Chat/EmbeddedChat.swift
git commit -m "feat(ios): custom agent select menu for New Chat"
```

---

### Task 7: Full System Verification & Quality Gates

**Files:**
- None (verification only)

- [x] **Step 1: Run Rust linting and formatting**

Run:
```bash
cargo fmt --all --check --manifest-path clients/desktop/Cargo.toml
PKG_CONFIG_PATH=/tmp/tether-chat-desktop-build/lib/pkgconfig cargo clippy --workspace --all-targets --manifest-path clients/desktop/Cargo.toml -- -D warnings
```
Expected: PASS with 0 warnings.

- [x] **Step 2: Run complete Rust test workspace**

Run:
```bash
PKG_CONFIG_PATH=/tmp/tether-chat-desktop-build/lib/pkgconfig cargo test --workspace --manifest-path clients/desktop/Cargo.toml
```
Expected: PASS (all workspace tests passing).

- [x] **Step 3: Verify git status and commit cleanliness**

Ensure working directory is clean and all commits follow conventional commit rules.

---

## Completion

Implemented on 2026-11-03.

- Rust: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` and
  `cargo test --workspace` all pass (488 tether-app, 796 tether-core, plus the remaining crates).
- Desktop: `cargo check -p tether-app` compiles the new `NcAgentSelect`; the two dialog tests now
  expect six agents with Antigravity at index 4.
- Swift: verified on the macbuild Mac (Xcode 27): `macbuild build` succeeded and
  `macbuild test --only TetherKitTests/ChatAgentsTests` passed 19/19, including
  `test_antigravity_profile_and_spawn` and the updated `test_only_the_npx_agents_need_node`.
- Spawn command verified against npm: `@simonepri/refined-antigravity-acp@1.6.3` exists and its CLI
  starts an ACP stdio server; `--yes` is accepted (it applies to `setup`, and is ignored in server mode).

