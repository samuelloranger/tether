package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestIsOpenCodeSpawn(t *testing.T) {
	for spawn, want := range map[string]bool{
		"opencode acp": true,
		"/home/me/.opencode/bin/opencode acp --port 0": true,
		"opencode.exe acp": true,
		"opencode serve":   false,
		"other acp":        false,
		"npx -y @agentclientprotocol/codex-acp@2.3.0":   false,
		`PATH="$HOME/.opencode/bin:$PATH" opencode acp`: true,
		"npx opencode-ai acp":                           true,
		"npx -y opencode-ai@1.2.3 acp":                  true,
		"bunx opencode-ai@latest acp":                   true,
		`sh -c "opencode acp"`:                          true,
		`sh -c 'npx opencode-ai@latest acp'`:            true,
		"claude-agent-acp":                              false,
		"npx -y @zed-industries/claude-agent-acp acp":   false,
		"gemini --acp":                                  false,
		"/opt/opencode-tools/other acp":                 false,
		"opencode-ai serve":                             false,
	} {
		if got := isOpenCodeSpawn(spawn); got != want {
			t.Errorf("isOpenCodeSpawn(%q) = %v, want %v", spawn, got, want)
		}
	}
}

func openCodeHarness(t *testing.T) *copilotHarness {
	t.Helper()
	h := newCopilotHarness(t, "queue")
	h.s.copilot = false
	h.s.meta = &acpMeta{Name: "queue", Spawn: "opencode acp"}
	return h
}

const queuedPrompt = `{"jsonrpc":"2.0","id":"phone-2","method":"session/prompt","params":{"sessionId":"s","prompt":[{"type":"image","mimeType":"image/png","data":"aW1hZ2U="},{"type":"text","text":"next"}]}}`

func TestOpenCodePromptsWaitForTheActiveResponse(t *testing.T) {
	h := openCodeHarness(t)
	h.client(promptLine)
	h.client(queuedPrompt)
	third := strings.ReplaceAll(queuedPrompt, "phone-2", "desktop-3")
	h.client(third)
	if got := h.stdin.String(); got != promptLine+"\n" {
		t.Fatalf("concurrent prompt reached OpenCode: %s", got)
	}
	h.agent(`{"id":"unrelated","result":{}}`)
	if got := h.stdin.String(); got != promptLine+"\n" {
		t.Fatalf("unrelated response released queue: %s", got)
	}
	h.agent(`{"id":"dev-a-3","result":{"stopReason":"end_turn"}}`)
	if got := h.stdin.String(); got != promptLine+"\n"+queuedPrompt+"\n" {
		t.Fatalf("first queued message (including image) not sent intact: %s", got)
	}
	if h.turn() != "working" || len(h.pushes()) != 0 {
		t.Fatal("queued work must stay working without a done push")
	}
	h.agent(`{"id":"phone-2","error":{"code":-32603,"message":"failed"}}`)
	if got := h.stdin.String(); got != promptLine+"\n"+queuedPrompt+"\n"+third+"\n" {
		t.Fatalf("queue did not continue after error: %s", got)
	}
	h.agent(`{"id":"desktop-3","result":{"stopReason":"end_turn"}}`)
	if h.turn() != "idle" || len(h.pushes()) != 1 {
		t.Fatal("final response must end the queue and notify the detached client")
	}
}

func TestOtherAgentsKeepConcurrentPromptDelivery(t *testing.T) {
	h := newCopilotHarness(t, "other-agent")
	h.client(promptLine)
	h.client(queuedPrompt)
	if got := h.stdin.String(); got != promptLine+"\n"+queuedPrompt+"\n" {
		t.Fatalf("changed another agent's prompt delivery: %s", got)
	}
}

