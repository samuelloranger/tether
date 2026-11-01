package main

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeHermes answers initialize and session/new like the adapter, replaying `history` before the
// session answer as a resumed adapter does. A prompt is left unanswered until the test kills it.
type fakeHermes struct {
	history string
	stdout  *io.PipeWriter
}

func (f *fakeHermes) start() *hermesProc {
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	f.stdout = outW
	done := make(chan struct{})
	go func() {
		defer close(done)
		r := bufio.NewReader(inR)
		for {
			line, err := r.ReadBytes('\n')
			if err != nil {
				return
			}
			var m struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
			}
			_ = json.Unmarshal(line, &m)
			switch m.Method {
			case "initialize":
				_, _ = io.WriteString(outW, `{"jsonrpc":"2.0","id":`+string(m.ID)+`,"result":{}}`+"\n")
			case "session/new":
				if f.history != "" {
					_, _ = io.WriteString(outW, `{"jsonrpc":"2.0","method":"session/update","params":{"text":"`+f.history+`"}}`+"\n")
				}
				_, _ = io.WriteString(outW, `{"jsonrpc":"2.0","id":`+string(m.ID)+`,"result":{"sessionId":"s1"}}`+"\n")
			case "ping":
				_, _ = io.WriteString(outW, `{"jsonrpc":"2.0","id":`+string(m.ID)+`,"result":"pong"}`+"\n")
			}
		}
	}()
	return &hermesProc{stdin: inW, stdout: outR, wait: func() error { _ = inR.Close(); <-done; return nil }}
}

type hermesHarness struct {
	out   *lockedBuffer
	in    *io.PipeWriter
	mu    sync.Mutex
	runs  []*fakeHermes
	ready chan bool
	done  chan error
}

// newHermesHarness starts a supervisor whose spawns succeed only while `up` says so.
func newHermesHarness(up func(run int) bool) *hermesHarness {
	h := &hermesHarness{out: &lockedBuffer{}, done: make(chan error, 1)}
	inR, inW := io.Pipe()
	h.in = inW
	tries := 0
	s := newHermesSupervisor(h.out, func() (*hermesProc, error) {
		h.mu.Lock()
		defer h.mu.Unlock()
		tries++
		if !up(tries) {
			return nil, io.ErrClosedPipe
		}
		f := &fakeHermes{history: "earlier"}
		h.runs = append(h.runs, f)
		return f.start(), nil
	})
	s.backoff = func(int) time.Duration { return 10 * time.Millisecond }
	go func() { h.done <- s.run(inR) }()
	return h
}

func (h *hermesHarness) send(line string) { _, _ = io.WriteString(h.in, line+"\n") }

func (h *hermesHarness) kill(run int) {
	h.mu.Lock()
	f := h.runs[run]
	h.mu.Unlock()
	_ = f.stdout.Close()
}

func (h *hermesHarness) started() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.runs)
}

func TestHermesSupervisorRestartsTheAdapterWithoutReplayingTheConversationTwice(t *testing.T) {
	h := newHermesHarness(func(int) bool { return true })
	waitFor(t, "first adapter", func() bool { return h.started() == 1 })
	h.send(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	h.send(`{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/"}}`)
	waitFor(t, "session answer", func() bool { return strings.Contains(h.out.String(), `"id":2`) })
	before := h.out.String()

	h.kill(0)
	waitFor(t, "second adapter", func() bool { return h.started() == 2 })
	h.send(`{"jsonrpc":"2.0","id":3,"method":"ping"}`)
	waitFor(t, "ping answer", func() bool { return strings.Contains(h.out.String(), `"id":3`) })

	after := strings.TrimPrefix(h.out.String(), before)
	if after != `{"jsonrpc":"2.0","id":3,"result":"pong"}`+"\n" {
		t.Fatalf("the restart leaked its replay to the holder:\n%s", after)
	}
	if n := strings.Count(h.out.String(), "earlier"); n != 1 {
		t.Fatalf("history logged %d times, want once", n)
	}
	_ = h.in.Close()
	if err := <-h.done; err != nil {
		t.Fatal(err)
	}
}

func TestHermesSupervisorFailsWhatTheDeadAdapterLeftUnanswered(t *testing.T) {
	h := newHermesHarness(func(int) bool { return true })
	waitFor(t, "first adapter", func() bool { return h.started() == 1 })
	h.send(`{"jsonrpc":"2.0","id":7,"method":"session/prompt","params":{}}`)
	time.Sleep(20 * time.Millisecond)
	h.kill(0)
	waitFor(t, "prompt failure", func() bool { return strings.Contains(h.out.String(), `"id":7`) })
	if !strings.Contains(h.out.String(), `"error"`) {
		t.Fatalf("want an error answer, got %s", h.out.String())
	}
	_ = h.in.Close()
	<-h.done
}

func TestHermesSupervisorAnswersWhileHermesIsDownAndKeepsTrying(t *testing.T) {
	h := newHermesHarness(func(run int) bool { return run >= 4 })
	h.send(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	waitFor(t, "down answer", func() bool { return strings.Contains(h.out.String(), "not reachable") })
	waitFor(t, "adapter once Hermes is back", func() bool { return h.started() == 1 })
	h.send(`{"jsonrpc":"2.0","id":2,"method":"ping"}`)
	waitFor(t, "ping answer", func() bool { return strings.Contains(h.out.String(), `"result":"pong"`) })
	_ = h.in.Close()
	<-h.done
}

func TestHermesBackoffIsBounded(t *testing.T) {
	if hermesBackoff(0) != time.Second || hermesBackoff(20) != 30*time.Second {
		t.Fatalf("backoff %v .. %v", hermesBackoff(0), hermesBackoff(20))
	}
}
