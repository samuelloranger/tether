package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestIsCopilotSpawn(t *testing.T) {
	for spawn, want := range map[string]bool{
		"copilot --acp":                        true,
		"/home/me/.local/bin/copilot --acp":    true,
		"npx -y @github/copilot@1.0.104 --acp": true,
		"copilot":                              false,
		"opencode acp":                         false,
		"npx -y @agentclientprotocol/claude-agent-acp@0.95.0": false,
	} {
		if got := isCopilotSpawn(spawn); got != want {
			t.Errorf("isCopilotSpawn(%q) = %v", spawn, got)
		}
	}
}

func copilotEvents(t *testing.T, line []byte) []string {
	t.Helper()
	var m struct {
		Params struct {
			ClientCapabilities struct {
				Meta map[string]json.RawMessage `json:"_meta"`
			} `json:"clientCapabilities"`
		} `json:"params"`
	}
	if err := json.Unmarshal(line, &m); err != nil {
		t.Fatalf("%s: %v", line, err)
	}
	var c struct {
		Events []string `json:"events"`
	}
	_ = json.Unmarshal(m.Params.ClientCapabilities.Meta[copilotMetaKey], &c)
	return c.Events
}

func TestInitializeAsksCopilotForAssistantIdle(t *testing.T) {
	plain := []byte(`{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false},"_meta":{"terminal_output":true}}}}` + "\n")
	out := withCopilotEvents(plain)
	if got := copilotEvents(t, out); len(got) != 1 || got[0] != "assistant.idle" {
		t.Fatalf("events %v in %s", got, out)
	}
	for _, kept := range []string{`"protocolVersion":1`, `"fs":{"readTextFile":false}`, `"terminal_output":true`, `"id":0`} {
		if !bytes.Contains(out, []byte(kept)) {
			t.Fatalf("lost %s: %s", kept, out)
		}
	}
	if !bytes.HasSuffix(out, []byte("\n")) {
		t.Fatal("the line must stay one line")
	}

	asked := []byte(`{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"clientCapabilities":{"_meta":{"github.com/copilot":{"events":["subagent.started"]}}}}}` + "\n")
	if got := copilotEvents(t, withCopilotEvents(asked)); strings.Join(got, ",") != "subagent.started,assistant.idle" {
		t.Fatalf("events %v", got)
	}
	has := []byte(`{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"clientCapabilities":{"_meta":{"github.com/copilot":{"events":["assistant.idle"]}}}}}` + "\n")
	if got := withCopilotEvents(has); !bytes.Equal(got, has) {
		t.Fatalf("rewrote %s", got)
	}
	for _, other := range []string{promptLine + "\n", "not json\n"} {
		if got := withCopilotEvents([]byte(other)); string(got) != other {
			t.Fatalf("rewrote %q to %q", other, got)
		}
	}
}

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}
func (l *lockedBuffer) Close() error { return nil }
func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

type copilotHarness struct {
	s      *acpDaemonState
	stdin  *lockedBuffer
	logf   string
	mu     sync.Mutex
	pushed []PushContent
}

func newCopilotHarness(t *testing.T, name string) *copilotHarness {
	t.Helper()
	acpEnv(t)
	grace := copilotIdleGrace
	copilotIdleGrace = 50 * time.Millisecond
	t.Cleanup(func() { copilotIdleGrace = grace })
	if err := os.MkdirAll(acpDir(name), 0o700); err != nil {
		t.Fatal(err)
	}
	h := &copilotHarness{stdin: &lockedBuffer{}, logf: filepath.Join(acpDir(name), "out.log")}
	logf, err := os.Create(h.logf)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { logf.Close() })
	h.s = &acpDaemonState{
		tr: loadACPTracker(name), notify: make(chan struct{}), live: map[*acpClient]struct{}{},
		stdin: h.stdin, log: logf, copilot: true,
		push: func(c PushContent, _ string) error {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.pushed = append(h.pushed, c)
			return nil
		},
	}
	return h
}

func (h *copilotHarness) client(line string) {
	h.s.mu.Lock()
	h.s.clientLineLocked(&acpClient{}, []byte(line+"\n"))
	h.s.mu.Unlock()
}

func (h *copilotHarness) agent(line string) {
	h.s.mu.Lock()
	h.s.agentOutputLocked([]byte(line+"\n"), false, 0)
	h.s.mu.Unlock()
	h.s.scanAgent([]byte(line + "\n"))
}

func (h *copilotHarness) log() string {
	b, _ := os.ReadFile(h.logf)
	return string(b)
}

func (h *copilotHarness) turn() string {
	_, turn, _ := h.s.tr.snapshot()
	return turn
}

func (h *copilotHarness) pushes() []PushContent {
	h.s.pushes.Wait()
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]PushContent(nil), h.pushed...)
}

const (
	copilotPrompt   = `{"jsonrpc":"2.0","id":10,"method":"session/prompt","params":{"sessionId":"s1","prompt":[{"type":"text","text":"start the dev server"}]}}`
	copilotIdleLine = `{"jsonrpc":"2.0","method":"github.com/copilot/sessionEvent","params":{"sessionId":"s1","type":"assistant.idle","timestamp":"2026-10-27T11:58:46.505Z","data":{}}}`
	copilotStarted  = `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"STARTED"}}}}`
)

