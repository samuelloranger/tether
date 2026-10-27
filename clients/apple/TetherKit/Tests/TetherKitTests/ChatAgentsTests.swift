import XCTest
@testable import TetherKit

final class ChatAgentsTests: XCTestCase {
  private func choices(_ pairs: [(String, String)]) -> [ACPConfigChoice] {
    pairs.map { ACPConfigChoice(value: $0.0, name: $0.1, description: "") }
  }

  private func option(_ id: String, _ name: String, current: String, _ pairs: [(String, String)]) -> ACPConfigOption {
    ACPConfigOption(id: id, name: name, description: "", category: nil, currentValue: current, choices: choices(pairs))
  }

  private var codexCache: [ACPConfigOption] {
    [
      option("model", "Model", current: "sol", [("sol", "gpt-6-sol"), ("mini", "gpt-6-mini")]),
      option("reasoning_effort", "Reasoning effort", current: "medium", [("medium", "Medium"), ("high", "High")]),
      option("mode", "Mode", current: "agent", [("agent", "Agent"), ("read-only", "Read only")]),
      option("fast-mode", "Fast mode", current: "off", [("off", "Off"), ("on", "On")]),
    ]
  }

  func test_profiles_match_a_spawn_command_exactly_then_by_marker() {
    XCTAssertEqual(ChatAgents.profile(forSpawn: ChatAgents.claude.spawn)?.key, "claude")
    XCTAssertEqual(ChatAgents.profile(forSpawn: "npx -y @agentclientprotocol/codex-acp@2.3.0")?.key, "codex")
    XCTAssertEqual(ChatAgents.profile(forSpawn: "npx -y @agentclientprotocol/codex-acp@9.9.9")?.key, "codex")
    XCTAssertEqual(ChatAgents.profile(forSpawn: "/usr/local/bin/opencode acp --cwd x")?.key, "opencode")
    XCTAssertEqual(ChatAgents.profile(forSpawn: "npx -y @agentclientprotocol/claude-agent-acp@0.1.0")?.key, "claude")
    XCTAssertEqual(ChatAgents.profile(forSpawn: "Codex")?.key, "codex")
    XCTAssertNil(ChatAgents.profile(forSpawn: "gemini --acp"))
    XCTAssertNil(ChatAgents.profile(forSpawn: ""))
    XCTAssertEqual(ChatAgents.codex.spawn, "npx -y @agentclientprotocol/codex-acp@2.3.0")
    XCTAssertEqual(ChatAgents.opencode.spawn, "opencode acp")
  }

  func test_a_chat_resolves_to_the_local_record_then_the_host_spawn_then_claude() {
    XCTAssertEqual(ChatAgents.resolve(localKey: "codex", statusSpawn: ChatAgents.opencode.spawn)?.key, "codex")
    XCTAssertEqual(ChatAgents.resolve(localKey: nil, statusSpawn: ChatAgents.opencode.spawn)?.key, "opencode")
    XCTAssertEqual(ChatAgents.resolve(localKey: nil, statusSpawn: nil)?.key, "claude")
    XCTAssertEqual(ChatAgents.resolve(localKey: nil, statusSpawn: "")?.key, "claude")
    XCTAssertEqual(ChatAgents.resolve(localKey: "gone", statusSpawn: ChatAgents.codex.spawn)?.key, "codex")
    XCTAssertNil(ChatAgents.resolve(localKey: nil, statusSpawn: "gemini --acp"))
    XCTAssertEqual(ChatAgents.label(of: nil), "Agent")
  }

