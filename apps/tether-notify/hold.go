package main

import (
	"encoding/json"
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
	stdin  io.Reader
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
		stdin:  os.Stdin,
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
	kind := fs.String("kind", "permission", "what is held: permission|question")
	tool := fs.String("tool", "", "tool the agent wants to run")
	body := fs.String("body", "", "push body")
	questionsStdin := fs.Bool("questions-stdin", false, "read the question kind's questions as JSON on stdin")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if !validSessionName(*session) {
		return fmt.Errorf("hold requires a valid --session")
	}
	if *body == "" {
		return fmt.Errorf("hold requires --body")
	}
	var questions []Question
	switch *kind {
	case "permission":
	case "question":
		if !*questionsStdin {
			return fmt.Errorf("hold --kind question requires --questions-stdin")
		}
		var err error
		if questions, err = readQuestions(d.stdin); err != nil {
			return err
		}
	default:
		return fmt.Errorf("hold supports --kind permission|question")
	}

	// A permission hold hides the agent's dialog, so it needs proof nobody is at the
	// terminal. A question keeps its dialog showing beside the phone's answer, so it is
	// recorded either way and only the push waits for nobody being attached.
	question := *kind == "question"
	clients, err := zmxClients(d.run)
	detached := err == nil && clients[*session] == 0
	label := hostLabel()
	if !question && (!detached || label == "") {
		return errNotHeld
	}
	push := label != "" && (detached || (question && err != nil))
	link := ""
	if label != "" {
		link = "tether://session/" + *session + "?host=" + url.QueryEscape(label)
	}
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
			next.Pending = &Pending{Kind: *kind, Tool: *tool, Questions: questions}
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

	if !push {
		fmt.Fprintln(d.stdout, stored.Version)
		return nil
	}
	content := PushContent{
		Title: project + " · needs you", Body: *body, Link: link,
		Category: agentCategory(stateWaiting), State: stateWaiting, Version: stored.Version,
	}
	if *kind == "question" {
		content.Category = questionCategory
		content.Options = optionButtons(questions)
	}
	if err := d.push(content, "agent-"+*session); err != nil {
		fmt.Fprintf(d.stderr, "tether-notify: push for %s failed: %v\n", *session, err)
		if question {
			fmt.Fprintln(d.stdout, stored.Version)
			return nil
		}
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

const questionCategory = "tether.agent.question"

func readQuestions(r io.Reader) ([]Question, error) {
	var questions []Question
	if err := json.NewDecoder(r).Decode(&questions); err != nil {
		return nil, fmt.Errorf("hold --questions-stdin: %w", err)
	}
	if len(questions) == 0 {
		return nil, fmt.Errorf("hold --questions-stdin: no questions")
	}
	for _, q := range questions {
		if q.Question == "" || len(q.Options) == 0 {
			return nil, fmt.Errorf("hold --questions-stdin: a question needs its text and options")
		}
		for _, o := range q.Options {
			if o.Label == "" {
				return nil, fmt.Errorf("hold --questions-stdin: an option needs a label")
			}
		}
	}
	return questions, nil
}

// optionButtons are the phone's one-tap answers: only a single single-choice question
// fits on a notification (a tap can't toggle, and iOS shows few actions).
func optionButtons(questions []Question) []string {
	if len(questions) != 1 || questions[0].MultiSelect {
		return nil
	}
	opts := questions[0].Options
	if len(opts) < 2 || len(opts) > 4 {
		return nil
	}
	labels := make([]string, len(opts))
	for i, o := range opts {
		labels[i] = o.Label
	}
	return labels
}