func TestOpenCodeQueueSurvivesClientDisconnectAndReplays(t *testing.T) {
	acpEnv(t)
	a, script := newScriptedAgent(t)
	spawn := filepath.Join(t.TempDir(), "opencode")
	if err := os.WriteFile(spawn, []byte("#!/bin/sh\n"+script+"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	cleanupSession(t, "replay-queue")
	p := startAttach(t, "replay-queue", "--spawn", spawn+" acp", "--cwd", t.TempDir(), "--client", "phone")
	fmt.Fprintln(p.stdin, promptLine)
	if got := p.readLine(t); got != echoOf("phone", promptLine) {
		t.Fatalf("first echo: %s", got)
	}
	fmt.Fprintln(p.stdin, queuedPrompt)
	if got := p.readLine(t); got != echoOf("phone", queuedPrompt) {
		t.Fatalf("queued echo: %s", got)
	}
	if got := a.stdin(); strings.Contains(got, "phone-2") {
		t.Fatalf("queued prompt forwarded before the first response: %s", got)
	}
	p.stdin.Close()
	if code := p.exitCode(t); code != 0 {
		t.Fatalf("detach exit: %d", code)
	}
	a.emit(t, `{"id":"dev-a-3","result":{"stopReason":"end_turn"}}`)
	waitFor(t, "queued message after disconnect", func() bool { return strings.Contains(a.stdin(), queuedPrompt) })
	q := startAttach(t, "replay-queue", "--client", "desktop")
	for _, want := range []string{echoOf("phone", promptLine), echoOf("phone", queuedPrompt), "{\"id\":\"dev-a-3\",\"result\":{\"stopReason\":\"end_turn\"}}\n"} {
		if got := q.readLine(t); got != want {
			t.Fatalf("replay got %q, want %q", got, want)
		}
	}
	const answer = `{"id":"phone-2","result":{"stopReason":"end_turn"}}`
	a.emit(t, answer)
	if got := q.readLine(t); got != answer+"\n" {
		t.Fatalf("queued response: %s", got)
	}
}

func TestOpenCodeStopWithdrawsQueuedPrompts(t *testing.T) {
	h := openCodeHarness(t)
	h.client(promptLine)
	h.client(queuedPrompt)
	const cancel = `{"method":"session/cancel","params":{"sessionId":"s"}}`
	h.client(cancel)
	h.agent(`{"id":"dev-a-3","result":{"stopReason":"cancelled"}}`)
	if got := h.stdin.String(); got != promptLine+"\n"+cancel+"\n" {
		t.Fatalf("stop sent a withdrawn prompt: %s", got)
	}
	if h.turn() != "idle" || !strings.Contains(h.log(), `"id":"phone-2","result":{"stopReason":"cancelled"}`) {
		t.Fatal("withdrawn prompt must resolve for replay and leave the holder idle")
	}
	h.client(queuedPrompt)
	if !strings.HasSuffix(h.stdin.String(), queuedPrompt+"\n") {
		t.Fatal("a new prompt after stop must run")
	}
}

func fastOpenCodeTimers(t *testing.T, grace time.Duration) {
	t.Helper()
	old := openCodeCancelGrace
	openCodeCancelGrace = grace
	t.Cleanup(func() { openCodeCancelGrace = old })
}

const stopLine = `{"method":"session/cancel","params":{"sessionId":"s"}}`

func TestOpenCodeStopReleasesAnUnansweredPrompt(t *testing.T) {
	// Long enough that the pre-release check below runs first even on a loaded -race runner.
	fastOpenCodeTimers(t, 500*time.Millisecond)
	h := openCodeHarness(t)
	h.client(promptLine)
	h.client(stopLine)
	// Queued after the Stop: must go out once the stuck prompt is released.
	h.client(queuedPrompt)
	if got := h.stdin.String(); got != promptLine+"\n"+stopLine+"\n" {
		t.Fatalf("prompt delivered before release: %s", got)
	}
	waitFor(t, "stuck prompt released", func() bool { return strings.HasSuffix(h.stdin.String(), queuedPrompt+"\n") })
	if !strings.Contains(h.log(), `"id":"dev-a-3","result":{"stopReason":"cancelled"}`) {
		t.Fatalf("no synthetic response for the active prompt: %s", h.log())
	}
	if h.turn() != "working" {
		t.Fatal("the released queued prompt must be the turn in flight")
	}

	// The agent's late answer to the released prompt neither releases nor writes again.
	before, logBefore := h.stdin.String(), strings.Count(h.log(), "phone-2")
	h.agent(`{"id":"dev-a-3","result":{"stopReason":"cancelled"}}`)
	if got := h.stdin.String(); got != before {
		t.Fatalf("late response wrote to the agent: %s", got)
	}
	h.s.mu.Lock()
	active, queued := h.s.activePrompt, len(h.s.queuedPrompts)
	h.s.mu.Unlock()
	if active != `"phone-2"` || queued != 0 {
		t.Fatalf("late response disturbed the queue: active=%q queued=%d", active, queued)
	}
	if strings.Count(h.log(), "phone-2") != logBefore {
		t.Fatal("late response produced another synthetic response")
	}
}

func TestOpenCodeStopAnsweredInTimeDoesNotFire(t *testing.T) {
	fastOpenCodeTimers(t, 500*time.Millisecond)
	h := openCodeHarness(t)
	h.client(promptLine)
	h.client(stopLine)
	h.agent(`{"id":"dev-a-3","result":{"stopReason":"cancelled"}}`)
	h.s.mu.Lock()
	armed := h.s.cancelTimer != nil
	h.s.mu.Unlock()
	if armed {
		t.Fatal("an answer in time must stop the cancel timer")
	}
	h.client(queuedPrompt)
	time.Sleep(700 * time.Millisecond)
	if strings.Count(h.stdin.String(), queuedPrompt) != 1 {
		t.Fatalf("stale timer interfered: %s", h.stdin.String())
	}
	h.s.mu.Lock()
	active := h.s.activePrompt
	h.s.mu.Unlock()
	if active != `"phone-2"` {
		t.Fatalf("active = %q", active)
	}
}

func TestOpenCodeQueueWaitIsLoggedOnce(t *testing.T) {
	old := openCodeQueueWarnAfter
	openCodeQueueWarnAfter = 20 * time.Millisecond
	t.Cleanup(func() { openCodeQueueWarnAfter = old })
	h := openCodeHarness(t)
	var errs lockedBuffer
	h.s.errf = &errs
	h.client(promptLine)
	h.client(queuedPrompt)
	waitFor(t, "queue wait warning", func() bool { return strings.Contains(errs.String(), "phone-2") })
	time.Sleep(60 * time.Millisecond)
	if n := strings.Count(errs.String(), "phone-2"); n != 1 {
		t.Fatalf("warned %d times", n)
	}
}
