package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	acpPermissionCategory = "tether.acp.permission"
	acpDoneCategory       = "tether.acp.done"
	maxACPLine            = 64 << 20
	maxPushOptions        = 4
)

// errNotOutstanding maps to exit 3: the request was answered already or the agent moved on.
var errNotOutstanding = errors.New("request is not outstanding")

type acpOption struct {
	OptionID string `json:"optionId"`
	Name     string `json:"name"`
	Kind     string `json:"kind,omitempty"`
}

type acpRequest struct {
	ID       json.RawMessage `json:"id"`
	Title    string          `json:"title"`
	Kind     string          `json:"kind,omitempty"`
	Options  []acpOption     `json:"options"`
	Notified bool            `json:"notified"`
}

type acpTrackerState struct {
	Title    string                 `json:"title,omitempty"`
	Requests map[string]*acpRequest `json:"requests"`
	Prompts  []string               `json:"prompts,omitempty"`
}

// acpTracker follows the ACP stream just enough to know which permission requests
// are waiting and when a turn ends. It never rejects a line: anything it cannot
// parse is ignored.
type acpTracker struct {
	mu      sync.Mutex
	name    string
	dir     string
	st      acpTrackerState
	answers map[string]string
}

func loadACPTracker(name string) *acpTracker {
	t := &acpTracker{name: name, dir: acpDir(name), answers: map[string]string{}}
	t.st.Requests = map[string]*acpRequest{}
	if data, err := os.ReadFile(filepath.Join(t.dir, "pending.json")); err == nil {
		var st acpTrackerState
		if json.Unmarshal(data, &st) == nil {
			t.st = st
			if t.st.Requests == nil {
				t.st.Requests = map[string]*acpRequest{}
			}
		}
	}
	if data, err := os.ReadFile(filepath.Join(t.dir, "answers.json")); err == nil {
		_ = json.Unmarshal(data, &t.answers)
		if t.answers == nil {
			t.answers = map[string]string{}
		}
	}
	return t
}

func writeJSONAtomic(path string, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if os.WriteFile(tmp, data, 0o600) == nil {
		_ = os.Rename(tmp, path)
	}
}

func (t *acpTracker) saveLocked() {
	writeJSONAtomic(filepath.Join(t.dir, "pending.json"), t.st)
}

func (t *acpTracker) saveAnswersLocked() {
	writeJSONAtomic(filepath.Join(t.dir, "answers.json"), t.answers)
}

type rpcLine struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

func parseRPC(line []byte) (rpcLine, string, bool) {
	var m rpcLine
	if json.Unmarshal(bytes.TrimSpace(line), &m) != nil {
		return m, "", false
	}
	key := ""
	if len(m.ID) > 0 && string(m.ID) != "null" {
		var buf bytes.Buffer
		if json.Compact(&buf, m.ID) != nil {
			return m, "", false
		}
		key = buf.String()
	}
	return m, key, true
}

type acpEvent struct {
	permission *acpRequest
	key        string
	turnEnded  bool
	stopReason string
}

func (t *acpTracker) agentLine(line []byte) acpEvent {
	m, key, ok := parseRPC(line)
	if !ok {
		return acpEvent{}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	switch {
	case m.Method == "session/request_permission" && key != "":
		if _, dup := t.st.Requests[key]; dup {
			return acpEvent{}
		}
		if _, done := t.answers[key]; done {
			return acpEvent{}
		}
		var p struct {
			ToolCall struct {
				Title string `json:"title"`
				Kind  string `json:"kind"`
			} `json:"toolCall"`
			Options []acpOption `json:"options"`
		}
		_ = json.Unmarshal(m.Params, &p)
		req := &acpRequest{ID: json.RawMessage(key), Title: p.ToolCall.Title, Kind: p.ToolCall.Kind, Options: p.Options}
		t.st.Requests[key] = req
		t.saveLocked()
		return acpEvent{permission: req, key: key}
	case m.Method == "session/update":
		var p struct {
			Update struct {
				Kind  string  `json:"sessionUpdate"`
				Title *string `json:"title"`
			} `json:"update"`
		}
		if json.Unmarshal(m.Params, &p) == nil && p.Update.Kind == "session_info_update" && p.Update.Title != nil && *p.Update.Title != t.st.Title {
			t.st.Title = *p.Update.Title
			t.saveLocked()
		}
	case m.Method == "" && key != "":
		for i, k := range t.st.Prompts {
			if k != key {
				continue
			}
			t.st.Prompts = append(t.st.Prompts[:i:i], t.st.Prompts[i+1:]...)
			t.st.Requests = map[string]*acpRequest{}
			t.saveLocked()
			var r struct {
				StopReason string `json:"stopReason"`
			}
			_ = json.Unmarshal(m.Result, &r)
			if r.StopReason == "" && len(m.Error) > 0 {
				r.StopReason = "error"
			}
			return acpEvent{turnEnded: true, stopReason: r.StopReason}
		}
	}
	return acpEvent{}
}

func (t *acpTracker) clientLine(line []byte) {
	m, key, ok := parseRPC(line)
	if !ok || key == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	switch {
	case m.Method == "session/prompt":
		t.st.Prompts = append(t.st.Prompts, key)
		t.saveLocked()
	case m.Method == "":
		if _, ok := t.st.Requests[key]; ok {
			delete(t.st.Requests, key)
			t.saveLocked()
		}
	}
}

// claimNotify reports true exactly once per request.
func (t *acpTracker) claimNotify(key string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	r := t.st.Requests[key]
	if r == nil || r.Notified {
		return false
	}
	r.Notified = true
	t.saveLocked()
	return true
}

func (t *acpTracker) chatName() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.st.Title != "" {
		return t.st.Title
	}
	return t.name
}

