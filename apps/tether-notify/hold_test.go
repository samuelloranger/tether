package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type pushed struct {
	content  PushContent
	collapse string
}

func holdFixture(t *testing.T, zmxLs string, zmxErr error) (holdDeps, *[]pushed, *bytes.Buffer) {
	t.Helper()
	t.Setenv("TETHER_NOTIFY_HOME", t.TempDir())
	t.Setenv("TETHER_ZMX", "/fake/zmx")
	if err := os.WriteFile(hostLabelPath(), []byte("devbox\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var pushes []pushed
	out := &bytes.Buffer{}
	return holdDeps{
		run: func(name string, args ...string) (string, error) {
			if name == "/fake/zmx" {
				return zmxLs, zmxErr
			}
			return "", errors.New("unexpected " + name)
		},
		now:    func() time.Time { return time.Unix(5000, 0) },
		cwd:    func() (string, error) { return "/src/project", nil },
		push:   func(c PushContent, col string) error { pushes = append(pushes, pushed{c, col}); return nil },
		stdout: out,
		stderr: &bytes.Buffer{},
	}, &pushes, out
}

var holdArgs = []string{"--session", "work", "--kind", "permission", "--tool", "Bash", "--body", "Allow Bash: npm test?"}

func TestHoldRecordsAndPushesWhenNobodyIsAttached(t *testing.T) {
	d, pushes, out := holdFixture(t, "name=work\tclients=0\n", nil)
	if err := runHold(holdArgs, d); err != nil {
		t.Fatal(err)
	}
	s, err := readSession("work")
	if err != nil || s == nil {
		t.Fatalf("record %v %v", s, err)
	}
	if s.State != stateWaiting || s.Pending == nil || s.Pending.Kind != "permission" || s.Pending.Tool != "Bash" {
		t.Fatalf("record %+v pending %+v", s, s.Pending)
	}
	if got := strings.TrimSpace(out.String()); got != s.Version || got == "" {
		t.Fatalf("printed %q, stored %q", got, s.Version)
	}
	if len(*pushes) != 1 {
		t.Fatalf("pushes %+v", *pushes)
	}
	p := (*pushes)[0]
	want := PushContent{
		Title: "project · needs you", Body: "Allow Bash: npm test?",
		Link:     "tether://session/work?host=devbox",
		Category: "tether.agent.waiting", State: stateWaiting, Version: s.Version,
		Session: "work", Level: "urgent",
	}
	if !reflect.DeepEqual(p.content, want) || p.collapse != "agent-work" {
		t.Fatalf("push %+v %q", p.content, p.collapse)
	}
}

func TestHoldRefusesWhenAClientIsAttached(t *testing.T) {
	d, pushes, out := holdFixture(t, "name=work\tclients=1\n", nil)
	if err := runHold(holdArgs, d); !errors.Is(err, errNotHeld) {
		t.Fatalf("err %v", err)
	}
	if s, _ := readSession("work"); s != nil || len(*pushes) != 0 || out.Len() != 0 {
		t.Fatalf("record %+v pushes %+v out %q", s, *pushes, out)
	}
}

func TestHoldRefusesWhenZmxCannotSay(t *testing.T) {
	d, pushes, _ := holdFixture(t, "", errors.New("zmx: no such file"))
	if err := runHold(holdArgs, d); !errors.Is(err, errNotHeld) {
		t.Fatalf("err %v", err)
	}
	if len(*pushes) != 0 {
		t.Fatalf("pushes %+v", *pushes)
	}
}

func TestHoldRefusesWithoutAHostLabel(t *testing.T) {
	d, pushes, _ := holdFixture(t, "name=work\tclients=0\n", nil)
	if err := os.Remove(hostLabelPath()); err != nil {
		t.Fatal(err)
	}
	if err := runHold(holdArgs, d); !errors.Is(err, errNotHeld) {
		t.Fatalf("err %v", err)
	}
	if s, _ := readSession("work"); s != nil || len(*pushes) != 0 {
		t.Fatalf("record %+v pushes %+v", s, *pushes)
	}
}

func TestHoldUndoesItselfWhenThePushFails(t *testing.T) {
	d, _, out := holdFixture(t, "name=work\tclients=0\n", nil)
	d.push = func(PushContent, string) error { return errors.New("no registered devices") }
	if err := runHold(holdArgs, d); !errors.Is(err, errNotHeld) {
		t.Fatalf("err %v", err)
	}
	if s, _ := readSession("work"); s == nil || s.Pending != nil {
		t.Fatalf("record %+v", s)
	}
	if out.Len() != 0 {
		t.Fatalf("printed %q", out)
	}
}

func TestHoldRejectsUsageMistakes(t *testing.T) {
	cases := map[string][]string{
		"no session":   {"--kind", "permission", "--body", "x"},
		"other kind":   {"--session", "work", "--kind", "question", "--body", "x"},
		"no body":      {"--session", "work", "--kind", "permission"},
		"session path": {"--session", "a/b", "--kind", "permission", "--body", "x"},
	}
	for name, args := range cases {
		d, _, _ := holdFixture(t, "name=work\tclients=0\n", nil)
		if err := runHold(args, d); err == nil || errors.Is(err, errNotHeld) {
			t.Fatalf("%s: err %v", name, err)
		}
	}
}

func TestHostLabelPathLivesInTheNotifyHome(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TETHER_NOTIFY_HOME", dir)
	if hostLabelPath() != filepath.Join(dir, "host-label") {
		t.Fatal(hostLabelPath())
	}
}

const oneQuestion = `[{"question":"Which DB?","header":"DB","multiSelect":false,"options":[{"label":"Postgres","description":"server"},{"label":"SQLite"}]}]`

var questionArgs = []string{"--session", "work", "--kind", "question", "--tool", "AskUserQuestion",
	"--body", "Which DB?", "--questions-stdin"}

func TestHoldQuestionStoresTheQuestionsAndPushesTheQuestionCategory(t *testing.T) {
	d, pushes, out := holdFixture(t, "name=work\tclients=0\n", nil)
	d.stdin = strings.NewReader(oneQuestion)
	if err := runHold(questionArgs, d); err != nil {
		t.Fatal(err)
	}
	s, _ := readSession("work")
	want := &Pending{Kind: "question", Tool: "AskUserQuestion", Questions: []Question{{
		Question: "Which DB?", Header: "DB",
		Options: []QuestionOption{{Label: "Postgres", Description: "server"}, {Label: "SQLite"}},
	}}}
	if s == nil || s.State != stateWaiting || !reflect.DeepEqual(s.Pending, want) {
		t.Fatalf("record %+v pending %+v", s, s.Pending)
	}
	if strings.TrimSpace(out.String()) != s.Version {
		t.Fatalf("printed %q", out)
	}
	p := (*pushes)[0].content
	if p.Category != "tether.agent.question" || p.State != stateWaiting || p.Version != s.Version ||
		!reflect.DeepEqual(p.Options, []string{"Postgres", "SQLite"}) || p.Body != "Which DB?" {
		t.Fatalf("push %+v", p)
	}
}

func TestHoldQuestionOffersOptionsOnlyForOneSingleChoice(t *testing.T) {
	five := `[{"question":"Q?","header":"H","multiSelect":false,"options":[{"label":"a"},{"label":"b"},{"label":"c"},{"label":"d"},{"label":"e"}]}]`
	cases := map[string]string{
		"multi-select":  `[{"question":"Q?","header":"H","multiSelect":true,"options":[{"label":"a"},{"label":"b"}]}]`,
		"two questions": `[{"question":"Q1?","header":"H","multiSelect":false,"options":[{"label":"a"},{"label":"b"}]},{"question":"Q2?","header":"H","multiSelect":false,"options":[{"label":"c"},{"label":"d"}]}]`,
		"five options":  five,
	}
	for name, qs := range cases {
		d, pushes, _ := holdFixture(t, "name=work\tclients=0\n", nil)
		d.stdin = strings.NewReader(qs)
		if err := runHold(questionArgs, d); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if p := (*pushes)[0].content; p.Options != nil || p.Category != "tether.agent.question" {
			t.Fatalf("%s: push %+v", name, p)
		}
	}
}

func TestHoldQuestionNeedsQuestions(t *testing.T) {
	cases := map[string]string{
		"empty":          "",
		"not json":       "nope",
		"no questions":   "[]",
		"no options":     `[{"question":"Q?","header":"H","multiSelect":false,"options":[]}]`,
		"empty label":    `[{"question":"Q?","header":"H","multiSelect":false,"options":[{"label":""},{"label":"b"}]}]`,
		"empty question": `[{"question":"","header":"H","multiSelect":false,"options":[{"label":"a"}]}]`,
	}
	for name, qs := range cases {
		d, pushes, _ := holdFixture(t, "name=work\tclients=0\n", nil)
		d.stdin = strings.NewReader(qs)
		err := runHold(questionArgs, d)
		if err == nil || errors.Is(err, errNotHeld) {
			t.Fatalf("%s: err %v", name, err)
		}
		if len(*pushes) != 0 {
			t.Fatalf("%s: pushed", name)
		}
	}
}

// A question also shows Claude's own dialog, so it is recorded whoever is attached; the
// phone is only pushed when nobody is.
func TestHoldQuestionWhileAttachedRecordsWithoutPushing(t *testing.T) {
	d, pushes, out := holdFixture(t, "name=work\tclients=1\n", nil)
	d.stdin = strings.NewReader(oneQuestion)
	if err := runHold(questionArgs, d); err != nil {
		t.Fatal(err)
	}
	s, _ := readSession("work")
	if s == nil || s.Pending == nil || s.Pending.Kind != "question" || strings.TrimSpace(out.String()) != s.Version {
		t.Fatalf("record %+v out %q", s, out)
	}
	if len(*pushes) != 0 {
		t.Fatalf("pushed while attached: %+v", *pushes)
	}
}

func TestHoldQuestionWithoutAHostLabelRecordsWithoutPushing(t *testing.T) {
	d, pushes, _ := holdFixture(t, "name=work\tclients=0\n", nil)
	if err := os.Remove(hostLabelPath()); err != nil {
		t.Fatal(err)
	}
	d.stdin = strings.NewReader(oneQuestion)
	if err := runHold(questionArgs, d); err != nil {
		t.Fatal(err)
	}
	if s, _ := readSession("work"); s == nil || s.Pending == nil {
		t.Fatalf("record %+v", s)
	}
	if len(*pushes) != 0 {
		t.Fatalf("pushes %+v", *pushes)
	}
}

func TestHoldQuestionKeepsItsRecordWhenThePushFails(t *testing.T) {
	d, _, out := holdFixture(t, "name=work\tclients=0\n", nil)
	d.push = func(PushContent, string) error { return errors.New("no registered devices") }
	d.stdin = strings.NewReader(oneQuestion)
	if err := runHold(questionArgs, d); err != nil {
		t.Fatal(err)
	}
	if s, _ := readSession("work"); s == nil || s.Pending == nil || strings.TrimSpace(out.String()) != s.Version {
		t.Fatalf("record %+v out %q", s, out)
	}
}
