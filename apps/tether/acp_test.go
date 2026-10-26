package main

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The holder re-execs its own binary as the daemon, so the test binary has to behave like it.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "acp" {
		main()
		return
	}
	os.Exit(m.Run())
}

const echoAgent = `while IFS= read -r l; do echo "echo:$l"; done`

func acpEnv(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("TETHER_NOTIFY_HOME", dir)
	t.Setenv("SHELL", "/bin/sh")
	return dir
}

type attachProc struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	out   *bufio.Reader
	got   bytes.Buffer
	errb  bytes.Buffer
}

func startAttach(t *testing.T, args ...string) *attachProc {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, append([]string{"acp", "attach"}, args...)...)
	p := &attachProc{cmd: cmd}
	cmd.Stderr = &p.errb
	in, _ := cmd.StdinPipe()
	out, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	p.stdin, p.out = in, bufio.NewReader(out)
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	return p
}

func (p *attachProc) readLine(t *testing.T) string {
	t.Helper()
	type res struct {
		s   string
		err error
	}
	ch := make(chan res, 1)
	go func() { s, err := p.out.ReadString('\n'); ch <- res{s, err} }()
	select {
	case r := <-ch:
		if r.err != nil {
			t.Fatalf("read: %v (got %q)", r.err, r.s)
		}
		p.got.WriteString(r.s)
		return r.s
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for a line")
	}
	return ""
}

func (p *attachProc) readAll(t *testing.T) string {
	t.Helper()
	ch := make(chan []byte, 1)
	go func() { b, _ := io.ReadAll(p.out); ch <- b }()
	select {
	case b := <-ch:
		p.got.Write(b)
		return string(b)
	case <-time.After(15 * time.Second):
		t.Fatal("timed out draining output")
	}
	return ""
}

func (p *attachProc) exitCode(t *testing.T) int {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- p.cmd.Wait() }()
	select {
	case err := <-done:
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return ee.ExitCode()
		}
		if err != nil {
			t.Fatal(err)
		}
		return 0
	case <-time.After(10 * time.Second):
		t.Fatal("attach did not exit")
	}
	return -1
}

func cleanupSession(t *testing.T, name string) {
	t.Cleanup(func() { _ = acpKill(name) })
}