// answer runs write for an outstanding request and, if it succeeds, records the answer and clears it.
func (t *acpTracker) answer(key, value string, write func(req *acpRequest) error) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	r := t.st.Requests[key]
	if r == nil {
		return errNotOutstanding
	}
	if err := write(r); err != nil {
		return err
	}
	delete(t.st.Requests, key)
	t.answers[key] = value
	t.saveLocked()
	t.saveAnswersLocked()
	return nil
}

func splitLines(pend, chunk []byte) (lines [][]byte, rest []byte) {
	pend = append(pend, chunk...)
	for {
		i := bytes.IndexByte(pend, '\n')
		if i < 0 {
			return lines, pend
		}
		lines = append(lines, pend[:i+1:i+1])
		pend = pend[i+1:]
	}
}

func (s *acpDaemonState) attached() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cur != nil
}

// scanAgent is called only from the stdout reader goroutine.
func (s *acpDaemonState) scanAgent(chunk []byte) {
	if s.skip {
		i := bytes.IndexByte(chunk, '\n')
		if i < 0 {
			return
		}
		chunk, s.skip = chunk[i+1:], false
	}
	var lines [][]byte
	lines, s.partial = splitLines(s.partial, chunk)
	if len(s.partial) > maxACPLine {
		s.partial, s.skip = nil, true
	}
	for _, l := range lines {
		ev := s.tr.agentLine(l)
		switch {
		case ev.permission != nil && !s.attached() && s.tr.claimNotify(ev.key):
			s.pushAsync(s.permissionPush(ev.permission), "acp-"+s.collapseSuffix(ev.key))
		case ev.turnEnded && !s.attached():
			s.pushAsync(s.donePush(ev.stopReason), "acp-done-"+threadKey(hostLabel(), s.tr.name))
		}
	}
}

func (s *acpDaemonState) collapseSuffix(key string) string {
	sum := sha256.Sum256([]byte(hostLabel() + "\x00" + s.tr.name + "\x00" + key))
	return hex.EncodeToString(sum[:8])
}

func (s *acpDaemonState) pushAsync(c PushContent, collapse string) {
	s.pushes.Add(1)
	go func() {
		defer s.pushes.Done()
		if err := s.push(c, collapse); err != nil && s.errf != nil {
			fmt.Fprintf(s.errf, "tether-notify: acp push failed: %v\n", err)
		}
	}()
}

func (s *acpDaemonState) link() string {
	label := hostLabel()
	if label == "" {
		return ""
	}
	return "tether://chat/" + url.PathEscape(s.tr.name) + "?host=" + url.QueryEscape(label)
}

func clip(v string, n int) string {
	if utf8.RuneCountInString(v) <= n {
		return v
	}
	r := []rune(v)
	return string(r[:n-1]) + "…"
}

func (s *acpDaemonState) permissionPush(req *acpRequest) PushContent {
	chat := s.tr.chatName()
	what := req.Title
	if what == "" {
		what = req.Kind
	}
	if what == "" {
		what = "a tool"
	}
	c := PushContent{
		Title: clip(chat, 60) + " · needs you", Body: "Allow: " + clip(what, 120) + "?", Link: s.link(),
		Category: acpPermissionCategory, State: "waiting", Version: s.collapseSuffix(string(req.ID)),
		Session: chat, Level: levelUrgent, ACPSession: s.tr.name, RequestID: string(req.ID),
	}
	opts := req.Options
	if len(opts) > maxPushOptions {
		opts = opts[:maxPushOptions]
	}
	if len(opts) >= 2 {
		for _, o := range opts {
			c.Options = append(c.Options, o.Name)
			c.OptionIDs = append(c.OptionIDs, o.OptionID)
			c.OptionKinds = append(c.OptionKinds, o.Kind)
		}
	}
	return c
}

