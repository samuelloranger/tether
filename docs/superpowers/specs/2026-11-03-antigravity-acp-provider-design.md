# Antigravity ACP Chat Provider Design

## 1. Overview

Tether supports native persistent terminal sessions alongside Agent Client Protocol (ACP) chats across iOS, Mac Catalyst, Windows, and Linux. The ACP architecture currently supports Claude, Codex, OpenCode, Copilot, and Hermes.

This specification details the addition of **Google Antigravity** as a first-class ACP chat provider in Tether, along with upgrading the New Chat agent selector into a scalable **custom select dropdown** across desktop and Apple clients to comfortably accommodate the expanding roster of coding agents.

## 2. Architecture & Host Execution

### 2.1 Spawn Mechanism
Antigravity executes via the npm wrapper `@simonepri/refined-antigravity-acp` pinned at version `1.6.3`:
```sh
npx -y @simonepri/refined-antigravity-acp@1.6.3 --yes
```

**Why this wrapper?**
- Operates over stdio JSON-RPC adhering to the Agent Client Protocol specification.
- Supervises Google's official `agy_acp_server.par` backend.
- Automatically handles binary downloading and caching in `~/.local/share/antigravity-acp/`.
- Resolves sibling harness dependencies (`localharness_external`).
- Hardens against upstream Linux crashes (e.g. user switching check failures and loopback address resolution).
- Runs through Node/npx, fitting directly into Tether's existing `needs_node: true` agent model alongside Claude and Codex.

### 2.2 Profile Constants
- **Key**: `"antigravity"`
- **Label**: `"Antigravity"`
- **Spawn Command**: `"npx -y @simonepri/refined-antigravity-acp@1.6.3 --yes"`
- **Markers**: `"refined-antigravity-acp"`, `"antigravity-acp"`, `"agy_acp_server"`
- **Remembered Config Options**: `["model", "effort", "mode"]`
- **Sign-in Command**: `"agy"`
- **Needs Node**: `true`
- **Tints Icon**: `true` (monochrome vector mark rendered in theme foreground text colour)

### 2.3 Host Checks & Auth Status
- **Host Check**:
  Antigravity declares `needs_node = true`. The existing `node=ok` / `node=missing` probe in Tether's host check script identifies whether Node/npx is available. If Node is missing, Antigravity is disabled/dimmed in the picker with the message: *"Node.js isn't installed on <host>"*.
- **Authentication**:
  If the agent exits or returns an authentication required error (`-32000`), the client renders the sign-in banner with the instruction:
  *"Antigravity isn't signed in on <host>; run agy in a terminal on <host> to sign in."*

## 3. UI & Custom Select Component

With 6 agents (`Claude`, `Codex`, `OpenCode`, `Copilot`, `Antigravity`, `Hermes`), rendering all choices in a single horizontal segmented row causes severe cramping on desktop dialogs and mobile screens.

### 3.1 Desktop Client (Rust / Slint)
- **Component**: Create a dedicated `NcAgentSelect` in `clients/desktop/crates/tether-app/ui/chat.slint`.
- **Closed State (Trigger)**:
  - Height: `38px`, background `Tokens.input`, border radius `Tokens.radius-control`.
  - Left icon: `AgentMark { agent: current_index; size: 16px; }`.
  - Label: Primary text showing the active agent's name.
  - Right: Trailing chevron (`chevron.svg` rotated 90°).
  - Hover and focus transitions matching `TextInput`.
- **Open State (Dropdown Menu)**:
  - Uses `PopupWindow` (anchored below trigger, width matching or exceeding trigger).
  - Lists all agents in order:
    1. Claude (index 0)
    2. Codex (index 1)
    3. OpenCode (index 2)
    4. Copilot (index 3)
    5. Antigravity (index 4)
    6. Hermes (index 5)
  - Each item renders the agent's mark, display label, and dimmed opacity if unavailable on the current host.
  - Clicking an available agent fires `ChatVm.nc-agent-picked(index)` and closes the popup.
  - Keyboard navigation (Up/Down arrow, Enter, Escape).
- **Hermes Special Handling**:
  - Update Hermes checks in `chat.slint` from index `4` to index `5` (single conversation info banner, "Open Hermes" primary action).

### 3.2 Apple Client (SwiftUI / TetherKit)
- In `EmbeddedChat.swift`:
  - Replace the horizontal `HStack` segmented buttons with a clean `Menu` button matching the `optionRow` dropdown style.
  - Trigger displays the active agent's icon (`ChatAgentMark`), name, and `chevron.up.chevron.down`.
  - Menu options list all agents with their icons, with unavailable agents disabled.
  - Hermes remains accessible both via the menu and the prominent card button below.

## 4. Vector Icon Assets

- **Asset**: Single-colour monochrome SVG icon representing Google Antigravity.
- **Locations**:
  - `clients/desktop/crates/tether-app/ui/icons/agent-antigravity.svg`
  - `clients/apple/TetherKit/Sources/TetherKit/Resources/Agents.xcassets/agent-antigravity.imageset/`
    - `Contents.json`
    - `agent-antigravity.svg`
- **Attribution**: Update `AgentIcons-SOURCE.txt` and `agent-icons-source.txt`.

## 5. File Modifications

1. **`clients/desktop/crates/tether-core/src/acp/agent.rs`**:
   - Define `pub const ANTIGRAVITY: AgentProfile`.
   - Update `pub const ALL: [&AgentProfile; 6]`.
   - Update `for_spawn` to recognise `"refined-antigravity-acp"`, `"antigravity-acp"`, and `"agy_acp_server"`.
   - Add unit tests for key, spawn, marker, sign-in message, and host problem filtering.

2. **`clients/apple/TetherKit/Sources/TetherKit/Chat/ChatAgents.swift`**:
   - Define `static let antigravity: ChatAgentProfile`.
   - Add `antigravity` to `static let all`.
   - Update `profile(forSpawn:)` matching.

3. **`clients/desktop/crates/tether-app/ui/chat.slint`**:
   - Add `agent == 4` in `AgentMark` for `agent-antigravity.svg`.
   - Move Hermes in `AgentMark` to `agent == 5`.
   - Update Hermes checks from `== 4` to `== 5`.
   - Implement `NcAgentSelect` replacing the static horizontal segmented loop.

4. **`clients/desktop/crates/tether-app/src/terminal/model/chat/`**:
   - Update dev sample chats, screen models, and tests reflecting the new agent and index mapping.

5. **`clients/apple/TetherKit/Sources/TetherKit/Chat/EmbeddedChat.swift`**:
   - Update `agentPicker` to use a dropdown selector.

6. **Icon Assets & Attributions**:
   - Add `agent-antigravity.svg` to desktop and Apple asset folders.
   - Update attribution text files.

## 6. Testing & Quality Verification

- **Rust Suite**:
  - `cargo fmt --all --check`
  - `cargo clippy --workspace --all-targets -- -D warnings`
  - `cargo test --workspace`
  - Ensure all `tether-core` and `tether-app` tests pass cleanly.
- **Swift Suite**:
  - Colocated unit tests in `ChatAgentsTests.swift`.
  - Validate profile resolution, sign-in messages, and Node requirement filtering.
