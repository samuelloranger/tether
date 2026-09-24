package main

import (
	"bytes"
	"encoding/base64"
	"errors"
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
		if err := withSessionsLock(func() error { return writeSession(&next) }); err != nil {
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