func (s *acpDaemonState) donePush(stop string) PushContent {
	chat := s.tr.chatName()
	if stop == "" {
		stop = "unknown"
	}
	return PushContent{
		Title: clip(chat, 60), Body: "Finished · " + stop, Link: s.link(), Category: acpDoneCategory,
		Session: chat, Level: levelQuiet, ACPSession: s.tr.name, StopReason: stop,
	}
}

type acpAnswerMsg struct {
	ID     json.RawMessage `json:"id"`
	Option string          `json:"option,omitempty"`
	Cancel bool            `json:"cancel,omitempty"`
}

// control serves one answer message: a verb line, one reply line. The connection is
// never made the current client.
func (s *acpDaemonState) control(conn net.Conn, rest string) {
	defer conn.Close()
	reply := func(v string) { _, _ = io.WriteString(conn, v+"\n") }
	var msg acpAnswerMsg
	var key bytes.Buffer
	if json.Unmarshal([]byte(rest), &msg) != nil || json.Compact(&key, msg.ID) != nil || (!msg.Cancel && msg.Option == "") {
		reply("err bad answer")
		return
	}
	value, outcome := msg.Option, map[string]any{"outcome": "selected", "optionId": msg.Option}
	if msg.Cancel {
		value, outcome = "cancelled", map[string]any{"outcome": "cancelled"}
	}
	line, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(key.Bytes()), "result": map[string]any{"outcome": outcome}})
	line = append(line, '\n')

	s.mu.Lock()
	defer s.mu.Unlock()
	err := s.tr.answer(key.String(), value, func(*acpRequest) error {
		if s.ended {
			return errors.New("agent has exited")
		}
		_, err := s.stdin.Write(line)
		return err
	})
	switch {
	case err == nil:
		reply("ok")
	case errors.Is(err, errNotOutstanding):
		reply("stale")
	default:
		reply("err " + err.Error())
	}
}

func waitTimeout(wg *sync.WaitGroup, d time.Duration) {
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(d):
	}
}

func acpAnswer(args []string) error {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		return fmt.Errorf("usage: acp answer <name> --request ID (--option OPTION_ID | --cancel)")
	}
	name := args[0]
	fs := flag.NewFlagSet("acp answer", flag.ContinueOnError)
	request := fs.String("request", "", "JSON-RPC id of the permission request, as JSON text")
	option := fs.String("option", "", "optionId to select")
	cancel := fs.Bool("cancel", false, "answer with outcome cancelled")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if !validSessionName(name) {
		return fmt.Errorf("invalid session name")
	}
	if *request == "" || (*option == "") == !*cancel {
		return fmt.Errorf("acp answer needs --request and exactly one of --option or --cancel")
	}
	id := json.RawMessage(*request)
	if !json.Valid(id) {
		id, _ = json.Marshal(*request)
	}
	m, err := readACPMeta(name)
	if err != nil {
		return err
	}
	if !metaRunning(m) {
		return errNotOutstanding
	}
	conn, err := net.DialTimeout("unix", m.Sock, 5*time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	body, _ := json.Marshal(acpAnswerMsg{ID: id, Option: *option, Cancel: *cancel})
	if _, err := fmt.Fprintf(conn, "answer %s\n", body); err != nil {
		return err
	}
	resp, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		return fmt.Errorf("daemon did not reply: %w", err)
	}
	switch resp = strings.TrimSpace(resp); {
	case resp == "ok":
		return nil
	case resp == "stale":
		return errNotOutstanding
	}
	return errors.New(strings.TrimPrefix(resp, "err "))
}

func acpAnswers(name string, w io.Writer) error {
	if !validSessionName(name) {
		return fmt.Errorf("invalid session name")
	}
	if _, err := readACPMeta(name); err != nil {
		return err
	}
	data, err := os.ReadFile(filepath.Join(acpDir(name), "answers.json"))
	if os.IsNotExist(err) || (err == nil && len(bytes.TrimSpace(data)) == 0) {
		data, err = []byte("{}"), nil
	}
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "%s\n", bytes.TrimSpace(data))
	return err
}
