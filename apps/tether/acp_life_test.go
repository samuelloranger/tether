package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const idleWindow = "800ms"

func metaState(name string) (string, string) {
	m, err := readACPMeta(name)
	if err != nil {
		return "", ""
	}
	return m.State, m.EndedReason
}

func waitEnded(t *testing.T, name, reason string) {
	t.Helper()
	waitFor(t, "ended "+reason, func() bool { s, _ := metaState(name); return s == "ended" })
	if _, got := metaState(name); got != reason {
		t.Fatalf("endedReason %q, want %q", got, reason)
	}
}

func staysRunning(t *testing.T, name string, d time.Duration) {
	t.Helper()
	time.Sleep(d)
	if s, r := metaState(name); s != "running" {
		t.Fatalf("state %q (%s), should still be running", s, r)
	}
}

func TestACPIdleEndsDetachedAgentAndKeepsLog(t *testing.T) {
	acpEnv(t)
	t.Setenv("TETHER_ACP_IDLE", idleWindow)
	cleanupSession(t, "i1")
	p := startAttach(t, "i1", "--spawn", echoAgent, "--cwd", t.TempDir())
	fmt.Fprintln(p.stdin, "hello")
	if l := p.readLine(t); l != "echo:hello\n" {
		t.Fatalf("got %q", l)
	}
	_ = p.stdin.Close()
	p.exitCode(t)
	waitEnded(t, "i1", "idle")
	m, _ := readACPMeta("i1")
	if m.Ended == 0 || m.AgentPid == 0 || procUp(m.AgentPid) {
		t.Fatalf("meta %+v", m)
	}
	re := startAttach(t, "i1")
	if got := re.readAll(t); got != "echo:hello\n" || re.exitCode(t) != 0 {
		t.Fatalf("replay %q", got)
	}
}

func TestACPIdleNotWhileClientAttached(t *testing.T) {
	acpEnv(t)
	t.Setenv("TETHER_ACP_IDLE", idleWindow)
	cleanupSession(t, "i2")
	p := startAttach(t, "i2", "--spawn", echoAgent, "--cwd", t.TempDir())
	waitFor(t, "attached", func() bool { m, err := readACPMeta("i2"); return err == nil && m.Attached })
	staysRunning(t, "i2", 3*800*time.Millisecond)
	_ = p.stdin.Close()
	p.exitCode(t)
	waitEnded(t, "i2", "idle")
}

func TestACPIdleNotWhilePermissionOutstanding(t *testing.T) {
	acpEnv(t)
	newFakeRelay(t, 200)
	t.Setenv("TETHER_ACP_IDLE", idleWindow)
	a, script := newScriptedAgent(t)
	cleanupSession(t, "i3")
	p := startAttach(t, "i3", "--spawn", script, "--cwd", t.TempDir())
	waitFor(t, "attached", func() bool { m, err := readACPMeta("i3"); return err == nil && m.Attached })
	a.emit(t, permReq)
	p.readLine(t)
	waitFor(t, "pending", func() bool { return pendingCount("i3") == 1 })
	_ = p.stdin.Close()
	p.exitCode(t)
	staysRunning(t, "i3", 3*800*time.Millisecond)
	if _, errs, code := runAcp(t, "answer", "i3", "--request", "7", "--option", "allow"); code != 0 {
		t.Fatalf("answer exit %d %q", code, errs)
	}
	waitEnded(t, "i3", "idle")
}

func TestACPIdleNotWhileElicitationOutstanding(t *testing.T) {
	acpEnv(t)
	newFakeRelay(t, 200)
	t.Setenv("TETHER_ACP_IDLE", idleWindow)
	a, script := newScriptedAgent(t)
	cleanupSession(t, "i3e")
	p := startAttach(t, "i3e", "--spawn", script, "--cwd", t.TempDir())
	waitFor(t, "attached", func() bool { m, err := readACPMeta("i3e"); return err == nil && m.Attached })
	a.emit(t, elicitReq)
	p.readLine(t)
	waitFor(t, "pending", func() bool { return pendingCount("i3e") == 1 })
	_ = p.stdin.Close()
	p.exitCode(t)
	staysRunning(t, "i3e", 3*800*time.Millisecond)
	if _, errs, code := runAcp(t, "answer", "i3e", "--request", "0", "--cancel"); code != 0 {
		t.Fatalf("answer exit %d %q", code, errs)
	}
	waitEnded(t, "i3e", "idle")
}

