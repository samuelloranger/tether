package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"
)

type sendCall []string

func answerFixture(t *testing.T, stored *SessionState) (answerDeps, *[]sendCall, *[]time.Duration) {
	t.Helper()
	t.Setenv("TETHER_NOTIFY_HOME", t.TempDir())
	t.Setenv("TETHER_ZMX", "/fake/zmx")
	if stored != nil {
		if err := withSessionsLock(func() error { return writeSession(stored) }); err != nil {
			t.Fatal(err)
		}
	}
	var sends []sendCall
	var sleeps []time.Duration
	return answerDeps{
		run: func(name string, args ...string) (string, error) {
			sends = append(sends, append([]string{name}, args...))
			return "", nil
		},
		sleep:  func(d time.Duration) { sleeps = append(sleeps, d) },
		stderr: &bytes.Buffer{},
	}, &sends, &sleeps
}

func answerArgs(version string, input string, extra ...string) []string {
	return append([]string{"--session", "work", "--state", "waiting", "--version", version,
		"--input", base64.StdEncoding.EncodeToString([]byte(input))}, extra...)
}

var waiting = &SessionState{Session: "work", Agent: "claude", State: stateWaiting, Since: 1000, Updated: 1000, Version: "v1"}

func TestAnswerTypesTheKeysWhileThePromptIsCurrent(t *testing.T) {
	d, sends, _ := answerFixture(t, waiting)
	if err := runAnswer(answerArgs("v1", "\r"), d); err != nil {
		t.Fatal(err)
	}
	want := []sendCall{{"/fake/zmx", "send", "work", "\r"}}
	if !reflect.DeepEqual(*sends, want) {
		t.Fatalf("sends %q", *sends)
	}
}

func TestAnswerSubmitsAReplyInASecondWrite(t *testing.T) {
	d, sends, sleeps := answerFixture(t, waiting)
	if err := runAnswer(answerArgs("v1", "run the tests; rm -rf / $(x)", "--submit"), d); err != nil {
		t.Fatal(err)
	}
	want := []sendCall{
		{"/fake/zmx", "send", "work", "run the tests; rm -rf / $(x)"},
		{"/fake/zmx", "send", "work", "\r"},
	}
	if !reflect.DeepEqual(*sends, want) || len(*sleeps) != 1 {
		t.Fatalf("sends %q sleeps %v", *sends, *sleeps)
	}
}

func TestAnswerRefusesAStalePrompt(t *testing.T) {
	cases := map[string]*SessionState{
		"newer prompt, same second": {Session: "work", State: stateWaiting, Since: 1000, Version: "v2"},
		"agent working":             {Session: "work", State: stateWorking, Since: 1000, Version: "v1"},
		"no session":                nil,
	}
	for name, stored := range cases {
		d, sends, _ := answerFixture(t, stored)
		if err := runAnswer(answerArgs("v1", "\r"), d); !errors.Is(err, errStale) {
			t.Fatalf("%s: err %v", name, err)
		}
		if len(*sends) != 0 {
			t.Fatalf("%s: sent %q", name, *sends)
		}
	}
}

func TestAnswerHoldsBackReturnIfTheAgentMovedOnMeanwhile(t *testing.T) {
	d, sends, _ := answerFixture(t, waiting)
	// A hook records a new prompt while the reply waits to press Return.
	d.sleep = func(time.Duration) {
		next := *waiting
		next.Version = "v2"
		if err := withSessionLock("work", func() error { return writeSession(&next) }); err != nil {
			t.Fatal(err)
		}
	}
	if err := runAnswer(answerArgs("v1", "yes", "--submit"), d); !errors.Is(err, errNotSubmitted) {
		t.Fatalf("err %v", err)
	}
	if len(*sends) != 1 {
		t.Fatalf("Return was pressed: %q", *sends)
	}
}

func TestAnswerHoldsOnlyItsOwnSessionsLock(t *testing.T) {
	d, _, _ := answerFixture(t, waiting)
	other := make(chan error, 1)
	d.run = func(name string, args ...string) (string, error) {
		// While typing into "work", a hook for another session must still get through.
		go func() {
			other <- withSessionLock("elsewhere", func() error { return withSessionsLock(func() error { return nil }) })
		}()
		select {
		case err := <-other:
			return "", err
		case <-time.After(time.Second):
			return "", errors.New("another session's hook was blocked")
		}
	}
	if err := runAnswer(answerArgs("v1", "\r"), d); err != nil {
		t.Fatal(err)
	}
}

