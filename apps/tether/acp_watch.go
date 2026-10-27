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
	"slices"
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

// errBadOption maps to exit 3: --option is not one of the choices the elicitation offered.
var errBadOption = errors.New("option is not one of the offered choices")

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
	// Elicitation requests (elicitation/create): the form's message, the first property's name, its
	// choices (in Options, kind "choice") and whether the form is just that one question.
	Elicitation bool   `json:"elicitation,omitempty"`
	Message     string `json:"message,omitempty"`
	Prop        string `json:"prop,omitempty"`
	Simple      bool   `json:"simple,omitempty"`
}

type acpTrackerState struct {
	Title    string                 `json:"title,omitempty"`
	Requests map[string]*acpRequest `json:"requests"`
	Prompts  []string               `json:"prompts,omitempty"`
	// Terminals are tool calls with a display terminal not yet exited; Tasks are those that went to
	// the background, which run until their terminal_exit arrives after the turn.
	Terminals []string `json:"terminals,omitempty"`
	Tasks     []string `json:"tasks,omitempty"`
	// Loads are session/load requests not yet answered: the history they replay is no turn.
	Loads []string `json:"loads,omitempty"`
	// Autonomous is a turn Claude Code started without a prompt, after a background task ended.
	Autonomous bool `json:"autonomous,omitempty"`
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
	// done holds requests a client answered, so a second client's answer is not sent too.
	done map[string]bool
}

func loadACPTracker(name string) *acpTracker {
	t := &acpTracker{name: name, dir: acpDir(name), answers: map[string]string{}, done: map[string]bool{}}
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
	idle       *copilotIdle
}

