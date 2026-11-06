package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIsOpenCodeSpawn(t *testing.T) {
	for spawn, want := range map[string]bool{
		"opencode acp": true,
		"/home/me/.opencode/bin/opencode acp --port 0": true,
		"opencode.exe acp": true,
		"opencode serve":   false,
		"other acp":        false,
		"npx -y @agentclientprotocol/codex-acp@2.3.0": false,
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