func lsOutput(t *testing.T) string {
	t.Helper()
	var b bytes.Buffer
	if err := acpLs(&b); err != nil {
		t.Fatal(err)
	}
	return b.String()
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for i := 0; i < 500; i++ {
		if ok() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestACPAttachSpawnEchoesThroughAgent(t *testing.T) {
	acpEnv(t)
	cleanupSession(t, "e")
	p := startAttach(t, "e", "--spawn", echoAgent, "--cwd", t.TempDir())
	fmt.Fprint(p.stdin, "hello\n")
	if got := p.readLine(t); got != "echo:hello\n" {
		t.Fatalf("got %q", got)
	}
	fmt.Fprint(p.stdin, "again\n")
	if got := p.readLine(t); got != "echo:again\n" {
		t.Fatalf("got %q", got)
	}
	_ = p.stdin.Close()
	if code := p.exitCode(t); code != 0 {
		t.Fatalf("exit %d", code)
	}
	ls := lsOutput(t)
	fields := strings.Split(strings.TrimSpace(ls), "\t")
	if len(fields) != 6 || fields[0] != "e" || fields[1] != "running" || fields[2] != "22" || fields[5] != echoAgent {
		t.Fatalf("ls %q", ls)
	}
}

func TestACPReattachFromOffsetIsExactlyOnce(t *testing.T) {
	dir := acpEnv(t)
	cleanupSession(t, "r")
	var want strings.Builder
	for i := 0; i < 40; i++ {
		fmt.Fprintf(&want, "line%d\n", i)
	}
	agent := `i=0; while [ $i -lt 40 ]; do echo line$i; i=$((i+1)); sleep 0.05; done`
	p := startAttach(t, "r", "--spawn", agent)
	for i := 0; i < 4; i++ {
		p.readLine(t)
	}
	received := p.got.Len()
	_ = p.cmd.Process.Kill()
	_ = p.cmd.Wait()
	if !strings.HasPrefix(want.String(), p.got.String()) {
		t.Fatalf("first client saw %q", p.got.String())
	}

	m, err := readACPMeta("r")
	if err != nil || !procUp(m.Pid) {
		t.Fatalf("daemon should outlive the client: %v %+v", err, m)
	}

	q := startAttach(t, "r", "--from", fmt.Sprint(received))
	rest := q.readAll(t)
	if code := q.exitCode(t); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if p.got.String()+rest != want.String() {
		t.Fatalf("gap or duplicate:\nfirst %q\nrest %q", p.got.String(), rest)
	}

	full := startAttach(t, "r", "--from", "0")
	if got := full.readAll(t); got != want.String() {
		t.Fatalf("replay from 0 got %q", got)
	}
	disk, _ := os.ReadFile(filepath.Join(dir, "acp", "r", "out.log"))
	if string(disk) != want.String() {
		t.Fatalf("log %q", disk)
	}
	if !strings.Contains(lsOutput(t), "\tended\t") {
		t.Fatalf("ls %q", lsOutput(t))
	}
}

func TestACPReplayFromZeroWhileAgentRuns(t *testing.T) {
	acpEnv(t)
	cleanupSession(t, "z")
	p := startAttach(t, "z", "--spawn", echoAgent)
	fmt.Fprint(p.stdin, "one\n")
	p.readLine(t)
	_ = p.stdin.Close()
	p.exitCode(t)

	q := startAttach(t, "z", "--from", "0")
	_ = q.stdin.Close()
	if got := q.readAll(t); got != "echo:one\n" {
		t.Fatalf("got %q", got)
	}
	if !strings.Contains(lsOutput(t), "\trunning\t") {
		t.Fatalf("agent should still run: %q", lsOutput(t))
	}
}

func TestACPSecondAttachKicksTheFirst(t *testing.T) {
	acpEnv(t)
	cleanupSession(t, "k")
	a := startAttach(t, "k", "--spawn", echoAgent)
	fmt.Fprint(a.stdin, "a1\n")
	a.readLine(t)

	b := startAttach(t, "k", "--from", "0")
	if got := b.readLine(t); got != "echo:a1\n" {
		t.Fatalf("got %q", got)
	}
	if code := a.exitCode(t); code != 5 {
		t.Fatalf("kicked client exit %d, want 5", code)
	}
	fmt.Fprint(b.stdin, "b1\n")
	if got := b.readLine(t); got != "echo:b1\n" {
		t.Fatalf("got %q", got)
	}
}

func TestACPAgentExitDrainsAndExitsZero(t *testing.T) {
	acpEnv(t)
	cleanupSession(t, "x")
	p := startAttach(t, "x", "--spawn", "echo bye; exit 3")
	if got := p.readAll(t); got != "bye\n" {
		t.Fatalf("got %q", got)
	}
	if code := p.exitCode(t); code != 0 {
		t.Fatalf("exit %d", code)
	}
	m, err := readACPMeta("x")
	if err != nil || m.State != "ended" || m.ExitCode == nil || *m.ExitCode != 3 {
		t.Fatalf("meta %+v %v", m, err)
	}
	if !strings.Contains(lsOutput(t), "x\tended\t4\t") {
		t.Fatalf("ls %q", lsOutput(t))
	}
	again := startAttach(t, "x")
	if got := again.readAll(t); got != "bye\n" || again.exitCode(t) != 0 {
		t.Fatalf("replay of ended session %q", got)
	}
}

func TestACPKillRemovesSession(t *testing.T) {
	dir := acpEnv(t)
	p := startAttach(t, "d", "--spawn", echoAgent)
	fmt.Fprint(p.stdin, "x\n")
	p.readLine(t)
	_ = p.stdin.Close()
	p.exitCode(t)
	m, _ := readACPMeta("d")

	if err := acpKill("d"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "acp", "d")); !os.IsNotExist(err) {
		t.Fatalf("dir still there: %v", err)
	}
	waitFor(t, "agent gone", func() bool { return syscall.Kill(m.AgentPid, 0) != nil })
	waitFor(t, "daemon gone", func() bool { return syscall.Kill(m.Pid, 0) != nil })
	if lsOutput(t) != "" {
		t.Fatalf("ls %q", lsOutput(t))
	}
}

func TestACPAttachWithoutSpawnOnMissingSessionExits3(t *testing.T) {
	acpEnv(t)
	p := startAttach(t, "nope")
	if code := p.exitCode(t); code != 3 {
		t.Fatalf("exit %d", code)
	}
}

func TestACPLongStateDirFallsBackToShortSocket(t *testing.T) {
	base := t.TempDir()
	long := filepath.Join(base, strings.Repeat("d", 60), strings.Repeat("e", 60))
	if err := os.MkdirAll(long, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TETHER_NOTIFY_HOME", long)
	t.Setenv("SHELL", "/bin/sh")
	cleanupSession(t, "s")

	p := startAttach(t, "s", "--spawn", echoAgent)
	fmt.Fprint(p.stdin, "hi\n")
	if got := p.readLine(t); got != "echo:hi\n" {
		t.Fatalf("got %q", got)
	}
	m, _ := readACPMeta("s")
	if len(m.Sock) > maxSockPath || !strings.HasPrefix(m.Sock, os.TempDir()) {
		t.Fatalf("sock %q", m.Sock)
	}
	_ = p.stdin.Close()
	p.exitCode(t)
	if err := acpKill("s"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Dir(m.Sock)); !os.IsNotExist(err) {
		t.Fatalf("short sock dir leaked: %v", err)
	}
}

func TestACPAgentFailingWithOnlyStderrIsReported(t *testing.T) {
	acpEnv(t)
	cleanupSession(t, "f")
	p := startAttach(t, "f", "--spawn", "echo 'npx: not found' >&2; exit 127")
	if got := p.readAll(t); got != "" {
		t.Fatalf("stdout %q", got)
	}
	if code := p.exitCode(t); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if got := p.errb.String(); got != "agent command not found on this host: node/npx not found: install Node.js on this host\n" {
		t.Fatalf("stderr %q", got)
	}
	again := startAttach(t, "f")
	again.readAll(t)
	if again.exitCode(t) != 0 || !strings.Contains(again.errb.String(), "not found on this host") {
		t.Fatalf("replay stderr %q", again.errb.String())
	}
}

func TestACPReplayEndedResumesFromOffsetAndStaysQuietOnOutput(t *testing.T) {
	acpEnv(t)
	if err := os.MkdirAll(acpDir("r"), 0o700); err != nil {
		t.Fatal(err)
	}
	code := 2
	if err := writeACPMeta(&acpMeta{Name: "r", State: "ended", ExitCode: &code}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(acpDir("r"), "out.log"), []byte("abcdef"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errw bytes.Buffer
	if err := replayEnded("r", 4, &out, &errw); err != nil || out.String() != "ef" || errw.Len() != 0 {
		t.Fatalf("out %q err %q %v", out.String(), errw.String(), err)
	}
}

func TestACPMetaReportsAttachedOnlyAfterHandshake(t *testing.T) {
	acpEnv(t)
	cleanupSession(t, "m")
	attached := func() bool { m, err := readACPMeta("m"); return err == nil && m.Attached }
	p := startAttach(t, "m", "--spawn", echoAgent, "--cwd", t.TempDir())
	waitFor(t, "attached", attached)
	_ = p.stdin.Close()
	_ = p.exitCode(t)
	waitFor(t, "detached", func() bool { return !attached() })
}
