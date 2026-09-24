package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

type pushCall struct {
	content  PushContent
	collapse string
}

// fakeHost answers `zmx ls` with lsOut/lsErr and `ps` with a single agent at pid 100.
func fakeDeps(t *testing.T, lsOut string, lsErr error) (stateDeps, *[]pushCall) {
	t.Helper()
	t.Setenv("TETHER_NOTIFY_HOME", t.TempDir())
	t.Setenv("TETHER_ZMX", "/fake/zmx")
	var pushes []pushCall
	return stateDeps{
		run: func(name string, args ...string) (string, error) {
			if name == "/fake/zmx" {
				return lsOut, lsErr
			}
			if name == "ps" {
				return "1 claude\n", nil
			}
			return "", errors.New("unexpected " + name)
		},
		now:    func() time.Time { return time.Unix(1000, 0) },
		ppid:   100,
		push:   func(c PushContent, col string) error { pushes = append(pushes, pushCall{c, col}); return nil },
		stderr: &bytes.Buffer{},
	}, &pushes
}

func args(state string, extra ...string) []string {
	return append([]string{"--session", "work", "--agent", "claude", "--state", state}, extra...)
}

func TestStateWorkingWritesAndNeverPushes(t *testing.T) {
	d, pushes := fakeDeps(t, "name=work\tclients=0\n", nil)
	if err := runState(args("working"), d); err != nil {
		t.Fatal(err)
	}
	s, _ := readSession("work")
	if s == nil || s.State != stateWorking || s.AgentPid != 100 || s.Since != 1000 {
		t.Fatalf("stored %+v", s)
	}
	if len(*pushes) != 0 {
		t.Fatalf("working must not push: %+v", *pushes)
	}
}

func TestStateDonePushesWhenNobodyAttached(t *testing.T) {
	d, pushes := fakeDeps(t, "name=work\tclients=0\n", nil)
	err := runState(args("done", "--title", "proj · done", "--body", "Finished", "--link", "tether://session/work?host=h"), d)
	if err != nil {
		t.Fatal(err)
	}
	if len(*pushes) != 1 || (*pushes)[0].collapse != "agent-work" || (*pushes)[0].content.Link != "tether://session/work?host=h" {
		t.Fatalf("pushes %+v", *pushes)
	}
	s, _ := readSession("work")
	if s == nil || s.State != stateDone || s.Message != "Finished" || s.Link != "tether://session/work?host=h" {
		t.Fatalf("stored %+v", s)
	}
}

func TestStatePushesCarryTheAgentCategory(t *testing.T) {
	for state, want := range map[string]string{"waiting": "tether.agent.waiting", "done": "tether.agent.done"} {
		d, pushes := fakeDeps(t, "name=work\tclients=0\n", nil)
		if err := runState(args(state, "--title", "t", "--body", "b"), d); err != nil {
			t.Fatal(err)
		}
		if len(*pushes) != 1 || (*pushes)[0].content.Category != want {
			t.Fatalf("%s: pushes %+v", state, *pushes)
		}
	}
}

func TestStateWaitingSkipsPushWhenAttached(t *testing.T) {
	d, pushes := fakeDeps(t, "name=work\tclients=1\n", nil)
	if err := runState(args("waiting", "--title", "t", "--body", "b"), d); err != nil {
		t.Fatal(err)
	}
	if len(*pushes) != 0 {
		t.Fatalf("attached session must not push: %+v", *pushes)
	}
}

func TestStatePushesWhenZmxLsFails(t *testing.T) {
	d, pushes := fakeDeps(t, "", errors.New("zmx: not running"))
	if err := runState(args("waiting", "--title", "t", "--body", "b"), d); err != nil {
		t.Fatal(err)
	}
	if len(*pushes) != 1 {
		t.Fatalf("a failed check must never lose a push: %+v", *pushes)
	}
}

func TestStateClearDeletesAndNeverPushes(t *testing.T) {
	d, pushes := fakeDeps(t, "name=work\tclients=0\n", nil)
	_ = runState(args("done", "--title", "t", "--body", "b"), d)
	*pushes = nil
	if err := runState(args("clear"), d); err != nil {
		t.Fatal(err)
	}
	if s, _ := readSession("work"); s != nil {
		t.Fatalf("clear left %+v", s)
	}
	if len(*pushes) != 0 {
		t.Fatalf("clear must not push")
	}
}

func TestStateUsageErrors(t *testing.T) {
	d, _ := fakeDeps(t, "", nil)
	for _, bad := range [][]string{
		{"--agent", "claude", "--state", "done"},
		{"--session", "work", "--state", "bogus"},
		{"--session", "../x", "--state", "done"},
	} {
		if err := runState(bad, d); err == nil {
			t.Errorf("expected usage error for %v", bad)
		}
	}
}

