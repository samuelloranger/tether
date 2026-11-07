package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Variables so tests can shrink them.
var (
	// openCodeCancelGrace is how long OpenCode gets to answer the active prompt after a
	// session/cancel before the holder resolves that prompt itself and moves on.
	openCodeCancelGrace = 15 * time.Second
	// openCodeQueueWarnAfter is how long a prompt may wait in the queue before the holder logs it.
	openCodeQueueWarnAfter = 5 * time.Minute
)

type acpQueuedPrompt struct {
	key  string
	line []byte
	seq  uint64
}

// isOpenCodeSpawn reports whether spawn launches `opencode acp`, directly, through the
// `opencode-ai` package (npx, bunx, with an optional @version) or inside a quoted `sh -c`.
func isOpenCodeSpawn(spawn string) bool {
	fields := strings.Fields(spawn)
	for i, f := range fields {
		fields[i] = strings.Trim(f, `"'`)
	}
	return slices.Contains(fields, "acp") && slices.ContainsFunc(fields, func(f string) bool {
		name := strings.TrimSuffix(filepath.Base(f), ".exe")
		name, _, _ = strings.Cut(name, "@")
		return name == "opencode" || name == "opencode-ai"
	})
}

// cancelledResponseLocked tells trackers, replay and clients that a prompt the agent never
// answered has ended.
func (s *acpDaemonState) cancelledResponseLocked(key string) {
	response, _ := json.Marshal(struct {
		JSONRPC string            `json:"jsonrpc"`
		ID      json.RawMessage   `json:"id"`
		Result  map[string]string `json:"result"`
	}{"2.0", json.RawMessage(key), map[string]string{"stopReason": "cancelled"}})
	s.tr.agentLine(response)
	s.appendLogLocked(append(response, '\n'))
}

func (s *acpDaemonState) logf(format string, args ...any) {
	if s.errf != nil {
		fmt.Fprintf(s.errf, "tether: acp "+format+"\n", args...)
	}
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
			s.promptSeq++
			p := acpQueuedPrompt{key, bytes.Clone(line), s.promptSeq}
			s.queuedPrompts = append(s.queuedPrompts, p)
			time.AfterFunc(openCodeQueueWarnAfter, func() { s.warnStillQueued(p.seq, p.key) })
			return true
		}
		s.activePrompt = key
	case "session/cancel":
		for _, prompt := range s.queuedPrompts {
			s.cancelledResponseLocked(prompt.key)
		}
		s.queuedPrompts = nil
		if s.activePrompt != "" && s.cancelTimer == nil {
			active := s.activePrompt
			s.cancelTimer = time.AfterFunc(openCodeCancelGrace, func() { s.releaseStuckPrompt(active) })
		}
	}
	return false
}

func (s *acpDaemonState) warnStillQueued(seq uint64, key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if slices.ContainsFunc(s.queuedPrompts, func(p acpQueuedPrompt) bool { return p.seq == seq }) {
		s.logf("prompt %s has waited in the OpenCode queue for over %s", key, openCodeQueueWarnAfter)
	}
}

// releaseStuckPrompt fires when OpenCode has not answered the active prompt within the grace
// period after a cancel. The prompt is resolved as cancelled and the queue moves on; a real
// response that arrives later no longer matches activePrompt, so it never releases twice.
func (s *acpDaemonState) releaseStuckPrompt(key string) {
	s.mu.Lock()
	if s.activePrompt != key {
		s.mu.Unlock()
		return
	}
	s.cancelTimer = nil
	s.logf("OpenCode did not answer prompt %s within %s of a cancel; releasing it", key, openCodeCancelGrace)
	s.cancelledResponseLocked(key)
	s.activePrompt = ""
	s.startNextQueuedLocked()
	s.mu.Unlock()
	s.syncStream()
}

func (s *acpDaemonState) startNextQueuedLocked() bool {
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
	if s.cancelTimer != nil {
		s.cancelTimer.Stop()
		s.cancelTimer = nil
	}
	return s.startNextQueuedLocked()
}