// Recorded from Copilot CLI 1.0.104: a shell in async mode keeps the prompt open past assistant.idle
// until the client cancels it, and the cancel leaves the shell running.
func TestCopilotPromptHeldPastIdleIsEndedAndCancelled(t *testing.T) {
	h := newCopilotHarness(t, "held")
	h.client(copilotPrompt)
	h.agent(copilotStarted)
	h.agent(copilotIdleLine)
	if h.turn() != "working" {
		t.Fatalf("turn %q right after idle", h.turn())
	}
	waitFor(t, "the held prompt ended", func() bool { return h.turn() == "idle" })

	ended := `{"jsonrpc":"2.0","id":10,"result":{"stopReason":"end_turn"}}` + "\n"
	if !strings.HasSuffix(h.log(), ended) {
		t.Fatalf("log %q", h.log())
	}
	if want := copilotPrompt + "\n" + `{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s1"}}` + "\n"; h.stdin.String() != want {
		t.Fatalf("agent stdin %q", h.stdin.String())
	}
	if got := h.pushes(); len(got) != 1 || got[0].Category != acpDoneCategory || got[0].StopReason != "end_turn" {
		t.Fatalf("pushes %+v", got)
	}

	h.agent(`{"jsonrpc":"2.0","id":10,"result":{"stopReason":"cancelled","usage":{"inputTokens":1}}}`)
	h.agent(`{"jsonrpc":"2.0","method":"github.com/copilot/sessionEvent","params":{"sessionId":"s1","type":"assistant.idle","data":{"aborted":true}}}`)
	if strings.Contains(h.log(), "cancelled") {
		t.Fatalf("the agent's own answer to an ended prompt reached the log: %q", h.log())
	}
	if !strings.HasSuffix(h.log(), `"aborted":true}}}`+"\n") {
		t.Fatalf("the lines after the dropped answer must still be logged: %q", h.log())
	}
	if len(h.pushes()) != 1 || h.turn() != "idle" {
		t.Fatalf("turn %q pushes %d", h.turn(), len(h.pushes()))
	}
}

func TestCopilotPromptAnsweredWithinGraceIsLeftAlone(t *testing.T) {
	h := newCopilotHarness(t, "quick")
	h.client(copilotPrompt)
	h.agent(copilotIdleLine)
	h.agent(`{"jsonrpc":"2.0","id":10,"result":{"stopReason":"end_turn"}}`)
	time.Sleep(4 * copilotIdleGrace)
	if strings.Contains(h.stdin.String(), "session/cancel") {
		t.Fatalf("cancelled a prompt that ended: %q", h.stdin.String())
	}
	if n := strings.Count(h.log(), `"stopReason":"end_turn"`); n != 1 {
		t.Fatalf("%d turn ends in %q", n, h.log())
	}
	if got := h.pushes(); len(got) != 1 {
		t.Fatalf("pushes %+v", got)
	}
}

func TestCopilotSubagentOrAbortedIdleEndsNothing(t *testing.T) {
	h := newCopilotHarness(t, "sub")
	h.client(copilotPrompt)
	h.agent(`{"jsonrpc":"2.0","method":"github.com/copilot/sessionEvent","params":{"sessionId":"s1","type":"assistant.idle","agentId":"task-1","data":{}}}`)
	h.agent(`{"jsonrpc":"2.0","method":"github.com/copilot/sessionEvent","params":{"sessionId":"s1","type":"assistant.idle","data":{"aborted":true}}}`)
	time.Sleep(4 * copilotIdleGrace)
	if h.turn() != "working" || strings.Contains(h.stdin.String(), "session/cancel") || len(h.pushes()) != 0 {
		t.Fatalf("turn %q stdin %q", h.turn(), h.stdin.String())
	}
}

// When an async shell ends Copilot reports it in a turn of its own, with no prompt and no cost.
func TestCopilotTurnItStartsEndsAtIdle(t *testing.T) {
	h := newCopilotHarness(t, "auto")
	h.agent(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call","toolCallId":"read-1","title":"Reading shell output","kind":"read","status":"pending"}}}`)
	if h.turn() != "working" {
		t.Fatalf("turn %q", h.turn())
	}
	h.agent(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"usage_update","used":44498,"size":200000}}}`)
	if h.turn() != "working" {
		t.Fatalf("a usage report without a cost ended the turn")
	}
	h.agent(copilotIdleLine)
	if h.turn() != "idle" {
		t.Fatalf("turn %q", h.turn())
	}
	if got := h.pushes(); len(got) != 1 || got[0].StopReason != "end_turn" {
		t.Fatalf("pushes %+v", got)
	}
}

func TestOnlyCopilotChatsRewriteInitialize(t *testing.T) {
	h := newCopilotHarness(t, "other")
	h.s.copilot = false
	line := `{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"clientCapabilities":{}}}`
	h.client(line)
	if h.stdin.String() != line+"\n" {
		t.Fatalf("stdin %q", h.stdin.String())
	}
	h.s.copilot = true
	h.client(line)
	if !strings.Contains(h.stdin.String(), "assistant.idle") {
		t.Fatalf("stdin %q", h.stdin.String())
	}
}