func TestStateUnwritableDirStillPushes(t *testing.T) {
	d, pushes := fakeDeps(t, "name=work\tclients=0\n", nil)
	t.Setenv("TETHER_NOTIFY_HOME", "/proc/definitely-not-writable")
	if err := runState(args("done", "--title", "t", "--body", "b"), d); err != nil {
		t.Fatalf("storage failure is not a usage error: %v", err)
	}
	if len(*pushes) != 1 {
		t.Fatalf("storage failure must not cost the push")
	}
	if !strings.Contains(d.stderr.(*bytes.Buffer).String(), "state") {
		t.Fatalf("storage failure must be reported on stderr")
	}
}

func seed(t *testing.T, states ...SessionState) {
	t.Helper()
	for i := range states {
		s := states[i]
		if err := withSessionsLock(func() error { return writeSession(&s) }); err != nil {
			t.Fatal(err)
		}
	}
}

func statusOf(t *testing.T, d statusDeps) []SessionState {
	t.Helper()
	var buf bytes.Buffer
	if err := runStatus(&buf, d); err != nil {
		t.Fatal(err)
	}
	var out []SessionState
	if err := json.Unmarshal(buf.Bytes(), &out); err != nil {
		t.Fatalf("not JSON: %q", buf.String())
	}
	return out
}

func zmxOnly(out string, err error) runner {
	return func(name string, args ...string) (string, error) { return out, err }
}

func TestStatusEmptyIsAnArray(t *testing.T) {
	t.Setenv("TETHER_NOTIFY_HOME", t.TempDir())
	var buf bytes.Buffer
	if err := runStatus(&buf, statusDeps{run: zmxOnly("", nil), alive: func(int) bool { return true }}); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(buf.String()) != "[]" {
		t.Fatalf("got %q", buf.String())
	}
}

func TestStatusPrunesDeadAgentsAndVanishedSessions(t *testing.T) {
	t.Setenv("TETHER_NOTIFY_HOME", t.TempDir())
	seed(t,
		SessionState{Session: "alive", State: stateWorking, AgentPid: 10},
		SessionState{Session: "dead", State: stateWorking, AgentPid: 20},
		SessionState{Session: "gone", State: stateDone, AgentPid: 10},
	)
	d := statusDeps{
		run:   zmxOnly("name=alive\tclients=0\nname=dead\tclients=0\n", nil),
		alive: func(pid int) bool { return pid == 10 },
	}
	out := statusOf(t, d)
	if len(out) != 1 || out[0].Session != "alive" {
		t.Fatalf("got %+v", out)
	}
	if s, _ := readSession("dead"); s != nil {
		t.Fatal("dead agent's file must be deleted")
	}
	if s, _ := readSession("gone"); s != nil {
		t.Fatal("vanished session's file must be deleted")
	}
}

func TestStatusKeepsSessionsWhenZmxLsFails(t *testing.T) {
	t.Setenv("TETHER_NOTIFY_HOME", t.TempDir())
	seed(t, SessionState{Session: "a", State: stateDone, AgentPid: 10})
	out := statusOf(t, statusDeps{run: zmxOnly("", errors.New("boom")), alive: func(int) bool { return true }})
	if len(out) != 1 {
		t.Fatalf("a failed ls must not delete anything: %+v", out)
	}
}

func TestStatusSortedBySession(t *testing.T) {
	t.Setenv("TETHER_NOTIFY_HOME", t.TempDir())
	seed(t, SessionState{Session: "b", State: stateDone}, SessionState{Session: "a", State: stateDone})
	out := statusOf(t, statusDeps{run: zmxOnly("name=a\nname=b\n", nil), alive: func(int) bool { return true }})
	if len(out) != 2 || out[0].Session != "a" || out[1].Session != "b" {
		t.Fatalf("got %+v", out)
	}
}

func TestStatusRunsZmxLsWithoutHoldingTheLock(t *testing.T) {
	t.Setenv("TETHER_NOTIFY_HOME", t.TempDir())
	seed(t, SessionState{Session: "a", State: stateDone})
	run := func(name string, args ...string) (string, error) {
		lock, err := os.OpenFile(filepath.Join(sessionsDir(), ".lock"), os.O_RDWR, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		defer lock.Close()
		if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
			t.Error("zmx ls ran under the sessions lock: a slow ls would stall every hook")
		} else {
			syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
		}
		return "name=a\n", nil
	}
	statusOf(t, statusDeps{run: run, alive: func(int) bool { return true }})
}
