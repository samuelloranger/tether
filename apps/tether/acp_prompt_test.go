package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestACPPromptJoinsTheConversationAsTheHostsOwnClient(t *testing.T) {
	dir := acpEnv(t)
	a, script := newScriptedAgent(t)
	cleanupSession(t, "p")
	p := startAttach(t, "p", "--spawn", script, "--cwd", t.TempDir(), "--client", "dev-a")
	waitFor(t, "the session", func() bool { m, _ := readACPMeta("p"); return m != nil && m.Attached })

	if err := acpPrompt([]string{"p"}, strings.NewReader("Morning briefing")); !errors.Is(err, errNoACPSession) {
		t.Fatalf("before a session: %v", err)
	}
	fmt.Fprint(p.stdin, `{"jsonrpc":"2.0","id":"dev-a-1","method":"session/new","params":{"cwd":"/w","mcpServers":[]}}`+"\n")
	a.emit(t, `{"jsonrpc":"2.0","id":"dev-a-1","result":{"sessionId":"sess-9"}}`)
	waitFor(t, "the session id", func() bool {
		b, _ := os.ReadFile(filepath.Join(dir, "acp", "p", "out.log"))
		return strings.Contains(string(b), "sess-9")
	})

	if err := acpPrompt([]string{"p"}, strings.NewReader("Morning briefing")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the agent got the prompt", func() bool {
		in := a.stdin()
		return strings.Contains(in, `"method":"session/prompt"`) && strings.Contains(in, `"sessionId":"sess-9"`) && strings.Contains(in, "Morning briefing")
	})
	waitFor(t, "the echo", func() bool {
		log, _ := os.ReadFile(filepath.Join(dir, "acp", "p", "out.log"))
		return strings.Contains(string(log), `"client":"host"`) && strings.Contains(string(log), "Morning briefing")
	})
	if err := acpPrompt([]string{"p"}, strings.NewReader("Again")); !errors.Is(err, errBusy) {
		t.Fatalf("during a turn: %v", err)
	}
}
