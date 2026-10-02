package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// errNotHeld tells the mod to let the agent draw its own dialog.
var errNotHeld = errors.New("not held")

type holdDeps struct {
	run    runner
	now    func() time.Time
	ppid   int
	cwd    func() (string, error)
	push   func(PushContent, string) error
	stdout io.Writer
	stderr io.Writer
}

func defaultHoldDeps() holdDeps {
	return holdDeps{
		run:    execRunner,
		now:    time.Now,
		ppid:   os.Getppid(),
		cwd:    os.Getwd,
		push:   func(c PushContent, collapse string) error { return sendPush(c, collapse, false) },
		stdout: os.Stdout,
		stderr: os.Stderr,
	}
}

// The installer writes the label the agent hooks put in their links; the mod has no
// other way to learn it.
func hostLabelPath() string { return filepath.Join(home(), "host-label") }

func hostLabel() string {
	data, err := os.ReadFile(hostLabelPath())
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// runHold records a permission request the mod holds and pushes it. Holding hides the
// dialog, so anything short of proof that nobody is at the terminal and that the phone
// was told refuses with errNotHeld.
func runHold(args []string, d holdDeps) error {
	fs := flag.NewFlagSet("hold", flag.ContinueOnError)
	fs.SetOutput(d.stderr)
	session := fs.String("session", "", "zmx session name")
	kind := fs.String("kind", "permission", "what is held: permission")
	tool := fs.String("tool", "", "tool the agent wants to run")
	body := fs.String("body", "", "push body")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if !validSessionName(*session) {
		return fmt.Errorf("hold requires a valid --session")
	}
	if *kind != "permission" {
		return fmt.Errorf("hold supports --kind permission")
	}
	if *body == "" {
		return fmt.Errorf("hold requires --body")
	}

	clients, err := zmxClients(d.run)
	if err != nil || clients[*session] > 0 {
		return errNotHeld
	}
	label := hostLabel()
	if label == "" {
		return errNotHeld
	}
	link := "tether://session/" + *session + "?host=" + url.QueryEscape(label)
	project := label
	if dir, err := d.cwd(); err == nil && dir != "" {
		project = filepath.Base(dir)
	}

	in := SessionState{
		Session: *session, Agent: "claude", State: stateWaiting, Message: *body, Link: link,
		Version: newVersion(), AgentPid: agentPid(d.run, d.ppid),
	}
	var stored *SessionState
	err = withSessionLock(*session, func() error {
		return withSessionsLock(func() error {
			prev, _ := readSession(*session)
			next := nextState(prev, in, d.now().Unix())
			next.Pending = &Pending{Kind: *kind, Tool: *tool}
			if err := writeSession(next); err != nil {
				return err
			}
			stored = next
			return nil
		})
	})
	if err != nil {
		fmt.Fprintf(d.stderr, "tether-notify: hold for %s not saved: %v\n", *session, err)
		return errNotHeld
	}

	content := PushContent{
		Title: project + " · needs you", Body: *body, Link: link,
		Category: agentCategory(stateWaiting), State: stateWaiting, Version: stored.Version,
	}
	if err := d.push(content, "agent-"+*session); err != nil {
		fmt.Fprintf(d.stderr, "tether-notify: push for %s failed: %v\n", *session, err)
		// Nobody will answer a request the phone never heard of.
		_ = withSessionLock(*session, func() error {
			return withSessionsLock(func() error {
				s, _ := readSession(*session)
				if s == nil || s.Version != stored.Version {
					return nil
				}
				s.Pending = nil
				return writeSession(s)
			})
		})
		return errNotHeld
	}
	fmt.Fprintln(d.stdout, stored.Version)
	return nil
}