func (t *acpTracker) agentLine(line []byte) acpEvent {
	m, key, ok := parseRPC(line)
	if !ok {
		return acpEvent{}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	switch {
	case (m.Method == "session/request_permission" || m.Method == "elicitation/create") && key != "":
		if _, dup := t.st.Requests[key]; dup {
			return acpEvent{}
		}
		if _, done := t.answers[key]; done {
			return acpEvent{}
		}
		if m.Method == "elicitation/create" {
			req := parseElicitation(key, m.Params)
			t.st.Requests[key] = req
			t.saveLocked()
			return acpEvent{permission: req, key: key}
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
			Update acpUpdateLine `json:"update"`
		}
		if json.Unmarshal(m.Params, &p) != nil {
			return acpEvent{}
		}
		u := p.Update
		if u.Kind == "session_info_update" && u.Title != nil && *u.Title != t.st.Title {
			t.st.Title = *u.Title
			t.saveLocked()
		}
		return t.updateLocked(u)
	case m.Method == copilotSessionEvent:
		return t.sessionEventLocked(m.Params)
	case m.Method == "" && key != "":
		if i := slices.Index(t.st.Loads, key); i >= 0 {
			// A loaded conversation's background tasks died with the agent that ran them.
			t.st.Loads = slices.Delete(t.st.Loads, i, i+1)
			t.st.Terminals, t.st.Tasks, t.st.Autonomous = nil, nil, false
			t.saveLocked()
			return acpEvent{}
		}
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

type acpUpdateLine struct {
	Kind       string          `json:"sessionUpdate"`
	Title      *string         `json:"title"`
	ToolCallID string          `json:"toolCallId"`
	Cost       json.RawMessage `json:"cost"`
	Meta       struct {
		TerminalInfo json.RawMessage `json:"terminal_info"`
		TerminalExit json.RawMessage `json:"terminal_exit"`
		ClaudeCode   struct {
			// Raw: an MCP tool's response is an array, which a struct would refuse with the whole line.
			ToolResponse json.RawMessage `json:"toolResponse"`
		} `json:"claudeCode"`
	} `json:"_meta"`
}

func (u acpUpdateLine) backgroundTaskID() string {
	var r struct {
		BackgroundTaskID string `json:"backgroundTaskId"`
	}
	_ = json.Unmarshal(u.Meta.ClaudeCode.ToolResponse, &r)
	return r.BackgroundTaskID
}

// updateLocked follows background commands and the turns Claude Code starts by itself. Such a turn
// has no prompt to answer: it starts with agent output while nothing is in flight and ends at the
// usage report that carries the turn's cost.
func (t *acpTracker) updateLocked(u acpUpdateLine) acpEvent {
	changed := false
	if id := u.ToolCallID; id != "" {
		if len(u.Meta.TerminalInfo) > 0 && !slices.Contains(t.st.Terminals, id) {
			t.st.Terminals = append(t.st.Terminals, id)
			changed = true
		}
		if u.backgroundTaskID() != "" && slices.Contains(t.st.Terminals, id) && !slices.Contains(t.st.Tasks, id) {
			t.st.Tasks = append(t.st.Tasks, id)
			changed = true
		}
		if len(u.Meta.TerminalExit) > 0 {
			before := len(t.st.Terminals) + len(t.st.Tasks)
			t.st.Terminals = slices.DeleteFunc(t.st.Terminals, func(s string) bool { return s == id })
			t.st.Tasks = slices.DeleteFunc(t.st.Tasks, func(s string) bool { return s == id })
			changed = changed || before != len(t.st.Terminals)+len(t.st.Tasks)
		}
	}
	idle := len(t.st.Prompts) == 0 && len(t.st.Loads) == 0
	var ev acpEvent
	switch {
	case idle && !t.st.Autonomous && (u.Kind == "agent_message_chunk" || u.Kind == "agent_thought_chunk" || u.Kind == "tool_call"):
		t.st.Autonomous = true
		changed = true
	case idle && t.st.Autonomous && u.Kind == "usage_update" && len(u.Cost) > 0 && string(u.Cost) != "null":
		t.st.Autonomous = false
		changed = true
		ev = acpEvent{turnEnded: true, stopReason: "end_turn"}
	}
	if changed {
		t.saveLocked()
	}
	return ev
}

// parseElicitation keeps the message and, when the form's first property is a single-select string
// with oneOf, its choices. Simple means that question is the whole form (bar its "_custom" note).
func parseElicitation(key string, params json.RawMessage) *acpRequest {
	req := &acpRequest{ID: json.RawMessage(key), Elicitation: true}
	var p struct {
		Message         string `json:"message"`
		RequestedSchema struct {
			Properties json.RawMessage `json:"properties"`
		} `json:"requestedSchema"`
	}
	_ = json.Unmarshal(params, &p)
	req.Message = p.Message
	names, props := orderedProps(p.RequestedSchema.Properties)
	if len(names) == 0 {
		return req
	}
	var first struct {
		Type  string `json:"type"`
		OneOf []struct {
			Const string `json:"const"`
			Title string `json:"title"`
		} `json:"oneOf"`
	}
	if json.Unmarshal(props[names[0]], &first) != nil || first.Type != "string" || len(first.OneOf) == 0 {
		return req
	}
	req.Prop = names[0]
	for _, c := range first.OneOf {
		name := c.Title
		if name == "" {
			name = c.Const
		}
		req.Options = append(req.Options, acpOption{OptionID: c.Const, Name: name, Kind: "choice"})
	}
	req.Simple = len(names) == 1 || (len(names) == 2 && names[1] == names[0]+"_custom")
	return req
}

// orderedProps returns a JSON object's keys in document order.
func orderedProps(raw json.RawMessage) ([]string, map[string]json.RawMessage) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil, nil
	}
	var names []string
	props := map[string]json.RawMessage{}
	for dec.More() {
		tok, err := dec.Token()
		key, ok := tok.(string)
		if err != nil || !ok {
			return nil, nil
		}
		var v json.RawMessage
		if dec.Decode(&v) != nil {
			return nil, nil
		}
		names = append(names, key)
		props[key] = v
	}
	return names, props
}

// clientLine reports whether the line goes to the agent (an answer to a request that was answered
// already does not: another client got there first) and whether the other clients must see it.
func (t *acpTracker) clientLine(line []byte) (forward, echo bool) {
	m, key, ok := parseRPC(line)
	if !ok {
		return true, false
	}
	if m.Method == "session/cancel" {
		t.mu.Lock()
		if t.st.Autonomous {
			t.st.Autonomous = false
			t.saveLocked()
		}
		t.mu.Unlock()
		return true, true
	}
	if key == "" {
		return true, false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	switch {
	case m.Method == "session/new" || m.Method == "session/load":
		if m.Method == "session/load" {
			t.st.Loads = append(t.st.Loads, key)
			t.saveLocked()
		}
		// A client joining later learns the session from these when no prompt names it yet.
		return true, true
	case m.Method == "session/prompt":
		t.st.Prompts = append(t.st.Prompts, key)
		t.st.Autonomous = false
		t.saveLocked()
		return true, true
	case m.Method == "":
		if _, ok := t.st.Requests[key]; ok {
			delete(t.st.Requests, key)
			t.done[key] = true
			t.saveLocked()
			return true, true
		}
		_, answered := t.answers[key]
		if answered || t.done[key] {
			return false, false
		}
		return true, true
	}
	return true, false
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

// snapshot is the chat title, the turn (waiting while a request is outstanding, else working
// while a session/prompt or a turn the agent started is running, else idle) and the number of
// background commands still running.
func (t *acpTracker) snapshot() (string, string, int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	switch {
	case len(t.st.Requests) > 0:
		return t.st.Title, "waiting", len(t.st.Tasks)
	case len(t.st.Prompts) > 0 || t.st.Autonomous:
		return t.st.Title, "working", len(t.st.Tasks)
	}
	return t.st.Title, "idle", len(t.st.Tasks)
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
func (t *acpTracker) answer(key string, write func(req *acpRequest) (string, error)) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	r := t.st.Requests[key]
	if r == nil {
		return errNotOutstanding
	}
	value, err := write(r)
	if err != nil {
		return err
	}
	delete(t.st.Requests, key)
	t.answers[key] = value
	t.done[key] = true
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
	return len(s.live) > 0
}

// acpHandshakeGrace is how long a push waits when a client has connected but not yet sent its
// first line: that client is about to be the attached one and must not be pushed over.
const acpHandshakeGrace = 400 * time.Millisecond

// whenDetached runs push, after claim succeeds, only if no client is attached. A client that is
// mid-handshake when the event arrives is given acpHandshakeGrace to finish before deciding.
func (s *acpDaemonState) whenDetached(claim func() bool, push func()) {
	s.mu.Lock()
	attached, dialing := len(s.live) > 0, s.handshaking > 0
	s.mu.Unlock()
	switch {
	case attached:
	case !dialing:
		if claim() {
			push()
		}
	default:
		s.pushes.Add(1)
		go func() {
			defer s.pushes.Done()
			time.Sleep(acpHandshakeGrace)
			if !s.attached() && claim() {
				push()
			}
		}()
	}
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
		s.syncStream()
		switch {
		case ev.permission != nil:
			s.whenDetached(func() bool { return s.tr.claimNotify(ev.key) }, func() {
				s.pushAsync(s.permissionPush(ev.permission), "acp-"+s.collapseSuffix(ev.key))
			})
		case ev.turnEnded:
			s.whenDetached(func() bool { return true }, func() {
				s.pushAsync(s.donePush(ev.stopReason), "acp-done-"+threadKey(hostLabel(), s.tr.name))
			})
		case ev.idle != nil:
			s.settleAfterIdle(ev.idle)
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
			fmt.Fprintf(s.errf, "tether: acp push failed: %v\n", err)
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

func (s *acpDaemonState) elicitationPush(req *acpRequest) PushContent {
	chat := s.tr.chatName()
	body := clip(req.Message, 200)
	if body == "" {
		body = "Needs your input"
	}
	c := PushContent{
		Title: clip(chat, 60) + " · needs you", Body: body, Link: s.link(),
		Category: acpPermissionCategory, State: "waiting", Version: s.collapseSuffix(string(req.ID)),
		Session: chat, Level: levelUrgent, ACPSession: s.tr.name, RequestID: string(req.ID), Elicitation: true,
	}
	if req.Simple && len(req.Options) >= 2 && len(req.Options) <= maxPushOptions {
		for _, o := range req.Options {
			c.Options = append(c.Options, o.Name)
			c.OptionIDs = append(c.OptionIDs, o.OptionID)
			c.OptionKinds = append(c.OptionKinds, o.Kind)
		}
	}
	return c
}

func (s *acpDaemonState) permissionPush(req *acpRequest) PushContent {
	if req.Elicitation {
		return s.elicitationPush(req)
	}
	chat := s.tr.chatName()
	what := req.Title
	if what == "" {
		what = req.Kind
	}
	if what == "" {
		what = "a tool"
	}
	body := "Allow: " + clip(what, 120) + "?"
	if req.Kind == "switch_mode" {
		body = "Approve the plan?"
	}
	c := PushContent{
		Title: clip(chat, 60) + " · needs you", Body: body, Link: s.link(),
		Category: acpPermissionCategory, State: "waiting", Version: s.collapseSuffix(string(req.ID)),
		Session: chat, Level: levelUrgent, ACPSession: s.tr.name, RequestID: string(req.ID),
	}
	opts := pickPushOptions(req.Options)
	if len(opts) >= 2 {
		for _, o := range opts {
			c.Options = append(c.Options, o.Name)
			c.OptionIDs = append(c.OptionIDs, o.OptionID)
			c.OptionKinds = append(c.OptionKinds, o.Kind)
		}
	}
	return c
}

// pickPushOptions keeps at most maxPushOptions buttons in the agent's order, and never drops
// the first rejection: a plan approval offers five options with "no" last, and a lock-screen
// prompt with only approvals would leave no way to say no.
func pickPushOptions(opts []acpOption) []acpOption {
	if len(opts) <= maxPushOptions {
		return opts
	}
	keep := make([]bool, len(opts))
	left := maxPushOptions
	for i, o := range opts {
		if strings.HasPrefix(o.Kind, "reject") {
			keep[i] = true
			left--
			break
		}
	}
	for i := range opts {
		if left == 0 {
			break
		}
		if !keep[i] {
			keep[i] = true
			left--
		}
	}
	var out []acpOption
	for i, o := range opts {
		if keep[i] {
			out = append(out, o)
		}
	}
	return out
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
	// Decline answers an elicitation with action decline.
	Decline bool `json:"decline,omitempty"`
}

// control serves one answer message: a verb line, one reply line. The connection is
// never made the current client.
func (s *acpDaemonState) control(conn net.Conn, rest string) {
	defer conn.Close()
	reply := func(v string) { _, _ = io.WriteString(conn, v+"\n") }
	var msg acpAnswerMsg
	var key bytes.Buffer
	if json.Unmarshal([]byte(rest), &msg) != nil || json.Compact(&key, msg.ID) != nil || !exactlyOne(msg.Option != "", msg.Cancel, msg.Decline) {
		reply("err bad answer")
		return
	}

	defer s.syncStream()
	s.mu.Lock()
	defer s.mu.Unlock()
	err := s.tr.answer(key.String(), func(req *acpRequest) (string, error) {
		result, v, err := answerResult(req, msg)
		if err != nil {
			return "", err
		}
		if s.ended {
			return "", errors.New("agent has exited")
		}
		line, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": json.RawMessage(key.Bytes()), "result": result})
		s.echoLocked("host", line)
		_, err = s.stdin.Write(append(line, '\n'))
		return v, err
	})
	switch {
	case err == nil:
		reply("ok")
	case errors.Is(err, errNotOutstanding):
		reply("stale")
	case errors.Is(err, errBadOption):
		reply("badoption")
	default:
		reply("err " + err.Error())
	}
}

func exactlyOne(bs ...bool) bool {
	n := 0
	for _, b := range bs {
		if b {
			n++
		}
	}
	return n == 1
}

// answerResult builds the JSON-RPC result for a request and the value recorded in answers.json.
func answerResult(req *acpRequest, msg acpAnswerMsg) (any, string, error) {
	if !req.Elicitation {
		if msg.Decline {
			return nil, "", errors.New("decline applies to elicitation requests only")
		}
		if msg.Cancel {
			return map[string]any{"outcome": map[string]any{"outcome": "cancelled"}}, "cancelled", nil
		}
		return map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": msg.Option}}, msg.Option, nil
	}
	switch {
	case msg.Cancel:
		return map[string]any{"action": "cancel"}, "cancelled", nil
	case msg.Decline:
		return map[string]any{"action": "decline"}, "declined", nil
	}
	for _, o := range req.Options {
		if req.Prop != "" && o.OptionID == msg.Option {
			return map[string]any{"action": "accept", "content": map[string]any{req.Prop: msg.Option}}, msg.Option, nil
		}
	}
	return nil, "", errBadOption
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
		return fmt.Errorf("usage: acp answer <name> --request ID (--option OPTION_ID | --cancel | --decline)")
	}
	name := args[0]
	fs := flag.NewFlagSet("acp answer", flag.ContinueOnError)
	request := fs.String("request", "", "JSON-RPC id of the permission request, as JSON text")
	option := fs.String("option", "", "optionId to select")
	cancel := fs.Bool("cancel", false, "answer with outcome cancelled")
	decline := fs.Bool("decline", false, "decline an elicitation request")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if !validSessionName(name) {
		return fmt.Errorf("invalid session name")
	}
	if *request == "" || !exactlyOne(*option != "", *cancel, *decline) {
		return fmt.Errorf("acp answer needs --request and exactly one of --option, --cancel or --decline")
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
	body, _ := json.Marshal(acpAnswerMsg{ID: id, Option: *option, Cancel: *cancel, Decline: *decline})
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
	case resp == "badoption":
		return errBadOption
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
