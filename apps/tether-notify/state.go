package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/url"
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

	in := SessionState{Session: *session, Agent: *agent, State: *state, Message: *body, Link: *link, Version: newVersion()}
	if *state != stateClear {
		in.AgentPid = agentPid(d.run, d.ppid)
	}
	now := d.now().Unix()
	var stored *SessionState
	err := withSessionLock(*session, func() error {
		return withSessionsLock(func() error {
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
	if stored != nil && stored.Version != "" && actionableLink(*link, *session) {
		content.Category = agentCategory(*state)
		content.State = stored.State
		content.Version = stored.Version
	}
	if err := d.push(content, *collapse); err != nil {
		fmt.Fprintf(d.stderr, "tether-notify: push for %s failed: %v\n", *session, err)
	}
	return nil
}

// actionableLink is a tether://session/<session>?host=<label> link for this very session:
// the phone answers whatever session the link names. The path is compared raw, as the
// phone reads it; an encoded path would name a different session there.
func actionableLink(link, session string) bool {
	if !strings.HasPrefix(link, "tether://session/"+session+"?") {
		return false
	}
	u, err := url.Parse(link)
	return err == nil && u.Query().Get("host") != ""
}

func newVersion() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
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
	stale := func(s SessionState) bool {
		_, listed := live[s.Session]
		return !d.alive(s.AgentPid) || (lsErr == nil && !listed)
	}
	var doomed []string
	err := withSessionsLock(func() error {
		states, err := listSessions()
		if err != nil {
			return err
		}
		for _, s := range states {
			if stale(s) {
				doomed = append(doomed, s.Session)
				continue
			}
			out = append(out, s)
		}
		return nil
	})
	if err != nil {
		return err
	}
	// Each removal takes its session's lock first, like every other writer, so it can't
	// land between `answer`'s check and its send; the record is checked again under it.
	for _, name := range doomed {
		_ = withSessionLock(name, func() error {
			return withSessionsLock(func() error {
				if s, _ := readSession(name); s != nil && stale(*s) {
					return removeSession(name)
				}
				return nil
			})
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Session < out[j].Session })
	return json.NewEncoder(w).Encode(out)
}
