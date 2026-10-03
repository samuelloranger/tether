package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
)

type pendingDeps struct {
	alive  func(int) bool
	stdout io.Writer
	stderr io.Writer
}

func defaultPendingDeps() pendingDeps {
	return pendingDeps{alive: pidAlive, stdout: os.Stdout, stderr: os.Stderr}
}

// pendingQuestions is what the phone's answer sheet reads: the held questions in full,
// and the state and version its answer must name.
type pendingQuestions struct {
	Session   string     `json:"session"`
	State     string     `json:"state"`
	Version   string     `json:"version"`
	Kind      string     `json:"kind"`
	Questions []Question `json:"questions"`
}

func runPending(args []string, d pendingDeps) error {
	fs := flag.NewFlagSet("pending", flag.ContinueOnError)
	fs.SetOutput(d.stderr)
	session := fs.String("session", "", "zmx session name")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if !validSessionName(*session) {
		return fmt.Errorf("pending requires a valid --session")
	}
	s, err := readSession(*session)
	if err != nil {
		return err
	}
	if s == nil || s.Pending == nil || s.Pending.Kind != "question" ||
		s.Pending.WaiterPid <= 0 || !d.alive(s.Pending.WaiterPid) {
		return errStale
	}
	return json.NewEncoder(d.stdout).Encode(pendingQuestions{
		Session: s.Session, State: s.State, Version: s.Version, Kind: s.Pending.Kind, Questions: s.Pending.Questions,
	})
}
