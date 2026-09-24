package main

import (
	"encoding/base64"
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
	stderr io.Writer
}

func defaultAnswerDeps() answerDeps {
	return answerDeps{run: execRunner, sleep: time.Sleep, stderr: os.Stderr}
}

// runAnswer types a notification action's input into a session, but only while the
// session's agent is still in the state the push was about: an Approve left on the
// lock screen must not answer a newer prompt. Each check and its send hold that session's
// lock, so its hook can't record a new state in between; other sessions aren't held up.
func runAnswer(args []string, d answerDeps) error {
	fs := flag.NewFlagSet("answer", flag.ContinueOnError)
	fs.SetOutput(d.stderr)
	session := fs.String("session", "", "zmx session name")
	state := fs.String("state", "", "agent state the push was about")
	version := fs.String("version", "", "state version the push was about")
	input := fs.String("input", "", "base64 bytes to type")
	submit := fs.Bool("submit", false, "press Return after the input, in a separate write")
	if err := fs.Parse(args); err != nil {
		return err
	}
	// A leading '-' would reach zmx as a flag rather than a session name.
	if !validSessionName(*session) || strings.HasPrefix(*session, "-") {
		return fmt.Errorf("answer requires a valid --session")
	}
	if !validState(*state) || *version == "" {
		return fmt.Errorf("answer requires --state and --version")
	}
	bytes, err := base64.StdEncoding.DecodeString(*input)
	if err != nil || len(bytes) == 0 {
		return fmt.Errorf("answer requires base64 --input")
	}

	current := func() error {
		s, err := readSession(*session)
		if err != nil {
			return err
		}
		if s == nil || s.State != *state || s.Version != *version {
			return errStale
		}
		return nil
	}
	send := func(text string) error {
		if _, err := d.run(zmxPath(), "send", *session, text); err != nil {
			return fmt.Errorf("zmx send: %w", err)
		}
		return nil
	}

	if err := withSessionLock(*session, func() error {
		if err := current(); err != nil {
			return err
		}
		return send(string(bytes))
	}); err != nil {
		return err
	}
	if !*submit {
		return nil
	}
	// A TUI that reads text and Return together can take them as a paste. The wait is
	// outside the lock; the state is checked again before Return is pressed.
	d.sleep(300 * time.Millisecond)
	err = withSessionLock(*session, func() error {
		if err := current(); err != nil {
			return err
		}
		return send("\r")
	})
	if errors.Is(err, errStale) {
		return errNotSubmitted
	}
	return err
}
