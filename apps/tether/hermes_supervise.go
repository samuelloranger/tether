package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"sync"
	"time"
)

// hermesProc is one run of the adapter.
type hermesProc struct {
	stdin  io.WriteCloser
	stdout io.Reader
	wait   func() error

	// Lines for stdin, written by their own goroutine: the adapter may block on its output while
	// it reads, so nothing that holds the supervisor's lock may wait on its input.
	inbox  [][]byte
	closed bool
}

// hermesSupervisor keeps the holder's agent alive while the adapter under it comes and goes with
// Hermes's gateway or container. A restarted adapter is sent the client's initialize and session
// requests again; it answers by replaying the conversation, which the holder already logged, so
// everything it says until the session answer is dropped. Requests the old adapter never answered
// are failed, so no turn waits forever.
type hermesSupervisor struct {
	out     io.Writer
	spawn   func() (*hermesProc, error)
	backoff func(attempt int) time.Duration

	mu        sync.Mutex
	wake      *sync.Cond
	proc      *hermesProc
	started   time.Time
	replay    map[string]bool
	queued    [][]byte
	pending   map[string]json.RawMessage
	initLine  []byte
	initID    string
	sessLine  []byte
	sessID    string
	sessionID string
}

type hermesFrame struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Result struct {
		SessionID string `json:"sessionId"`
	} `json:"result"`
	Error json.RawMessage `json:"error"`
	// session/load carries the id in its params; session/new gets it in the answer.
	Params struct {
		SessionID string `json:"sessionId"`
	} `json:"params"`
}

func (f hermesFrame) request() bool { return f.Method != "" && len(f.ID) > 0 }

func hermesBackoff(attempt int) time.Duration {
	return min(time.Second<<min(attempt, 5), 30*time.Second)
}

func newHermesSupervisor(out io.Writer, spawn func() (*hermesProc, error)) *hermesSupervisor {
	s := &hermesSupervisor{out: out, spawn: spawn, backoff: hermesBackoff, pending: map[string]json.RawMessage{}}
	s.wake = sync.NewCond(&s.mu)
	return s
}

func (s *hermesSupervisor) run(in io.Reader) error {
	lines := make(chan []byte)
	go func() {
		defer close(lines)
		r := bufio.NewReader(in)
		for {
			line, err := r.ReadBytes('\n')
			if trimmed := bytes.TrimRight(line, "\r\n"); len(bytes.TrimSpace(trimmed)) > 0 {
				lines <- trimmed
			}
			if err != nil {
				return
			}
		}
	}()
	attempt := 0
	for {
		if proc, err := s.spawn(); err == nil {
			exited := make(chan struct{})
			s.attach(proc)
			go s.writer(proc)
			go func() {
				s.pump(proc)
				close(exited)
			}()
		serve:
			for {
				select {
				case line, ok := <-lines:
					if !ok {
						s.mu.Lock()
						proc.closed = true
						s.wake.Broadcast()
						s.mu.Unlock()
						return nil
					}
					s.forward(line)
				case <-exited:
					break serve
				}
			}
			if s.down(proc) {
				attempt = 0
			}
			_ = proc.wait()
		}
		timer := time.NewTimer(s.backoff(attempt))
		attempt++
	wait:
		for {
			select {
			case line, ok := <-lines:
				if !ok {
					timer.Stop()
					return nil
				}
				s.forward(line)
			case <-timer.C:
				break wait
			}
		}
	}
}

func (s *hermesSupervisor) writer(proc *hermesProc) {
	defer proc.stdin.Close()
	for {
		s.mu.Lock()
		for len(proc.inbox) == 0 && !proc.closed {
			s.wake.Wait()
		}
		if len(proc.inbox) == 0 {
			s.mu.Unlock()
			return
		}
		line := proc.inbox[0]
		proc.inbox = proc.inbox[1:]
		s.mu.Unlock()
		if _, err := proc.stdin.Write(line); err != nil {
			return
		}
	}
}

// send queues a line for the adapter; the caller holds s.mu.
func (s *hermesSupervisor) send(proc *hermesProc, line []byte) {
	proc.inbox = append(proc.inbox, append(append([]byte{}, line...), '\n'))
	s.wake.Broadcast()
}

