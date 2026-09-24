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

var errStale = errors.New("stale")

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
// lock screen must not answer a newer prompt.
func runAnswer(args []string, d answerDeps) error {
	fs := flag.NewFlagSet("answer", flag.ContinueOnError)
	fs.SetOutput(d.stderr)
	session := fs.String("session", "", "zmx session name")
	state := fs.String("state", "", "agent state the push was about")
	since := fs.Int64("since", 0, "when the agent entered that state (unix seconds)")
	input := fs.String("input", "", "base64 bytes to type")
	submit := fs.Bool("submit", false, "press Return after the input, in a separate write")
	if err := fs.Parse(args); err != nil {
		return err
	}
	// A leading '-' would reach zmx as a flag rather than a session name.
	if !validSessionName(*session) || strings.HasPrefix(*session, "-") {
		return fmt.Errorf("answer requires a valid --session")
	}
	if !validState(*state) || *since <= 0 {
		return fmt.Errorf("answer requires --state and --since")
	}
	bytes, err := base64.StdEncoding.DecodeString(*input)
	if err != nil || len(bytes) == 0 {
		return fmt.Errorf("answer requires base64 --input")
	}

	current, err := readSession(*session)
	if err != nil {
		return err
	}
	if current == nil || current.State != *state || current.Since != *since {
		return errStale
	}

	if _, err := d.run(zmxPath(), "send", *session, string(bytes)); err != nil {
		return fmt.Errorf("zmx send: %w", err)
	}
	if *submit {
		// A TUI that reads text and Return together can take them as a paste.
		d.sleep(300 * time.Millisecond)
		if _, err := d.run(zmxPath(), "send", *session, "\r"); err != nil {
			return fmt.Errorf("zmx send: %w", err)
		}
	}
	return nil
}
