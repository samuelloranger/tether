package main

import (
	"bytes"
	"encoding/json"
	"os"
	"strconv"
	"syscall"
	"testing"
	"time"
)

var held = &SessionState{
	Session: "work", Agent: "claude", State: stateWaiting, Since: 1000, Updated: 1000, Version: "v1",
	Pending: &Pending{Kind: "permission", Tool: "Bash"},
}

type waitWorld struct {
	deps    waitDeps
	out     *bytes.Buffer
	clients *int
	parent  *int
	signals chan os.Signal
	onSleep *func(int)
}

func waitFixture(t *testing.T, stored *SessionState) waitWorld {
	t.Helper()
	t.Setenv("TETHER_NOTIFY_HOME", t.TempDir())
	t.Setenv("TETHER_ZMX", "/fake/zmx")
	if stored != nil {
		rec := *stored
		if stored.Pending != nil {
			p := *stored.Pending
			rec.Pending = &p
		}
		if err := withSessionsLock(func() error { return writeSession(&rec) }); err != nil {
			t.Fatal(err)
		}
	}
	clients, parent := 0, 42
	sleeps := 0
	var onSleep func(int)
	signals := make(chan os.Signal, 1)
	out := &bytes.Buffer{}
	w := waitWorld{out: out, clients: &clients, parent: &parent, signals: signals, onSleep: &onSleep}
	w.deps = waitDeps{
		run: func(name string, args ...string) (string, error) {
			return "name=work\tclients=" + strconv.Itoa(clients) + "\n", nil
		},
		sleep: func(time.Duration) {
			sleeps++
			if sleeps > 50 {
				t.Fatal("wait never returned")
			}
			if onSleep != nil {
				onSleep(sleeps)
			}
		},
		ppid:    func() int { return parent },
		pid:     777,
		signals: signals,
		stdout:  out,
		stderr:  &bytes.Buffer{},
	}
	return w
}

func result(t *testing.T, out *bytes.Buffer) waitResult {
	t.Helper()
	var r waitResult
	if err := json.Unmarshal(bytes.TrimSpace(out.Bytes()), &r); err != nil {
		t.Fatalf("output %q: %v", out, err)
	}
	return r
}

var waitArgs = []string{"--session", "work", "--version", "v1"}

func TestWaitClaimsTheRequest(t *testing.T) {
	w := waitFixture(t, held)
	*w.onSleep = func(n int) {
		s, _ := readSession("work")
		if s.Pending == nil || s.Pending.WaiterPid != 777 {
			t.Fatalf("pending %+v", s.Pending)
		}
		_ = writeAnswer("work", heldAnswer{Version: "v1", Action: "deny"})
	}
	if err := runWait(waitArgs, w.deps); err != nil {
		t.Fatal(err)
	}
	if r := result(t, w.out); r.Action != "deny" {
		t.Fatalf("result %+v", r)
	}
}

func TestWaitApproveMovesTheRecordOn(t *testing.T) {
	w := waitFixture(t, held)
	*w.onSleep = func(int) { _ = writeAnswer("work", heldAnswer{Version: "v1", Action: "approve"}) }
	if err := runWait(waitArgs, w.deps); err != nil {
		t.Fatal(err)
	}
	if r := result(t, w.out); r.Action != "approve" || r.Release != "" {
		t.Fatalf("result %+v", r)
	}
	s, _ := readSession("work")
	if s.State != stateWorking || s.Version == "v1" || s.Pending != nil {
		t.Fatalf("record %+v", s)
	}
	if _, err := os.Stat(answerPath("work")); !os.IsNotExist(err) {
		t.Fatalf("answer file left behind: %v", err)
	}
}

func TestWaitPassesAReplyThrough(t *testing.T) {
	w := waitFixture(t, held)
	*w.onSleep = func(int) {
		_ = writeAnswer("work", heldAnswer{Version: "v1", Action: "reply", Text: "use pnpm instead"})
	}
	if err := runWait(waitArgs, w.deps); err != nil {
		t.Fatal(err)
	}
	if r := result(t, w.out); r.Action != "reply" || r.Text != "use pnpm instead" {
		t.Fatalf("result %+v", r)
	}
}

