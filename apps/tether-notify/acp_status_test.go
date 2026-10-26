package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const promptReq = `{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"s","prompt":[]}}`

func acpStatusJSON(t *testing.T, name string) acpStatusLine {
	t.Helper()
	out, _, code := runAcp(t, "status", name)
	if code != 0 {
		t.Fatalf("status exit %d", code)
	}
	var l acpStatusLine
	if err := json.Unmarshal([]byte(out), &l); err != nil {
		t.Fatalf("status %q: %v", out, err)
	}
	return l
}

func waitTurn(t *testing.T, name, turn string) {
	t.Helper()
	waitFor(t, "turn "+turn, func() bool {
		m, err := readACPMeta(name)
		return err == nil && m.Turn == turn
	})
}

func TestACPStatusTurnTransitions(t *testing.T) {
	acpEnv(t)
	a, script := newScriptedAgent(t)
	cleanupSession(t, "t")
	p := startAttach(t, "t", "--spawn", script, "--cwd", t.TempDir())
	waitTurn(t, "t", "idle")
	if l := acpStatusJSON(t, "t"); l.State != "running" || l.Turn != "idle" || l.Title != "" {
		t.Fatalf("fresh %+v", l)
	}

	fmt.Fprint(p.stdin, promptReq+"\n")
	waitTurn(t, "t", "working")
	a.emit(t, `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"session_info_update","title":"Fix the thing"}}}`)
	waitFor(t, "title", func() bool { return acpStatusJSON(t, "t").Title == "Fix the thing" })
	if l := acpStatusJSON(t, "t"); l.Turn != "working" || l.LogBytes == 0 {
		t.Fatalf("working %+v", l)
	}

	a.emit(t, permReq)
	waitTurn(t, "t", "waiting")
	if _, _, code := runAcp(t, "answer", "t", "--request", "7", "--option", "allow"); code != 0 {
		t.Fatalf("answer exit %d", code)
	}
	waitTurn(t, "t", "working")

	a.emit(t, `{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}`)
	waitTurn(t, "t", "idle")
	if l := acpStatusJSON(t, "t"); l.Title != "Fix the thing" {
		t.Fatalf("title lost %+v", l)
	}
}

func TestACPStatusWaitingBeatsWorkingAndClientAnswerClears(t *testing.T) {
	acpEnv(t)
	a, script := newScriptedAgent(t)
	cleanupSession(t, "t")
	p := startAttach(t, "t", "--spawn", script, "--cwd", t.TempDir())
	fmt.Fprint(p.stdin, promptReq+"\n")
	waitTurn(t, "t", "working")
	a.emit(t, `{"jsonrpc":"2.0","id":9,"method":"elicitation/create","params":{"message":"Pick","requestedSchema":{"properties":{"q":{"type":"string"}}}}}`)
	waitTurn(t, "t", "waiting")
	if l := acpStatusJSON(t, "t"); l.Turn != "waiting" {
		t.Fatalf("%+v", l)
	}
	fmt.Fprint(p.stdin, `{"jsonrpc":"2.0","id":9,"result":{"action":"cancel"}}`+"\n")
	waitTurn(t, "t", "working")
}

func TestACPStatusEndedSessionIsIdle(t *testing.T) {
	acpEnv(t)
	cleanupSession(t, "t")
	p := startAttach(t, "t", "--spawn", `read l; echo hi`, "--cwd", t.TempDir())
	fmt.Fprint(p.stdin, promptReq+"\n")
	p.readAll(t)
	waitEnded(t, "t", "exited")
	l := acpStatusJSON(t, "t")
	if l.State != "ended" || l.Turn != "idle" || l.EndedReason != "exited" || l.LogBytes == 0 || l.Name != "t" {
		t.Fatalf("%+v", l)
	}
}

func TestACPStatusAllAndUnknown(t *testing.T) {
	acpEnv(t)
	out, _, code := runAcp(t, "status")
	if code != 0 || out != "" {
		t.Fatalf("empty: %q exit %d", out, code)
	}
	for _, n := range []string{"a", "b"} {
		cleanupSession(t, n)
		p := startAttach(t, n, "--spawn", `cat >/dev/null`, "--cwd", t.TempDir())
		_ = p.stdin.Close()
		p.exitCode(t)
	}
	out, _, code = runAcp(t, "status")
	if code != 0 || strings.Count(out, "\n") != 2 {
		t.Fatalf("all: %q exit %d", out, code)
	}
	var raw map[string]any
	if err := json.Unmarshal([]byte(strings.SplitN(out, "\n", 2)[0]), &raw); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"name", "state", "turn", "title", "cwd", "created", "logBytes", "endedReason"} {
		if _, ok := raw[k]; !ok {
			t.Fatalf("missing key %q in %v", k, raw)
		}
	}
	if _, _, code := runAcp(t, "status", "nope"); code != 3 {
		t.Fatalf("unknown exit %d", code)
	}
}

func TestACPStatusDeadDaemonReadsEnded(t *testing.T) {
	acpEnv(t)
	writeEnded(t, "gone", 0, 0)
	m, _ := readACPMeta("gone")
	m.State, m.Turn = "running", "working"
	if err := writeACPMeta(m); err != nil {
		t.Fatal(err)
	}
	var b bytes.Buffer
	if err := acpStatus([]string{"gone"}, &b); err != nil || !strings.Contains(b.String(), `"state":"ended","turn":"idle"`) {
		t.Fatalf("%q %v", b.String(), err)
	}
}

