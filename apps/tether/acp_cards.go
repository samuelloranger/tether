package main

import (
	_ "embed"
	"encoding/json"
	"strings"
)

//go:embed chat_cards.py
var chatCardsSource string

const chatCardInstructions = "You are answering inside Tether, which renders native weather, image and Docker cards. Use the tether-cards MCP tool tether_publish_card whenever these make your answer clearer; do not wait for the user to request a card format. Fetch real data with your existing tools first, or clearly label supplied test observations. The tool only presents data and does not grant data access. Keep surrounding prose concise and useful. Refresh existing card IDs with a higher revision. Card action requests must follow your normal permission policy and target verification."

func supportsChatCards(spawn string) bool {
	return strings.Contains(spawn, "claude-agent-acp") || strings.Contains(spawn, "codex-acp")
}

// The holder owns registration, so old and new native clients get the same tools.
func withChatCards(line []byte, spawn string) []byte {
	var msg map[string]json.RawMessage
	if json.Unmarshal(line, &msg) != nil {
		return line
	}
	var method string
	_ = json.Unmarshal(msg["method"], &method)
	if method != "session/new" && method != "session/load" && method != "session/resume" {
		return line
	}
	var params map[string]any
	if json.Unmarshal(msg["params"], &params) != nil || params == nil {
		return line
	}
	servers, _ := params["mcpServers"].([]any)
	for _, server := range servers {
		if object, ok := server.(map[string]any); ok && object["name"] == "tether-cards" {
			return line
		}
	}
	params["mcpServers"] = append(servers, map[string]any{
		"name": "tether-cards", "command": "python3", "args": []string{"-c", chatCardsSource}, "env": []any{},
	})
	if params["systemPrompt"] == nil {
		params["systemPrompt"] = map[string]any{"mode": "append", "content": []any{map[string]any{"type": "text", "text": chatCardInstructions}}}
	} else if prompt, ok := params["systemPrompt"].(map[string]any); ok && prompt["mode"] == "append" {
		content, _ := prompt["content"].([]any)
		prompt["content"] = append(content, map[string]any{"type": "text", "text": chatCardInstructions})
	}
	msg["params"], _ = json.Marshal(params)
	out, err := json.Marshal(msg)
	if err != nil {
		return line
	}
	return append(out, '\n')
}
