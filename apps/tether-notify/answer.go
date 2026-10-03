package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

var (
	errStale        = errors.New("stale")
	errNotSubmitted = errors.New("not submitted")
)

type answerDeps struct {
	run    runner
	sleep  func(time.Duration)
	alive  func(int) bool
	stderr io.Writer
}

func defaultAnswerDeps() answerDeps {
	return answerDeps{run: execRunner, sleep: time.Sleep, alive: pidAlive, stderr: os.Stderr}
}

// runAnswer types a notification action's input into a session, but only while the
// session's agent is still in the state the push was about: an Approve left on the
// lock screen must not answer a newer prompt. Each check and its send hold that session's
// lock, so its hook can't record a new state in between; other sessions aren't held up.
// A request the Claude Code mod holds gets its decision through the answer file instead.
func runAnswer(args []string, d answerDeps) error {
	fs := flag.NewFlagSet("answer", flag.ContinueOnError)
	fs.SetOutput(d.stderr)
	session := fs.String("session", "", "zmx session name")
	state := fs.String("state", "", "agent state the push was about")
	version := fs.String("version", "", "state version the push was about")
	input := fs.String("input", "", "base64 bytes to type")
	submit := fs.Bool("submit", false, "press Return after the input, in a separate write")
	option := fs.Int("option", 0, "a held question's option, 1-based")
	answersFlag := fs.String("answers", "", "base64 JSON object: a held question's answers by question")
	if err := fs.Parse(args); err != nil {
		return err
	}
	given := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { given[f.Name] = true })
	// A leading '-' would reach zmx as a flag rather than a session name.
	if !validSessionName(*session) || strings.HasPrefix(*session, "-") {
		return fmt.Errorf("answer requires a valid --session")
	}
	if !validState(*state) || *version == "" {
		return fmt.Errorf("answer requires --state and --version")
	}
	if n := btoi(given["input"]) + btoi(given["option"]) + btoi(given["answers"]); n != 1 {
		return fmt.Errorf("answer requires one of --input, --option or --answers")
	}
	choice := heldChoice{submit: *submit}
	switch {
	case given["input"]:
		b, err := base64.StdEncoding.DecodeString(*input)
		if err != nil || len(b) == 0 {
			return fmt.Errorf("answer requires base64 --input")
		}
		choice.input = b
	case given["option"]:
		choice.option = *option
		choice.hasOption = true
	case given["answers"]:
		raw, err := base64.StdEncoding.DecodeString(*answersFlag)
		if err != nil || json.Unmarshal(raw, &choice.answers) != nil {
			return fmt.Errorf("answer requires --answers as base64 JSON")
		}
		choice.hasAnswers = true
	}
	bytes := choice.input

	current := func() (*SessionState, error) {
		s, err := readSession(*session)
		if err != nil {
			return nil, err
		}
		if s == nil || s.State != *state || s.Version != *version {
			return nil, errStale
		}
		return s, nil
	}
	send := func(text string) error {
		if _, err := d.run(zmxPath(), "send", *session, text); err != nil {
			return fmt.Errorf("zmx send: %w", err)
		}
		return nil
	}

	held := false
	if err := withSessionLock(*session, func() error {
		s, err := current()
		if err != nil {
			return err
		}
		if s.Pending != nil {
			held = true
			return answerHeld(s, choice, d.alive)
		}
		// An option or answers only ever decide a held question; never type them.
		if choice.input == nil {
			return errStale
		}
		return send(string(bytes))
	}); err != nil {
		return err
	}
	if held || !*submit {
		return nil
	}
	// A TUI that reads text and Return together can take them as a paste. The wait is
	// outside the lock; the state is checked again before Return is pressed.
	d.sleep(300 * time.Millisecond)
	err := withSessionLock(*session, func() error {
		if _, err := current(); err != nil {
			return err
		}
		return send("\r")
	})
	if errors.Is(err, errStale) {
		return errNotSubmitted
	}
	return err
}

type heldChoice struct {
	input      []byte
	submit     bool
	option     int
	hasOption  bool
	answers    map[string]string
	hasAnswers bool
}

func btoi(b bool) int {
	if b {
		return 1
	}
	return 0
}

// answerHeld gives a request the mod holds its decision instead of typing it. For a
// permission, Return is Approve, Esc is Deny and a submitted line is a reply; a question
// takes an option or answers. A waiter that is gone (Esc, a crash) means nothing will
// read it, so the tap is refused as stale.
func answerHeld(s *SessionState, c heldChoice, alive func(int) bool) error {
	if s.Pending.WaiterPid <= 0 || !alive(s.Pending.WaiterPid) {
		return errStale
	}
	a := heldAnswer{Version: s.Version}
	if s.Pending.Kind == "question" {
		answers, err := questionAnswers(s.Pending.Questions, c)
		if err != nil {
			return err
		}
		a.Action, a.Answers = "answers", answers
		return writeAnswer(s.Session, a)
	}
	switch {
	case c.hasOption || c.hasAnswers:
		return fmt.Errorf("a held permission takes Approve, Deny or a reply")
	case c.submit:
		a.Action, a.Text = "reply", string(c.input)
	case string(c.input) == "\r":
		a.Action = "approve"
	case string(c.input) == "\x1b":
		a.Action = "deny"
	default:
		return fmt.Errorf("a held request takes Approve, Deny or a reply")
	}
	return writeAnswer(s.Session, a)
}

func questionAnswers(questions []Question, c heldChoice) (map[string]string, error) {
	switch {
	case c.hasOption:
		if len(questions) != 1 || questions[0].MultiSelect {
			return nil, fmt.Errorf("--option answers one single-choice question only")
		}
		q := questions[0]
		if c.option < 1 || c.option > len(q.Options) {
			return nil, fmt.Errorf("--option %d is not one of the question's %d options", c.option, len(q.Options))
		}
		return map[string]string{q.Question: q.Options[c.option-1].Label}, nil
	case c.hasAnswers:
		if len(c.answers) == 0 {
			return nil, fmt.Errorf("--answers is empty")
		}
		asked := map[string]bool{}
		for _, q := range questions {
			asked[q.Question] = true
		}
		for question, answer := range c.answers {
			if !asked[question] || answer == "" {
				return nil, fmt.Errorf("--answers must answer the held questions")
			}
		}
		return c.answers, nil
	}
	return nil, fmt.Errorf("a held question takes an option or answers")
}