func fakeAgent(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agent.sh")
	if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	return "/bin/sh " + path
}

const listAgent = `read l; echo '{"jsonrpc":"2.0","method":"session/update","params":{}}'
echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
read l
case "$l" in *'"cwd":"/proj"'*) ;; *) echo '{"jsonrpc":"2.0","id":2,"error":{"code":-1,"message":"wrong cwd"}}'; exit 0;; esac
echo '{"jsonrpc":"2.0","id":2,"result":{"sessions":[{"sessionId":"old","cwd":"/proj","title":"Old","updatedAt":"2026-01-01T00:00:00Z"},{"sessionId":"new","cwd":"/proj","title":"New","updatedAt":"2026-03-01T00:00:00Z"},{"sessionId":"mid","cwd":"/proj","updatedAt":"2026-02-01T00:00:00Z"}]}}'
sleep 30
`

func TestACPSessionsListsNewestFirstAndLimit(t *testing.T) {
	acpEnv(t)
	cmd := fakeAgent(t, listAgent)
	out, _, code := runAcp(t, "sessions", "/proj", "--agent-cmd", cmd)
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	var ids []string
	for _, l := range strings.Split(strings.TrimSpace(out), "\n") {
		var s acpSavedSession
		if err := json.Unmarshal([]byte(l), &s); err != nil {
			t.Fatalf("%q: %v", l, err)
		}
		ids = append(ids, s.SessionID)
	}
	if strings.Join(ids, ",") != "new,mid,old" {
		t.Fatalf("order %v", ids)
	}
	if !strings.Contains(out, `"title":"New"`) || !strings.Contains(out, `"updatedAt":"2026-03-01T00:00:00Z"`) {
		t.Fatalf("shape %q", out)
	}
	out, _, _ = runAcp(t, "sessions", "/proj", "--limit", "2", "--agent-cmd", cmd)
	if strings.Count(out, "\n") != 2 {
		t.Fatalf("limit %q", out)
	}
}

func TestACPSessionsEnvOverrideAndKillsAgent(t *testing.T) {
	acpEnv(t)
	pidFile := filepath.Join(t.TempDir(), "pid")
	t.Setenv("TETHER_ACP_AGENT_CMD", fakeAgent(t, "echo $$ > "+pidFile+"\n"+listAgent))
	out, _, code := runAcp(t, "sessions", "/proj")
	if code != 0 || !strings.Contains(out, `"sessionId":"new"`) {
		t.Fatalf("%q exit %d", out, code)
	}
	data, _ := os.ReadFile(pidFile)
	var pid int
	fmt.Sscan(strings.TrimSpace(string(data)), &pid)
	waitFor(t, "agent killed", func() bool { return !procUp(pid) })
}

func TestACPSessionsFailures(t *testing.T) {
	acpEnv(t)
	for name, tc := range map[string]struct{ body, want string }{
		"died":  {`echo boom >&2; exit 4`, "agent exited before listing sessions: boom"},
		"error": {`read l; echo '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Authentication required"}}'`, "Authentication required"},
		"junk":  {`read l; echo '{"jsonrpc":"2.0","id":1,"result":{}}'; read l; echo '{"jsonrpc":"2.0","id":2,"result":"x"}'`, "unreadable session list"},
	} {
		_, errb, code := runAcp(t, "sessions", "/proj", "--agent-cmd", fakeAgent(t, tc.body))
		if code == 0 || !strings.Contains(errb, tc.want) {
			t.Fatalf("%s: exit %d stderr %q", name, code, errb)
		}
	}
}

func TestACPSessionsTimeout(t *testing.T) {
	acpEnv(t)
	old := acpSessionsTimeout
	acpSessionsTimeout = 400 * time.Millisecond
	defer func() { acpSessionsTimeout = old }()
	var b bytes.Buffer
	start := time.Now()
	err := acpSessions([]string{"/proj", "--agent-cmd", fakeAgent(t, "sleep 30")}, &b)
	if err == nil || !strings.Contains(err.Error(), "did not answer initialize") || time.Since(start) > 5*time.Second {
		t.Fatalf("%v after %v", err, time.Since(start))
	}
}

func TestACPSessionsPaginates(t *testing.T) {
	acpEnv(t)
	body := `read l; echo '{"jsonrpc":"2.0","id":1,"result":{}}'
read l; echo '{"jsonrpc":"2.0","id":2,"result":{"sessions":[{"sessionId":"a","updatedAt":"2026-01-01"}],"nextCursor":"c1"}}'
read l; case "$l" in *c1*) echo '{"jsonrpc":"2.0","id":3,"result":{"sessions":[{"sessionId":"b","updatedAt":"2026-02-01"}]}}';; esac`
	var b bytes.Buffer
	if err := acpSessions([]string{"/proj", "--agent-cmd", fakeAgent(t, body)}, &b); err != nil || strings.Count(b.String(), "\n") != 2 {
		t.Fatalf("%q %v", b.String(), err)
	}
}
