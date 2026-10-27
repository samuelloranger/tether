package main

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// GitHub Copilot holds session/prompt open while a shell it started in async mode runs, which a dev
// server never stops doing, and it starts turns of its own when such a shell ends. Its
// assistant.idle event, sent only to a client that asks for it in initialize, is the one sign that
// an answer is over.
const (
	copilotMetaKey      = "github.com/copilot"
	copilotSessionEvent = "github.com/copilot/sessionEvent"
)

// copilotIdleGrace is how long a prompt may stay open after assistant.idle: a finished turn's
// prompt returns within milliseconds, so one still open is held for a shell.
var copilotIdleGrace = 5 * time.Second

func isCopilotSpawn(spawn string) bool {
	fields := strings.Fields(spawn)
	if !slices.Contains(fields, "--acp") {
		return false
	}
	return slices.ContainsFunc(fields, func(f string) bool {
		return strings.TrimSuffix(filepath.Base(f), ".exe") == "copilot" || strings.HasPrefix(f, "@github/copilot")
	})
}

// withCopilotEvents adds assistant.idle to the events an initialize request asks Copilot for and
// returns any other line as it is.
func withCopilotEvents(line []byte) []byte {
	trimmed := bytes.TrimSpace(line)
	var msg map[string]json.RawMessage
	if json.Unmarshal(trimmed, &msg) != nil {
		return line
	}
	var method string
	if json.Unmarshal(msg["method"], &method) != nil || method != "initialize" {
		return line
	}
	params := objectOf(msg["params"])
	caps := objectOf(params["clientCapabilities"])
	meta := objectOf(caps["_meta"])
	copilot := objectOf(meta[copilotMetaKey])
	var events []string
	_ = json.Unmarshal(copilot["events"], &events)
	if slices.Contains(events, "assistant.idle") {
		return line
	}
	events = append(events, "assistant.idle")
	if !setJSON(copilot, "events", events) || !setJSON(meta, copilotMetaKey, copilot) ||
		!setJSON(caps, "_meta", meta) || !setJSON(params, "clientCapabilities", caps) ||
		!setJSON(msg, "params", params) {
		return line
	}
	out, err := json.Marshal(msg)
	if err != nil {
		return line
	}
	return append(out, '\n')
}

func objectOf(raw json.RawMessage) map[string]json.RawMessage {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil || m == nil {
		return map[string]json.RawMessage{}
	}
	return m
}

func setJSON[T any](m map[string]json.RawMessage, key string, v T) bool {
	raw, err := json.Marshal(v)
	if err != nil {
		return false
	}
	m[key] = raw
	return true
}

// copilotIdle is the main agent's assistant.idle: the session and the prompts in flight when it came.
type copilotIdle struct {
	session string
	prompts []string
}

// sessionEventLocked reads a Copilot session event. A subagent's idle or an aborted turn's is no end.
func (t *acpTracker) sessionEventLocked(params json.RawMessage) acpEvent {
	var p struct {
		SessionID string `json:"sessionId"`
		Type      string `json:"type"`
		AgentID   string `json:"agentId"`
		Data      struct {
			Aborted bool `json:"aborted"`
		} `json:"data"`
	}
	if json.Unmarshal(params, &p) != nil || p.Type != "assistant.idle" || p.AgentID != "" || p.Data.Aborted {
		return acpEvent{}
	}
	switch {
	case len(t.st.Prompts) > 0:
		return acpEvent{idle: &copilotIdle{session: p.SessionID, prompts: slices.Clone(t.st.Prompts)}}
	case len(t.st.Loads) == 0 && t.st.Autonomous:
		t.st.Autonomous = false
		t.saveLocked()
		return acpEvent{turnEnded: true, stopReason: "end_turn"}
	}
	return acpEvent{}
}

// takePrompt ends a prompt the agent has not answered, as its answer would.
func (t *acpTracker) takePrompt(key string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	i := slices.Index(t.st.Prompts, key)
	if i < 0 {
		return false
	}
	t.st.Prompts = slices.Delete(t.st.Prompts, i, i+1)
	t.st.Requests = map[string]*acpRequest{}
	t.saveLocked()
	return true
}

func (s *acpDaemonState) settleAfterIdle(idle *copilotIdle) {
	s.pushes.Add(1)
	go func() {
		defer s.pushes.Done()
		time.Sleep(copilotIdleGrace)
		for _, key := range idle.prompts {
			if s.settleHeldPrompt(idle.session, key) {
				s.syncStream()
				s.whenDetached(func() bool { return true }, func() {
					s.pushAsync(s.donePush("end_turn"), "acp-done-"+threadKey(hostLabel(), s.tr.name))
				})
			}
		}
	}()
}

// settleHeldPrompt answers a prompt the agent still holds with end_turn in the log, so every client
// sees the turn end, then cancels it on the agent, which leaves the shells running. The agent's own
// answer to it, "cancelled", is dropped.
func (s *acpDaemonState) settleHeldPrompt(session, key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ended || !s.tr.takePrompt(key) {
		return false
	}
	answer, err := json.Marshal(struct {
		JSONRPC string            `json:"jsonrpc"`
		ID      json.RawMessage   `json:"id"`
		Result  map[string]string `json:"result"`
	}{"2.0", json.RawMessage(key), map[string]string{"stopReason": "end_turn"}})
	if err != nil {
		return false
	}
	if s.dropAnswers == nil {
		s.dropAnswers = map[string]bool{}
	}
	s.dropAnswers[key] = true
	s.appendLogLocked(append(answer, '\n'))
	cancel, _ := json.Marshal(struct {
		JSONRPC string            `json:"jsonrpc"`
		Method  string            `json:"method"`
		Params  map[string]string `json:"params"`
	}{"2.0", "session/cancel", map[string]string{"sessionId": session}})
	if s.stdin != nil {
		_, _ = s.stdin.Write(append(cancel, '\n'))
	}
	return true
}

// keepAgentLinesLocked drops the agent's answers to prompts the holder already answered.
func (s *acpDaemonState) keepAgentLinesLocked(out []byte) []byte {
	if len(s.dropAnswers) == 0 {
		return out
	}
	var kept []byte
	for len(out) > 0 {
		end := bytes.IndexByte(out, '\n') + 1
		if end == 0 {
			end = len(out)
		}
		line := out[:end]
		out = out[end:]
		if m, key, ok := parseRPC(line); ok && m.Method == "" && s.dropAnswers[key] {
			delete(s.dropAnswers, key)
			continue
		}
		kept = append(kept, line...)
	}
	return kept
}