func TestWaitIgnoresAnAnswerForAnotherVersion(t *testing.T) {
	w := waitFixture(t, held)
	*w.onSleep = func(n int) {
		if n == 1 {
			_ = writeAnswer("work", heldAnswer{Version: "v0", Action: "approve"})
		}
		if n == 3 {
			_ = writeAnswer("work", heldAnswer{Version: "v1", Action: "deny"})
		}
	}
	if err := runWait(waitArgs, w.deps); err != nil {
		t.Fatal(err)
	}
	if r := result(t, w.out); r.Action != "deny" {
		t.Fatalf("result %+v", r)
	}
}

func TestWaitIsStaleWhenNothingIsHeld(t *testing.T) {
	cases := map[string]*SessionState{
		"no record":     nil,
		"other version": {Session: "work", State: stateWaiting, Version: "v2", Pending: &Pending{Kind: "permission"}},
		"not held":      {Session: "work", State: stateWaiting, Version: "v1"},
	}
	for name, stored := range cases {
		w := waitFixture(t, stored)
		if err := runWait(waitArgs, w.deps); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if r := result(t, w.out); r.Release != "stale" {
			t.Fatalf("%s: result %+v", name, r)
		}
	}
}

func TestWaitReleasesWhenTheVersionMoves(t *testing.T) {
	w := waitFixture(t, held)
	*w.onSleep = func(int) {
		_ = withSessionsLock(func() error {
			return writeSession(&SessionState{Session: "work", State: stateWaiting, Version: "v2",
				Pending: &Pending{Kind: "permission"}})
		})
	}
	if err := runWait(waitArgs, w.deps); err != nil {
		t.Fatal(err)
	}
	if r := result(t, w.out); r.Release != "stale" {
		t.Fatalf("result %+v", r)
	}
	if s, _ := readSession("work"); s.Version != "v2" || s.Pending == nil {
		t.Fatalf("the newer hold was touched: %+v", s)
	}
}

func TestWaitReleasesWhenAClientAttaches(t *testing.T) {
	w := waitFixture(t, held)
	*w.onSleep = func(int) { *w.clients = 1 }
	if err := runWait(waitArgs, w.deps); err != nil {
		t.Fatal(err)
	}
	if r := result(t, w.out); r.Release != "attached" {
		t.Fatalf("result %+v", r)
	}
	s, _ := readSession("work")
	if s.Pending != nil || s.State != stateWaiting || s.Version != "v1" {
		t.Fatalf("record %+v", s)
	}
}

func TestWaitSignalLeavesTheRequestForAnswerToRefuse(t *testing.T) {
	w := waitFixture(t, held)
	*w.onSleep = func(int) { w.signals <- syscall.SIGTERM }
	if err := runWait(waitArgs, w.deps); err == nil {
		t.Fatal("expected an error")
	}
	if w.out.Len() != 0 {
		t.Fatalf("printed %q", w.out)
	}
	if s, _ := readSession("work"); s.Pending == nil || s.Pending.WaiterPid != 777 {
		t.Fatalf("record %+v", s)
	}
}

func TestWaitExitsWhenItsParentDies(t *testing.T) {
	w := waitFixture(t, held)
	*w.onSleep = func(int) { *w.parent = 1 }
	if err := runWait(waitArgs, w.deps); err == nil {
		t.Fatal("expected an error")
	}
	if w.out.Len() != 0 {
		t.Fatalf("printed %q", w.out)
	}
}

func TestWaitRejectsUsageMistakes(t *testing.T) {
	for _, args := range [][]string{{"--session", "work"}, {"--version", "v1"}, {"--session", "../x", "--version", "v1"}} {
		w := waitFixture(t, nil)
		if err := runWait(args, w.deps); err == nil {
			t.Fatalf("%v: no error", args)
		}
	}
}