  func test_status_lines_carry_the_spawn_and_drawer_rows_name_only_other_agents() {
    let output = [
      #"{"name":"a","state":"running","turn":"idle","cwd":"/x","created":3,"spawn":"opencode acp"}"#,
      #"{"name":"b","state":"running","turn":"idle","cwd":"/y","created":2}"#,
      #"{"name":"c","state":"running","turn":"idle","cwd":"/z","created":1,"spawn":"gemini --acp"}"#,
    ].joined(separator: "\n")
    let chats = ACPChatStatusListing.parse(output).chats
    XCTAssertEqual(chats.map(\.spawn), ["opencode acp", "", "gemini --acp"])
    let rows = DrawerChatRows.rows(chats: chats, titles: [:], agents: ["b": "codex"])
    XCTAssertEqual(rows.map(\.agentKey), ["opencode", "codex", nil])
    XCTAssertEqual(rows.map(\.agentLabel), ["opencode", "Codex", "Agent"])
    XCTAssertNil(DrawerChatRows.rows(chats: [chats[1]], titles: [:])[0].agentLabel, "no record and no spawn is Claude")
  }

  func test_the_local_record_is_kept_per_host_and_cleared_with_the_chat() {
    let defaults = UserDefaults(suiteName: "agents-\(UUID().uuidString)")!
    let one = ChatTitleStore(scope: "h1:22", defaults: defaults)
    let two = ChatTitleStore(scope: "h2:22", defaults: defaults)
    one.setAgent("codex", for: "chat-a")
    XCTAssertEqual(one.agent(for: "chat-a"), "codex")
    XCTAssertNil(two.agent(for: "chat-a"))
    XCTAssertEqual(one.agents(for: ["chat-a", "chat-b"]), ["chat-a": "codex"])
    one.clear("chat-a")
    XCTAssertNil(one.agent(for: "chat-a"))
  }

  func test_each_agent_remembers_its_own_option_ids() {
    XCTAssertEqual(ChatAgents.claude.rememberedIds, ["model", "effort", "mode"])
    XCTAssertEqual(ChatAgents.codex.rememberedIds, ["model", "reasoning_effort", "mode"])
    XCTAssertEqual(ChatAgents.opencode.rememberedIds, ["model", "effort", "mode"])
    let suite = UserDefaults(suiteName: "agents-\(UUID().uuidString)")!
    let store = ChatOptionDefaultsStore(defaults: suite)
    store.remember(agent: "codex", id: "reasoning_effort", value: "high")
    store.remember(agent: "codex", id: "effort", value: "high")
    store.remember(agent: "codex", id: "fast-mode", value: "on")
    store.remember(agent: "claude", id: "reasoning_effort", value: "high")
    store.remember(agent: "unknown", id: "model", value: "x")
    XCTAssertEqual(store.stored(agent: "codex"), ["reasoning_effort": "high"])
    XCTAssertTrue(store.stored(agent: "claude").isEmpty)
    XCTAssertTrue(store.stored(agent: "unknown").isEmpty)
  }

  func test_the_defaults_plan_follows_the_agents_remembered_ids() {
    let offered = codexCache
    let stored = ["reasoning_effort": "high", "effort": "high"]
    let call = ChatOptionDefaults.next(
      stored: stored, offered: offered, skipping: [], remembered: ChatAgents.codex.rememberedIds)
    XCTAssertEqual(call?.id, "reasoning_effort")
    XCTAssertNil(ChatOptionDefaults.next(
      stored: ["reasoning_effort": "high"], offered: offered, skipping: [], remembered: ChatAgents.claude.rememberedIds))
  }

  func test_the_sessions_command_names_the_agent_only_when_it_is_not_claude() {
    XCTAssertEqual(
      ACPHostCommand.sessions(cwd: "/p", limit: 20, agent: ChatAgents.claude), ACPHostCommand.sessions(cwd: "/p", limit: 20))
    XCTAssertFalse(ACPHostCommand.sessions(cwd: "/p", limit: 20).contains("--agent-cmd"))
    let codex = ACPHostCommand.sessions(cwd: "/p", limit: 20, agent: ChatAgents.codex)
    XCTAssertTrue(codex.contains(" --limit 20 --agent-cmd 'npx -y @agentclientprotocol/codex-acp@2.3.0'"))
    XCTAssertTrue(codex.hasSuffix("2>&1"))
    XCTAssertTrue(ACPHostCommand.sessions(cwd: "/p", limit: 5, agent: ChatAgents.opencode).contains("--agent-cmd 'opencode acp'"))
  }