func TestSessionLocksAreAFixedSetOfFiles(t *testing.T) {
	t.Setenv("TETHER_NOTIFY_HOME", t.TempDir())
	paths := map[string]bool{}
	for i := 0; i < 500; i++ {
		name := fmt.Sprintf("s%d", i)
		if err := withSessionLock(name, func() error { return nil }); err != nil {
			t.Fatal(err)
		}
		paths[sessionLockPath(name)] = true
	}
	entries, _ := os.ReadDir(sessionsDir())
	if len(paths) > sessionLockStripes || len(entries) > sessionLockStripes {
		t.Fatalf("%d lock paths, %d files for 500 sessions", len(paths), len(entries))
	}
}

func TestStatusPrunesUnderTheSessionLock(t *testing.T) {
	d, _, _ := answerFixture(t, waiting)
	pruned := make(chan error, 1)
	held := make(chan struct{})
	release := make(chan struct{})
	go func() {
		_ = withSessionLock("work", func() error { close(held); <-release; return nil })
	}()
	<-held
	go func() {
		// The session's zmx process is gone: status would prune it.
		pruned <- runStatus(&bytes.Buffer{}, statusDeps{run: d.run, alive: func(int) bool { return false }})
	}()
	select {
	case <-pruned:
		t.Fatal("status pruned a session while its lock was held")
	case <-time.After(200 * time.Millisecond):
	}
	close(release)
	if err := <-pruned; err != nil {
		t.Fatal(err)
	}
	if s, _ := readSession("work"); s != nil {
		t.Fatalf("not pruned after the lock was released: %+v", s)
	}
}

func TestStatusKeepsARecordWrittenAfterItJudgedTheSession(t *testing.T) {
	t.Run("new state", func(t *testing.T) {
		keepsRewrite(t, func(s *SessionState) { s.Version, s.Updated = "v2", 2000 })
	})
	// A repeated `working` hook within the same second writes the same version and time.
	t.Run("same fields", func(t *testing.T) { keepsRewrite(t, func(*SessionState) {}) })
}

func keepsRewrite(t *testing.T, change func(*SessionState)) {
	answerFixture(t, waiting)
	held := make(chan struct{})
	release := make(chan struct{})
	go func() {
		_ = withSessionLock("work", func() error { close(held); <-release; return nil })
	}()
	<-held
	done := make(chan error, 1)
	go func() {
		// zmx no longer lists "work": status judges the current record stale.
		done <- runStatus(&bytes.Buffer{}, statusDeps{
			run:   func(string, ...string) (string, error) { return "", nil },
			alive: func(int) bool { return true },
		})
	}()
	time.Sleep(100 * time.Millisecond)
	// Meanwhile the session comes back and its hook records a new state.
	next := *waiting
	change(&next)
	if err := withSessionsLock(func() error { return writeSession(&next) }); err != nil {
		t.Fatal(err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if s, _ := readSession("work"); s == nil || s.Revision != next.Revision {
		t.Fatalf("the newer record was pruned: %+v", s)
	}
}

func TestAnswerRejectsFlagLikeSessionsAndBadInput(t *testing.T) {
	d, sends, _ := answerFixture(t, waiting)
	bad := [][]string{
		{"--session", "--help", "--state", "waiting", "--version", "v1", "--input", "DQ=="},
		{"--session", "-h", "--state", "waiting", "--version", "v1", "--input", "DQ=="},
		{"--session", "work", "--state", "waiting", "--version", "v1", "--input", "!!"},
		{"--session", "work", "--state", "waiting", "--version", "v1", "--input", ""},
		{"--session", "work", "--state", "bogus", "--version", "v1", "--input", "DQ=="},
		{"--session", "work", "--state", "waiting", "--version", "", "--input", "DQ=="},
	}
	for _, args := range bad {
		if err := runAnswer(args, d); err == nil || errors.Is(err, errStale) {
			t.Fatalf("%q: err %v", args, err)
		}
	}
	if len(*sends) != 0 {
		t.Fatalf("sent %q", *sends)
	}
}