// attach makes proc the live adapter and, when a client has set it up before, starts the replay.
func (s *hermesSupervisor) attach(proc *hermesProc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.proc, s.started, s.replay = proc, time.Now(), nil
	for _, setup := range []struct {
		line []byte
		id   string
	}{{s.initLine, s.initID}, {s.sessLine, s.sessID}} {
		if setup.line == nil {
			continue
		}
		if s.replay == nil {
			s.replay = map[string]bool{}
		}
		s.replay[setup.id] = true
		s.send(proc, setup.line)
	}
}

// down fails what the adapter left unanswered; true when it had settled, so the next try is quick.
func (s *hermesSupervisor) down(proc *hermesProc) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	settled := s.replay == nil && time.Since(s.started) >= 30*time.Second
	proc.closed = true
	s.wake.Broadcast()
	s.proc, s.replay = nil, nil
	for _, line := range s.queued {
		var f hermesFrame
		if json.Unmarshal(line, &f) == nil && f.request() {
			s.pending[string(f.ID)] = f.ID
		}
	}
	s.queued = nil
	for key, id := range s.pending {
		s.fail(id, "Hermes restarted before it answered. Send it again.")
		delete(s.pending, key)
	}
	return settled
}

func (s *hermesSupervisor) forward(line []byte) {
	var f hermesFrame
	_ = json.Unmarshal(line, &f)
	s.mu.Lock()
	defer s.mu.Unlock()
	switch f.Method {
	case "initialize":
		s.initLine, s.initID = line, string(f.ID)
	case "session/new", "session/load", "session/resume":
		s.sessLine, s.sessID = line, string(f.ID)
		if f.Params.SessionID != "" {
			s.sessionID = f.Params.SessionID
		}
	}
	switch {
	case s.proc == nil:
		if f.request() {
			s.fail(f.ID, "Hermes is not reachable right now; Tether keeps trying. Send it again in a moment.")
		}
	case s.replay != nil:
		s.queued = append(s.queued, line)
	default:
		if f.request() {
			s.pending[string(f.ID)] = f.ID
		}
		s.send(s.proc, line)
	}
}

func (s *hermesSupervisor) pump(proc *hermesProc) {
	r := bufio.NewReader(proc.stdout)
	for {
		line, err := r.ReadBytes('\n')
		if trimmed := bytes.TrimRight(line, "\r\n"); len(bytes.TrimSpace(trimmed)) > 0 {
			s.fromAgent(trimmed)
		}
		if err != nil {
			return
		}
	}
}

func (s *hermesSupervisor) fromAgent(line []byte) {
	var f hermesFrame
	_ = json.Unmarshal(line, &f)
	answer := f.Method == "" && len(f.ID) > 0
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.replay != nil {
		if !answer || !s.replay[string(f.ID)] {
			return
		}
		delete(s.replay, string(f.ID))
		if string(f.ID) == s.sessID && len(f.Error) > 0 && s.sessionID != "" {
			s.say("Hermes restarted but could not reopen this conversation. Run tether hermes --check on the host.")
		}
		if len(s.replay) > 0 {
			return
		}
		s.replay = nil
		for _, queued := range s.queued {
			var q hermesFrame
			if json.Unmarshal(queued, &q) == nil && q.request() {
				s.pending[string(q.ID)] = q.ID
			}
			s.send(s.proc, queued)
		}
		s.queued = nil
		return
	}
	if answer {
		delete(s.pending, string(f.ID))
		if string(f.ID) == s.sessID && f.Result.SessionID != "" {
			s.sessionID = f.Result.SessionID
		}
	}
	s.write(line)
}

func (s *hermesSupervisor) fail(id json.RawMessage, message string) {
	data, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32603, "message": message},
	})
	s.write(data)
}

func (s *hermesSupervisor) say(text string) {
	data, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "method": "session/update",
		"params": map[string]any{"sessionId": s.sessionID, "update": map[string]any{
			"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": text},
		}},
	})
	s.write(data)
}

func (s *hermesSupervisor) write(line []byte) {
	_, _ = s.out.Write(append(append([]byte{}, line...), '\n'))
}