func TestACPIdleNotWhilePromptInFlight(t *testing.T) {
	acpEnv(t)
	newFakeRelay(t, 200)
	t.Setenv("TETHER_ACP_IDLE", idleWindow)
	a, script := newScriptedAgent(t)
	cleanupSession(t, "i4")
	p := startAttach(t, "i4", "--spawn", script, "--cwd", t.TempDir())
	fmt.Fprint(p.stdin, `{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{}}`+"\n")
	waitFor(t, "prompt seen", func() bool { return strings.Contains(a.stdin(), "session/prompt") })
	_ = p.stdin.Close()
	p.exitCode(t)
	staysRunning(t, "i4", 3*800*time.Millisecond)
	a.emit(t, `{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}`)
	waitEnded(t, "i4", "idle")
}

func TestACPIdleNotWhileAgentKeepsPrinting(t *testing.T) {
	acpEnv(t)
	t.Setenv("TETHER_ACP_IDLE", idleWindow)
	script := `while :; do echo '{"jsonrpc":"2.0","method":"x"}'; sleep 0.1; done`
	cleanupSession(t, "i5")
	p := startAttach(t, "i5", "--spawn", script, "--cwd", t.TempDir())
	p.readLine(t)
	_ = p.stdin.Close()
	p.exitCode(t)
	staysRunning(t, "i5", 3*800*time.Millisecond)
}

func TestACPIdleDisabledWithZero(t *testing.T) {
	acpEnv(t)
	t.Setenv("TETHER_ACP_IDLE", "0")
	cleanupSession(t, "i6")
	p := startAttach(t, "i6", "--spawn", echoAgent, "--cwd", t.TempDir())
	waitFor(t, "attached", func() bool { m, err := readACPMeta("i6"); return err == nil && m.Attached })
	_ = p.stdin.Close()
	p.exitCode(t)
	staysRunning(t, "i6", time.Second)
}

func TestACPLogLimitEndsAgentWithoutTouchingLog(t *testing.T) {
	acpEnv(t)
	t.Setenv("TETHER_ACP_LOG_MAX", "200")
	line := strings.Repeat("a", 300)
	cleanupSession(t, "l1")
	p := startAttach(t, "l1", "--spawn", "echo "+line+"; sleep 60", "--cwd", t.TempDir())
	if got := p.readAll(t); got != line+"\n" {
		t.Fatalf("replay %d bytes", len(got))
	}
	p.exitCode(t)
	waitEnded(t, "l1", "log-limit")
	st, err := os.Stat(filepath.Join(acpDir("l1"), "out.log"))
	if err != nil || st.Size() != 301 {
		t.Fatalf("log %v %v", st, err)
	}
}

func TestACPEndedReasonExitedAndKilled(t *testing.T) {
	acpEnv(t)
	cleanupSession(t, "x1")
	p := startAttach(t, "x1", "--spawn", "echo hi", "--cwd", t.TempDir())
	p.readAll(t)
	p.exitCode(t)
	waitEnded(t, "x1", "exited")

	cleanupSession(t, "x2")
	q := startAttach(t, "x2", "--spawn", "echo $$ > "+filepath.Join(t.TempDir(), "pid")+"; kill -9 $$", "--cwd", t.TempDir())
	q.readAll(t)
	q.exitCode(t)
	waitEnded(t, "x2", "killed")
}