  func test_the_sign_in_text_names_each_agents_login() {
    XCTAssertEqual(
      ChatSignInCopy.message(host: "h"), "Claude isn't signed in on h. Open a terminal there and run claude to sign in.")
    XCTAssertEqual(
      ChatSignInCopy.message(host: "h", agent: ChatAgents.codex),
      "Codex isn't signed in on h. Open a terminal there and run codex login to sign in.")
    XCTAssertEqual(
      ChatSignInCopy.message(host: "h", agent: ChatAgents.opencode),
      "opencode isn't signed in on h. Open a terminal there and run opencode auth login to sign in.")
    XCTAssertTrue(ChatSignInCopy.message(host: "h", agent: nil).hasPrefix("The agent isn't signed in on h."))
  }

  func test_only_claude_uses_claudes_spinner_words() {
    XCTAssertTrue(ChatAgents.claude.usesClaudeVerbs)
    XCTAssertFalse(ChatAgents.codex.usesClaudeVerbs)
    XCTAssertFalse(ChatAgents.opencode.usesClaudeVerbs)
  }

  func test_the_options_summary_prefills_stored_then_cached_current_then_nothing() {
    let rows = ChatNewOptions.rows(agent: ChatAgents.codex, stored: ["reasoning_effort": "high", "mode": "gone"], cached: codexCache)
    XCTAssertEqual(rows.map(\.id), ["model", "reasoning_effort", "mode"], "fast-mode is not remembered")
    XCTAssertEqual(rows.map(\.selected), ["sol", "high", "agent"])
    XCTAssertEqual(ChatNewOptions.summary(rows: rows, agent: ChatAgents.codex, reset: false), "gpt-6-sol · High · Agent")
    XCTAssertEqual(ChatNewOptions.summary(rows: rows, agent: ChatAgents.codex, reset: true), "Codex's defaults")
    let none = ChatNewOptions.rows(agent: ChatAgents.opencode, stored: [:], cached: [])
    XCTAssertTrue(none.isEmpty)
    XCTAssertEqual(ChatNewOptions.summary(rows: none, agent: ChatAgents.opencode, reset: false), "opencode's defaults")
    XCTAssertEqual(
      ChatNewOptions.note(agent: ChatAgents.opencode),
      "The choices appear after your first opencode chat on this host. Until then it starts on opencode's own defaults.")
  }

  func test_a_change_marks_its_row_and_picks_layer_over_stored_values() {
    let stored = ["model": "mini"]
    let changed = ChatNewOptions.rows(
      agent: ChatAgents.codex, stored: stored, cached: codexCache, changes: ["reasoning_effort": "high"])
    XCTAssertEqual(changed.map(\.changed), [false, true, false])
    XCTAssertEqual(changed[0].selected, "mini")
    XCTAssertNil(ChatNewOptions.picks(stored: stored, changes: [:], reset: false))
    XCTAssertEqual(
      ChatNewOptions.picks(stored: stored, changes: ["reasoning_effort": "high"], reset: false),
      ["model": "mini", "reasoning_effort": "high"])
    XCTAssertEqual(ChatNewOptions.picks(stored: stored, changes: [:], reset: true), [:])
    XCTAssertEqual(ChatNewOptions.picks(stored: stored, changes: ["mode": "read-only"], reset: true), ["mode": "read-only"])
    let reset = ChatNewOptions.rows(agent: ChatAgents.codex, stored: stored, cached: codexCache, reset: true)
    XCTAssertEqual(reset[0].selected, "sol", "a reset shows the agent's own values")
  }

