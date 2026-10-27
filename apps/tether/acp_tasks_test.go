package main

import (
	"bufio"
	"os"
	"strings"
	"testing"
)

// The recorded run: a Bash command goes to the background, the prompt ends, the command ends, and
// Claude Code starts a turn by itself to report it.
func TestACPBackgroundCommandAndAgentStartedTurn(t *testing.T) {
	acpEnv(t)
	_ = os.MkdirAll(acpDir("bg"), 0o700)
	var pushed []PushContent
	s := &acpDaemonState{tr: loadACPTracker("bg"), push: func(c PushContent, _ string) error { pushed = append(pushed, c); return nil }}
	f, err := os.Open("testdata/acp-background.log")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	type step struct {
		turn          string
		tasks, pushes int
	}
	var seen []step
	sc := bufio.NewScanner(f)
	sc.Buffer(nil, maxACPLine)
	for sc.Scan() {
		line := sc.Text()
		switch {
		case strings.HasPrefix(line, "> "):
			s.tr.clientLine([]byte(line[2:]))
		case strings.HasPrefix(line, "< "):
			s.scanAgent([]byte(line[2:] + "\n"))
			s.pushes.Wait()
		}
		_, turn, tasks := s.tr.snapshot()
		if len(seen) == 0 || seen[len(seen)-1] != (step{turn, tasks, len(pushed)}) {
			seen = append(seen, step{turn, tasks, len(pushed)})
		}
	}
	want := []step{
		{"idle", 0, 0},
		{"working", 0, 0},
		{"working", 1, 0},
		{"idle", 1, 1},
		{"idle", 0, 1},
		{"working", 0, 1},
		{"idle", 0, 2},
	}
	if len(seen) != len(want) {
		t.Fatalf("steps %v, want %v", seen, want)
	}
	for i := range want {
		if seen[i] != want[i] {
			t.Fatalf("steps %v, want %v", seen, want)
		}
	}
	if pushed[1].Category != acpDoneCategory || pushed[1].StopReason != "end_turn" {
		t.Fatalf("agent-started turn push %+v", pushed[1])
	}
}

func TestACPLoadReplayIsNoTurnAndEndsTasks(t *testing.T) {
	acpEnv(t)
	_ = os.MkdirAll(acpDir("ld"), 0o700)
	tr := loadACPTracker("ld")
	tr.st.Tasks, tr.st.Terminals = []string{"a"}, []string{"a"}
	tr.clientLine([]byte(`{"jsonrpc":"2.0","id":2,"method":"session/load","params":{"sessionId":"x","cwd":"/","mcpServers":[]}}`))
	tr.agentLine([]byte(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"x","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"old"}}}}`))
	if _, turn, _ := tr.snapshot(); turn != "idle" {
		t.Fatalf("replayed history made the turn %s", turn)
	}
	tr.agentLine([]byte(`{"jsonrpc":"2.0","id":2,"result":{}}`))
	if _, turn, tasks := tr.snapshot(); turn != "idle" || tasks != 0 {
		t.Fatalf("after load: %s, %d tasks", turn, tasks)
	}
}

func TestACPCancelEndsAgentStartedTurn(t *testing.T) {
	acpEnv(t)
	_ = os.MkdirAll(acpDir("cx"), 0o700)
	tr := loadACPTracker("cx")
	tr.agentLine([]byte(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"x","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}}`))
	if _, turn, _ := tr.snapshot(); turn != "working" {
		t.Fatalf("turn %s", turn)
	}
	tr.clientLine([]byte(`{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"x"}}`))
	if _, turn, _ := tr.snapshot(); turn != "idle" {
		t.Fatalf("turn after cancel %s", turn)
	}
}

func TestACPStatusReportsTasks(t *testing.T) {
	acpEnv(t)
	_ = os.MkdirAll(acpDir("st"), 0o700)
	m := &acpMeta{Name: "st", State: "running", Pid: os.Getpid(), Turn: "idle", Tasks: 2}
	if err := writeACPMeta(m); err != nil {
		t.Fatal(err)
	}
	l, err := acpStatusOf("st")
	if err != nil {
		t.Fatal(err)
	}
	if l.State != "running" || l.Tasks != 2 {
		t.Fatalf("status %+v", l)
	}
}

func TestACPToolResponseArrayDoesNotDropTheLine(t *testing.T) {
	acpEnv(t)
	_ = os.MkdirAll(acpDir("mcp"), 0o700)
	tr := loadACPTracker("mcp")
	tr.agentLine([]byte(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"x","update":{"sessionUpdate":"tool_call","toolCallId":"m","_meta":{"claudeCode":{"toolResponse":[{"type":"text","text":"r"}]}}}}}`))
	if _, turn, _ := tr.snapshot(); turn != "working" {
		t.Fatalf("an MCP result line was dropped: turn %s", turn)
	}
}
