package main

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"slices"
	"strings"
)

type acpQueuedPrompt struct {
	key  string
	line []byte
}

func isOpenCodeSpawn(spawn string) bool {
	fields := strings.Fields(spawn)
	return slices.Contains(fields, "acp") && slices.ContainsFunc(fields, func(f string) bool {
		return strings.TrimSuffix(filepath.Base(f), ".exe") == "opencode"
	})
}

// OpenCode rejects concurrent prompts. Keep them in the holder so detaching a client does not
// lose its queue; their existing client echoes still make them visible during replay.
func (s *acpDaemonState) queueOpenCodePromptLocked(line []byte) bool {
	if s.meta == nil || !isOpenCodeSpawn(s.meta.Spawn) {
		return false
	}
	m, key, ok := parseRPC(line)
	if !ok {
		return false
	}
	switch m.Method {
	case "session/prompt":
		if key == "" {
			return false
		}
		if s.activePrompt != "" {
			s.queuedPrompts = append(s.queuedPrompts, acpQueuedPrompt{key, bytes.Clone(line)})
			return true
		}
		s.activePrompt = key
	case "session/cancel":
		for _, prompt := range s.queuedPrompts {
			response, _ := json.Marshal(struct {
				JSONRPC string            `json:"jsonrpc"`
				ID      json.RawMessage   `json:"id"`
				Result  map[string]string `json:"result"`
			}{"2.0", json.RawMessage(prompt.key), map[string]string{"stopReason": "cancelled"}})
			s.tr.agentLine(response)
			s.appendLogLocked(append(response, '\n'))
		}
		s.queuedPrompts = nil
	}
	return false
}

// Called after tracking the response, under the same lock as client writes. A response to an
// unrelated request (including permission/configuration requests) never starts the next prompt.
func (s *acpDaemonState) advanceOpenCodePromptLocked(line []byte) bool {
	if s.activePrompt == "" {
		return false
	}
	m, key, ok := parseRPC(line)
	if !ok || m.Method != "" || key != s.activePrompt || (len(m.Result) == 0 && len(m.Error) == 0) {
		return false
	}
	s.activePrompt = ""
	if len(s.queuedPrompts) == 0 {
		return false
	}
	next := s.queuedPrompts[0]
	s.queuedPrompts[0] = acpQueuedPrompt{}
	s.queuedPrompts = s.queuedPrompts[1:]
	s.activePrompt = next.key
	_, _ = s.stdin.Write(next.line)
	return true
}
