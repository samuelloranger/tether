package main

import (
	"bytes"
	"errors"
	"strings"
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
