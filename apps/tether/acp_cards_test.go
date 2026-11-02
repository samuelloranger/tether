package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestChatCardsRegistrationPreservesServersAndIsIdempotent(t *testing.T) {
	for _, method := range []string{"session/new", "session/load", "session/resume"} {
		line := []byte(`{"jsonrpc":"2.0","id":"phone-2","method":"` + method + `","params":{"cwd":"/work","sessionId":"s","mcpServers":[{"name":"existing","command":"tool"}]}}`)
		out := withChatCards(line, "claude-agent-acp")
		var msg struct {
			Params struct {
				Servers []struct {
					Name    string
					Command string
					Args    []string
				} `json:"mcpServers"`
				Cwd       string
				SessionID string
			}
		}
		if err := json.Unmarshal(out, &msg); err != nil {
			t.Fatal(err)
		}
		if msg.Params.Cwd != "/work" || msg.Params.SessionID != "s" || len(msg.Params.Servers) != 2 || msg.Params.Servers[0].Name != "existing" || msg.Params.Servers[1].Name != "tether-cards" {
			t.Fatal("lost session or MCP configuration")
		}
		if !bytes.Equal(withChatCards(out, "claude-agent-acp"), out) {
			t.Fatal("duplicate registration")
		}
	}
	line := []byte(`{"method":"session/prompt","params":{"prompt":[]}}`)
	if !bytes.Equal(withChatCards(line, "claude-agent-acp"), line) {
		t.Fatal("changed an ordinary prompt")
	}
}

func TestHermesCardServerMayReadImagesFromHermesHome(t *testing.T) {
	line := []byte(`{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/w","mcpServers":[]}}`)
	for spawn, want := range map[string]bool{"tether hermes": true, "npx -y @agentclientprotocol/claude-agent-acp": false} {
		var msg struct {
			Params struct {
				Servers []struct {
					Env []struct{ Name, Value string }
				} `json:"mcpServers"`
			}
		}
		if err := json.Unmarshal(withChatCards(line, spawn), &msg); err != nil || len(msg.Params.Servers) != 1 {
			t.Fatalf("%s: %v", spawn, err)
		}
		env := msg.Params.Servers[0].Env
		has := len(env) == 1 && env[0].Name == "TETHER_CARD_IMAGE_ROOT" && env[0].Value == "~"
		if has != want {
			t.Fatalf("%s: image root %v, want %v", spawn, has, want)
		}
	}
}

func TestEmbeddedCardPublisherIsDiscoverableByAnMCPClient(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("Python 3 not installed")
	}
	cmd := exec.Command(python, "-c", chatCardsSource)
	cmd.Stdin = bytes.NewBufferString("{\"id\":1,\"method\":\"initialize\",\"params\":{}}\n{\"id\":2,\"method\":\"tools/list\"}\n")
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(out, []byte("tether_publish_card")) || !bytes.Contains(out, []byte("inputSchema")) {
		t.Fatalf("missing discovery: %.200s", out)
	}
}

func TestChatCardsReachTheAgentButTheLogReplaysTheClientsOwnLine(t *testing.T) {
	dir := acpEnv(t)
	a, script := newScriptedAgent(t)
	cleanupSession(t, "c")
	p := startAttach(t, "c", "--spawn", script+" # claude-agent-acp", "--cwd", t.TempDir(), "--client", "dev-a")
	line := `{"jsonrpc":"2.0","id":"dev-a-1","method":"session/new","params":{"cwd":"/w","mcpServers":[]}}`
	fmt.Fprint(p.stdin, line+"\n")
	waitFor(t, "agent got the session request", func() bool { return strings.Contains(a.stdin(), "tether-cards") })
	waitFor(t, "the echo", func() bool {
		log, _ := os.ReadFile(filepath.Join(dir, "acp", "c", "out.log"))
		return len(log) > 0
	})
	log, _ := os.ReadFile(filepath.Join(dir, "acp", "c", "out.log"))
	if string(log) != echoOf("dev-a", line) {
		t.Fatalf("log replays %.300q", log)
	}
}
