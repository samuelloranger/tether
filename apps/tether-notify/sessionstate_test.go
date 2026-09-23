package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestValidSessionName(t *testing.T) {
	for _, ok := range []string{"default", "App terminal ssh", "proj-2", "a.b"} {
		if !validSessionName(ok) {
			t.Errorf("%q should be valid", ok)
		}
	}
	for _, bad := range []string{"", ".", "..", "a/b", "../x", "a\x00b"} {
		if validSessionName(bad) {
			t.Errorf("%q should be rejected", bad)
		}
	}
}

func TestNextStateNewStateStartsNow(t *testing.T) {
	got := nextState(nil, SessionState{Session: "s", Agent: "claude", State: stateWorking, AgentPid: 42}, 100)
	if got == nil || got.Since != 100 || got.Updated != 100 || got.AgentPid != 42 {
		t.Fatalf("got %+v", got)
	}
}

func TestNextStateRepeatedWorkingOnlyTouchesUpdated(t *testing.T) {
	prev := &SessionState{Session: "s", Agent: "claude", State: stateWorking, Since: 100, Updated: 100, Message: "m", AgentPid: 42}
	got := nextState(prev, SessionState{Session: "s", Agent: "claude", State: stateWorking, AgentPid: 43}, 160)
	want := SessionState{Session: "s", Agent: "claude", State: stateWorking, Since: 100, Updated: 160, Message: "m", AgentPid: 43}
	if got == nil || *got != want {
		t.Fatalf("got %+v want %+v", got, want)
	}
}

func TestNextStateChangeResetsSince(t *testing.T) {
	prev := &SessionState{Session: "s", Agent: "claude", State: stateWorking, Since: 100, Updated: 150, AgentPid: 42}
	got := nextState(prev, SessionState{Session: "s", Agent: "claude", State: stateDone, Message: "finished"}, 200)
	if got == nil || got.State != stateDone || got.Since != 200 || got.Message != "finished" || got.AgentPid != 42 {
		t.Fatalf("got %+v", got)
	}
}

func TestNextStateClearDeletes(t *testing.T) {
	prev := &SessionState{Session: "s", State: stateDone}
	if got := nextState(prev, SessionState{Session: "s", State: stateClear}, 1); got != nil {
		t.Fatalf("clear must delete, got %+v", got)
	}
}

func TestWriteReadListRemoveRoundTrip(t *testing.T) {
	t.Setenv("TETHER_NOTIFY_HOME", t.TempDir())
	s := &SessionState{Session: "App terminal ssh", Agent: "codex", State: stateWaiting, Since: 1, Updated: 2, Message: "Allow?", Link: "tether://session/x?host=h", AgentPid: 7}
	if err := withSessionsLock(func() error { return writeSession(s) }); err != nil {
		t.Fatal(err)
	}
	got, err := readSession("App terminal ssh")
	if err != nil || got == nil || *got != *s {
		t.Fatalf("read %+v err %v", got, err)
	}
	all, err := listSessions()
	if err != nil || len(all) != 1 || all[0] != *s {
		t.Fatalf("list %+v err %v", all, err)
	}
	if err := removeSession("App terminal ssh"); err != nil {
		t.Fatal(err)
	}
	if err := removeSession("App terminal ssh"); err != nil {
		t.Fatalf("removing a missing session must not fail: %v", err)
	}
	if got, _ := readSession("App terminal ssh"); got != nil {
		t.Fatalf("still there: %+v", got)
	}
}

func TestStoreModes(t *testing.T) {
	t.Setenv("TETHER_NOTIFY_HOME", t.TempDir())
	if err := withSessionsLock(func() error { return writeSession(&SessionState{Session: "s", State: stateDone}) }); err != nil {
		t.Fatal(err)
	}
	dir, _ := os.Stat(sessionsDir())
	file, _ := os.Stat(filepath.Join(sessionsDir(), "s.json"))
	if dir.Mode().Perm() != 0o700 || file.Mode().Perm() != 0o600 {
		t.Fatalf("modes dir=%v file=%v", dir.Mode().Perm(), file.Mode().Perm())
	}
}

func TestListSkipsCorruptFilesAndLock(t *testing.T) {
	t.Setenv("TETHER_NOTIFY_HOME", t.TempDir())
	if err := withSessionsLock(func() error { return writeSession(&SessionState{Session: "ok", State: stateDone}) }); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sessionsDir(), "bad.json"), []byte("{nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	all, err := listSessions()
	if err != nil || len(all) != 1 || all[0].Session != "ok" {
		t.Fatalf("list %+v err %v", all, err)
	}
}

func TestWriteRejectsBadName(t *testing.T) {
	t.Setenv("TETHER_NOTIFY_HOME", t.TempDir())
	if err := writeSession(&SessionState{Session: "../escape", State: stateDone}); err == nil {
		t.Fatal("expected an error for a path-escaping name")
	}
}
