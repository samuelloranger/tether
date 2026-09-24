package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"time"
)

type stateDeps struct {
	run    runner
	now    func() time.Time
	ppid   int
	push   func(PushContent, string) error
	stderr io.Writer
}

func defaultStateDeps(dryRun bool) stateDeps {
	return stateDeps{
		run:    execRunner,
		now:    time.Now,
		ppid:   os.Getppid(),
		push:   func(c PushContent, collapse string) error { return sendPush(c, collapse, dryRun) },
		stderr: os.Stderr,
	}
}

// runState only fails on a usage mistake: hooks must never break the agent, so
// storage and delivery problems are reported and swallowed.
func runState(args []string, d stateDeps) error {
	fs := flag.NewFlagSet("state", flag.ContinueOnError)
	fs.SetOutput(d.stderr)
	session := fs.String("session", "", "zmx session name")
	agent := fs.String("agent", "", "agent name")
	state := fs.String("state", "", "working|waiting|done|clear")
	title := fs.String("title", "", "push title")
	body := fs.String("body", "", "push body / status message")
	link := fs.String("link", "", "tether:// deep link")
	collapse := fs.String("collapse", "", "APNs collapse id (default agent-<session>)")
	dryRun := fs.Bool("dry-run", false, "print the push instead of sending it")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if !validSessionName(*session) {
		return fmt.Errorf("state requires a valid --session")
	}
	if !validState(*state) {
		return fmt.Errorf("state requires --state working|waiting|done|clear")
	}
	if *dryRun {
		d.push = func(c PushContent, col string) error { return sendPush(c, col, true) }
	}
	if *collapse == "" {
		*collapse = "agent-" + *session
	}

	in := SessionState{Session: *session, Agent: *agent, State: *state, Message: *body, Link: *link}
	if *state != stateClear {
		in.AgentPid = agentPid(d.run, d.ppid)
	}
	now := d.now().Unix()
	var stored *SessionState
	err := withSessionsLock(func() error {
		prev, _ := readSession(*session)
		next := nextState(prev, in, now)
		if next == nil {
			return removeSession(*session)
		}
		if err := writeSession(next); err != nil {
			return err
		}
		stored = next
		return nil
	})
	if err != nil {
		fmt.Fprintf(d.stderr, "tether-notify: state for %s not saved: %v\n", *session, err)
	}

	if (*state != stateWaiting && *state != stateDone) || *title == "" || *body == "" {
		return nil
	}
	// A failed check pushes: losing a notification is worse than a duplicate.
	if clients, err := zmxClients(d.run); err == nil && clients[*session] > 0 {
		return nil
	}
	content := PushContent{Title: *title, Body: *body, Link: *link}
	// Actions need a session link to answer and a saved state to check against.
	if stored != nil && actionableLink(*link) {
		content.Category = agentCategory(*state)
		content.State = stored.State
		content.Since = stored.Since
	}
	if err := d.push(content, *collapse); err != nil {
		fmt.Fprintf(d.stderr, "tether-notify: push for %s failed: %v\n", *session, err)
	}
	return nil
}

func actionableLink(link string) bool {
	return strings.HasPrefix(link, "tether://session/") && strings.Contains(link, "?host=")
}

// agentCategory names the iOS notification category for an agent push; the app
// registers the same identifiers.
func agentCategory(state string) string {
	switch state {
	case stateWaiting:
		return "tether.agent.waiting"
	case stateDone:
		return "tether.agent.done"
	}
	return ""
}

type statusDeps struct {
	run   runner
	alive func(int) bool
}

func defaultStatusDeps() statusDeps { return statusDeps{run: execRunner, alive: pidAlive} }

// runStatus prunes what can be proven stale — a dead agent, or a session zmx no
// longer lists — and never deletes on a failed `zmx ls`.
func runStatus(w io.Writer, d statusDeps) error {
	out := []SessionState{}
	// Outside the lock: a slow ls must not stall the hooks queued behind it.
	live, lsErr := zmxClients(d.run)
	err := withSessionsLock(func() error {
		states, err := listSessions()
		if err != nil {
			return err
		}
		for _, s := range states {
			_, listed := live[s.Session]
			if !d.alive(s.AgentPid) || (lsErr == nil && !listed) {
				_ = removeSession(s.Session)
				continue
			}
			out = append(out, s)
		}
		return nil
	})
	if err != nil {
		return err
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Session < out[j].Session })
	return json.NewEncoder(w).Encode(out)
}
