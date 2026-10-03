package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

func pendingFixture(t *testing.T, stored *SessionState) (pendingDeps, *bytes.Buffer) {
	t.Helper()
	t.Setenv("TETHER_NOTIFY_HOME", t.TempDir())
	if stored != nil {
		if err := withSessionsLock(func() error { return writeSession(stored) }); err != nil {
			t.Fatal(err)
		}
	}
	out := &bytes.Buffer{}
	return pendingDeps{alive: func(pid int) bool { return pid == 777 }, stdout: out, stderr: &bytes.Buffer{}}, out
}

func TestPendingPrintsTheHeldQuestions(t *testing.T) {
	d, out := pendingFixture(t, heldTwoQuestions)
	if err := runPending([]string{"--session", "work"}, d); err != nil {
		t.Fatal(err)
	}
	var got pendingQuestions
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("%q: %v", out, err)
	}
	want := pendingQuestions{Session: "work", State: stateWaiting, Version: "v1", Kind: "question",
		Questions: heldTwoQuestions.Pending.Questions}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
}

func TestPendingIsStaleWithoutALiveQuestionHold(t *testing.T) {
	dead := *heldQuestion
	dead.Pending = &Pending{Kind: "question", WaiterPid: 999, Questions: heldQuestion.Pending.Questions}
	cases := map[string]*SessionState{
		"no record":   nil,
		"permission":  heldBy777,
		"not held":    waiting,
		"dead waiter": &dead,
	}
	for name, stored := range cases {
		d, out := pendingFixture(t, stored)
		if err := runPending([]string{"--session", "work"}, d); !errors.Is(err, errStale) {
			t.Fatalf("%s: err %v", name, err)
		}
		if out.Len() != 0 {
			t.Fatalf("%s: printed %q", name, out)
		}
	}
}
