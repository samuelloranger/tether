package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

// heldAnswer is the phone's decision on a held request, written by `answer`.
type heldAnswer struct {
	Version string `json:"version"`
	Action  string `json:"action"`
	Text    string `json:"text,omitempty"`
}

// waitResult is the one line `wait` prints for the mod.
type waitResult struct {
	Action  string `json:"action,omitempty"`
	Text    string `json:"text,omitempty"`
	Release string `json:"release,omitempty"`
}

// Dot-prefixed: listSessions reads every other file there as a session record.
func answerPath(session string) string { return filepath.Join(sessionsDir(), ".answer-"+session) }

func writeAnswer(session string, a heldAnswer) error {
	data, err := json.Marshal(a)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(sessionsDir(), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), answerPath(session))
}

type waitDeps struct {
	run     runner
	sleep   func(time.Duration)
	ppid    func() int
	pid     int
	signals <-chan os.Signal
	stdout  io.Writer
	stderr  io.Writer
}

func defaultWaitDeps() waitDeps {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	return waitDeps{
		run: execRunner, sleep: time.Sleep, ppid: os.Getppid, pid: os.Getpid(),
		signals: signals, stdout: os.Stdout, stderr: os.Stderr,
	}
}

const (
	waitPoll = 250 * time.Millisecond
	// `zmx ls` is a process per call; the answer file is a stat.
	attachCheckEvery = 4
)

var errWaitAbandoned = errors.New("abandoned")

// runWait blocks until the phone answers the held request, someone attaches (the
// agent's own dialog is then the right UI), or the request is replaced. Killed or
// orphaned, it leaves the record naming it as waiter, so a late tap is refused rather
// than typed into the prompt.
func runWait(args []string, d waitDeps) error {
	fs := flag.NewFlagSet("wait", flag.ContinueOnError)
	fs.SetOutput(d.stderr)
	session := fs.String("session", "", "zmx session name")
	version := fs.String("version", "", "version `hold` printed")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if !validSessionName(*session) || *version == "" {
		return fmt.Errorf("wait requires --session and --version")
	}
	emit := func(r waitResult) error { return json.NewEncoder(d.stdout).Encode(r) }
	locked := func(fn func(*SessionState) error) error {
		return withSessionLock(*session, func() error {
			return withSessionsLock(func() error {
				s, err := readSession(*session)
				if err != nil {
					return err
				}
				return fn(s)
			})
		})
	}
	isHeld := func(s *SessionState) bool { return s != nil && s.Version == *version && s.Pending != nil }

	claimed := false
	if err := locked(func(s *SessionState) error {
		if !isHeld(s) {
			return nil
		}
		s.Pending.WaiterPid = d.pid
		claimed = true
		return writeSession(s)
	}); err != nil {
		return err
	}
	if !claimed {
		return emit(waitResult{Release: "stale"})
	}

	parent := d.ppid()
	for i := 0; ; i++ {
		select {
		case <-d.signals:
			return errWaitAbandoned
		default:
		}
		if d.ppid() != parent {
			return errWaitAbandoned
		}

		var got *heldAnswer
		stale := false
		if err := locked(func(s *SessionState) error {
			if !isHeld(s) {
				stale = true
				return nil
			}
			data, err := os.ReadFile(answerPath(*session))
			if err != nil {
				return nil
			}
			var a heldAnswer
			if json.Unmarshal(data, &a) != nil || a.Version != *version {
				return nil
			}
			_ = os.Remove(answerPath(*session))
			got = &a
			// The call is decided: a second tap must find the agent moved on.
			s.Pending = nil
			s.State = stateWorking
			s.Version = newVersion()
			return writeSession(s)
		}); err != nil {
			return err
		}
		if got != nil {
			return emit(waitResult{Action: got.Action, Text: got.Text})
		}
		if stale {
			return emit(waitResult{Release: "stale"})
		}

		if i%attachCheckEvery == 0 {
			if clients, err := zmxClients(d.run); err == nil && clients[*session] > 0 {
				_ = locked(func(s *SessionState) error {
					if !isHeld(s) {
						return nil
					}
					s.Pending = nil
					return writeSession(s)
				})
				return emit(waitResult{Release: "attached"})
			}
		}
		d.sleep(waitPoll)
	}
}