  func test_the_options_cache_keeps_the_remembered_options_per_agent_and_host() {
    let defaults = UserDefaults(suiteName: "agents-\(UUID().uuidString)")!
    let cache = ChatOptionsCache(scope: "h1:22", defaults: defaults)
    cache.save(codexCache, agent: ChatAgents.codex)
    XCTAssertEqual(cache.options(agent: "codex").map(\.id), ["model", "reasoning_effort", "mode"])
    XCTAssertTrue(cache.options(agent: "claude").isEmpty)
    XCTAssertTrue(ChatOptionsCache(scope: "h2:22", defaults: defaults).options(agent: "codex").isEmpty)
    cache.save([], agent: ChatAgents.codex)
    XCTAssertEqual(cache.options(agent: "codex").count, 3, "an empty list never wipes the cache")
  }

  func test_the_last_picked_agent_defaults_to_claude() {
    let store = ChatLastAgentStore(defaults: UserDefaults(suiteName: "agents-\(UUID().uuidString)")!)
    XCTAssertEqual(store.agent.key, "claude")
    store.set(ChatAgents.opencode)
    XCTAssertEqual(store.agent.key, "opencode")
  }

  func test_a_codex_header_line_adds_mode_and_effort_after_the_model() {
    var state = ChatState()
    state.configOptions = codexCache
    let codex = ChatStatusLine(state: state, agent: ChatAgents.codex)
    XCTAssertEqual(codex.model, "gpt-6-sol")
    XCTAssertEqual(codex.extras, ["Medium"])
    XCTAssertEqual(codex.mode, "Agent")
    XCTAssertTrue(ChatStatusLine(state: state).extras.isEmpty, "Claude keeps today's header")
  }

  func test_a_fresh_route_carries_the_agent_and_picks() async {
    let route = await ChatRoute.start(cwdText: "/srv/x", host: "h", agent: ChatAgents.opencode, picks: ["mode": "plan"]) { command in
      command.contains("tether=found") || command.contains("command -v tether") ? "tether=found\nversion={\"name\":\"tether\",\"protocol\":2}\nnode=missing" : ""
    }
    guard case let .ready(ready) = route else { return XCTFail("opencode does not need node: \(route)") }
    XCTAssertEqual(ready.agentKey, "opencode")
    XCTAssertEqual(ready.optionPicks, ["mode": "plan"])
  }

  func test_only_a_chat_this_device_starts_records_its_agent() async {
    let joined = ChatRoute(name: "chat-a", cwd: "/x", readOnly: false, join: true)
    XCTAssertNil(joined.agentToRecord, "an existing or joined chat leaves the agent to the host")
    XCTAssertEqual(ChatAgents.resolve(localKey: nil, statusSpawn: ChatAgents.codex.spawn)?.key, "codex")
    let started = await ChatRoute.start(cwdText: "/srv/x", host: "h", agent: ChatAgents.codex) { command in
      command.contains("command -v tether") ? "tether=found\nversion={\"name\":\"tether\",\"protocol\":2}\nnode=found" : ""
    }
    guard case let .ready(ready) = started else { return XCTFail("\(started)") }
    XCTAssertEqual(ready.agentToRecord?.key, "codex")
  }

  func test_a_changed_pick_the_agent_already_has_is_still_the_users_choice() {
    let offered = [option("effort", "Effort", current: "medium", [("medium", "Medium"), ("high", "High")])]
    let picks = ["effort": "medium"]
    XCTAssertEqual(ChatOptionDefaults.alreadySet(picks: picks, changed: ["effort"], offered: offered), ["effort"])
    XCTAssertTrue(ChatOptionDefaults.alreadySet(picks: picks, changed: [], offered: offered).isEmpty)
    XCTAssertTrue(ChatOptionDefaults.alreadySet(picks: ["effort": "high"], changed: ["effort"], offered: offered).isEmpty)
  }
}