func writeEnded(t *testing.T, name string, ended int64, pid int) {
	t.Helper()
	if err := os.MkdirAll(acpDir(name), 0o700); err != nil {
		t.Fatal(err)
	}
	code := 0
	m := &acpMeta{Name: name, State: "ended", ExitCode: &code, Cwd: "/w", Created: 5, Spawn: "agent\t--x", Sock: filepath.Join(acpDir(name), "sock"), Ended: ended, Pid: pid}
	if err := writeACPMeta(m); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(acpDir(name), "out.log"), []byte("abc"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func exists(name string) bool {
	_, err := os.Stat(acpDir(name))
	return err == nil
}

func TestACPRetentionPrunesOldEndedOnLsAndAttach(t *testing.T) {
	acpEnv(t)
	t.Setenv("TETHER_ACP_KEEP_ENDED", "1h")
	now := time.Now()
	writeEnded(t, "old", now.Add(-2*time.Hour).Unix(), 0)
	writeEnded(t, "fresh", now.Add(-10*time.Minute).Unix(), 0)
	writeEnded(t, "alive", now.Add(-2*time.Hour).Unix(), os.Getpid())
	writeEnded(t, "legacy", 0, 0)
	old := now.Add(-3 * time.Hour)
	if err := os.Chtimes(acpMetaPath("legacy"), old, old); err != nil {
		t.Fatal(err)
	}
	out := lsOutput(t)
	if exists("old") || exists("legacy") || !exists("fresh") || !exists("alive") {
		t.Fatalf("after ls: old=%v legacy=%v fresh=%v alive=%v", exists("old"), exists("legacy"), exists("fresh"), exists("alive"))
	}
	if strings.Contains(out, "old\t") || !strings.Contains(out, "fresh\tended\t3\t/w\t5\tagent --x\n") {
		t.Fatalf("ls %q", out)
	}

	writeEnded(t, "old2", now.Add(-2*time.Hour).Unix(), 0)
	writeEnded(t, "target", now.Add(-5*time.Hour).Unix(), 0)
	if err := acpAttach([]string{"target"}); err != nil {
		t.Fatal(err)
	}
	if exists("old2") || !exists("target") {
		t.Fatalf("after attach: old2=%v target=%v", exists("old2"), exists("target"))
	}
}

func TestACPLsFormatUnchanged(t *testing.T) {
	acpEnv(t)
	cleanupSession(t, "f1")
	p := startAttach(t, "f1", "--spawn", echoAgent, "--cwd", "/tmp")
	fmt.Fprintln(p.stdin, "x")
	p.readLine(t)
	m, _ := readACPMeta("f1")
	want := fmt.Sprintf("f1\trunning\t7\t/tmp\t%d\t%s\n", m.Created, echoAgent)
	if got := lsOutput(t); got != want {
		t.Fatalf("ls %q, want %q", got, want)
	}
}

func TestACPNotFoundMessage(t *testing.T) {
	cases := []struct {
		code int
		log  string
		want string
	}{
		{127, "sh: 1: npx: not found\n", "agent command not found on this host: node/npx not found: install Node.js on this host"},
		{127, "/bin/bash: line 1: node: command not found\n", "agent command not found on this host: node/npx not found: install Node.js on this host"},
		{127, "zsh:1: command not found: my-agent\n", "agent command not found on this host: my-agent not found"},
		{127, "", "agent command not found on this host (status 127)"},
		{1, "sh: 1: foo: not found\n", "agent command not found on this host: foo not found"},
		{1, "boom\n", ""},
	}
	for _, c := range cases {
		if got := notFoundMessage(c.code, c.log); got != c.want {
			t.Errorf("%d %q: got %q want %q", c.code, c.log, got, c.want)
		}
	}
}

func TestACPSpawnOfMissingProgramReportsPlainly(t *testing.T) {
	acpEnv(t)
	cleanupSession(t, "nf")
	var errb bytes.Buffer
	p := startAttach(t, "nf", "--spawn", "definitely-not-a-real-agent-cmd", "--cwd", t.TempDir())
	p.readAll(t)
	if p.exitCode(t) != 0 {
		t.Fatal("exit not 0")
	}
	errb.WriteString(p.errb.String())
	if !strings.Contains(errb.String(), "agent command not found on this host: definitely-not-a-real-agent-cmd not found") {
		t.Fatalf("stderr %q", errb.String())
	}
}
