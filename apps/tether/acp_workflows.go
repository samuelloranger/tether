package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// `acp workflows` reads Claude Code's own session files, a private layout that can change between
// releases: the transcript says when a background Workflow run was launched and when it ended,
// the run's journal says which agents started and finished. ACP carries neither.

type wfAgent struct {
	Label     string `json:"label"`
	State     string `json:"state"`
	StartedAt int64  `json:"startedAt,omitempty"`
	EndedAt   int64  `json:"endedAt,omitempty"`
	Activity  string `json:"activity,omitempty"`
}

type wfPhase struct {
	Title  string    `json:"title"`
	Agents []wfAgent `json:"agents"`
}

type wfCounts struct {
	Total   int `json:"total"`
	Running int `json:"running"`
	Done    int `json:"done"`
}

type wfRun struct {
	ToolCallID  string    `json:"toolCallId"`
	RunID       string    `json:"runId"`
	Title       string    `json:"title"`
	Description string    `json:"description,omitempty"`
	Status      string    `json:"status"`
	StartedAt   int64     `json:"startedAt,omitempty"`
	EndedAt     int64     `json:"endedAt,omitempty"`
	Summary     string    `json:"summary,omitempty"`
	Agents      wfCounts  `json:"agents"`
	Phases      []wfPhase `json:"phases"`
}

const wfQuoted = `(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|` + "`([^`]*)`)"

var (
	wfSessionIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	wfRunIDRe     = regexp.MustCompile(`^wf_[A-Za-z0-9_-]+$`)
	wfAgentIDRe   = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	wfRunLineRe   = regexp.MustCompile(`(?m)^Run ID: (wf_[A-Za-z0-9_-]+)\s*$`)
	wfSummaryRe   = regexp.MustCompile(`(?m)^Summary: (.*)$`)
	wfNoteIDRe    = regexp.MustCompile(`<tool-use-id>([^<\s]+)</tool-use-id>`)
	wfNoteStateRe = regexp.MustCompile(`<status>([^<]*)</status>`)
	wfNoteSumRe   = regexp.MustCompile(`(?s)<summary>(.*?)</summary>`)
	wfMetaNameRe  = regexp.MustCompile(`\bname:\s*` + wfQuoted)
	wfMetaDescRe  = regexp.MustCompile(`\bdescription:\s*` + wfQuoted)
	wfPhaseTitle  = regexp.MustCompile(`\btitle:\s*` + wfQuoted)
	wfPhasesOpen  = regexp.MustCompile(`\bphases:\s*\[`)
	wfPhasesClose = regexp.MustCompile(`(?m)^\s*\],?\s*$`)
	wfUnescape    = strings.NewReplacer(`\'`, `'`, `\"`, `"`, `\\`, `\`)
)

const (
	wfTailBytes    = 128 << 10
	wfMaxSummary   = 400
	wfMaxActivity  = 90
	wfMaxHeadBytes = 4 << 20
)

func acpWorkflows(args []string, w io.Writer) error {
	fs := flag.NewFlagSet("acp workflows", flag.ContinueOnError)
	session := fs.String("session", "", "the agent's session id (the Claude Code session)")
	_ = fs.Bool("json", false, "accepted for symmetry; the output is always JSON lines")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if !wfSessionIDRe.MatchString(*session) {
		return fmt.Errorf("usage: acp workflows --session <sessionId> [--json]")
	}
	enc := json.NewEncoder(w)
	for _, r := range readWorkflowRuns(claudeConfigDir(), *session) {
		_ = enc.Encode(r)
	}
	return nil
}

func claudeConfigDir() string {
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return d
	}
	base, err := os.UserHomeDir()
	if err != nil {
		base = "."
	}
	return filepath.Join(base, ".claude")
}

// readWorkflowRuns returns the session's Workflow runs in launch order; a missing session or
// unreadable file yields fewer (or no) runs, never an error.
func readWorkflowRuns(configDir, sessionID string) []wfRun {
	matches, _ := filepath.Glob(filepath.Join(configDir, "projects", "*", sessionID+".jsonl"))
	if len(matches) == 0 {
		return []wfRun{}
	}
	transcript := matches[0]
	sessionDir := strings.TrimSuffix(transcript, ".jsonl")
	runs := scanWorkflowTranscript(transcript)
	for i := range runs {
		fillWorkflowRun(&runs[i], sessionDir)
	}
	return runs
}

type wfTranscriptLine struct {
	Type      string          `json:"type"`
	Timestamp string          `json:"timestamp"`
	Content   json.RawMessage `json:"content"`
	Message   struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type wfBlock struct {
	Type      string          `json:"type"`
	ToolUseID string          `json:"tool_use_id"`
	Text      string          `json:"text"`
	Content   json.RawMessage `json:"content"`
}

// rawText reads a content field that is either a string or an array of text blocks.
func rawText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []wfBlock
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	var b strings.Builder
	for _, bl := range blocks {
		b.WriteString(bl.Text)
	}
	return b.String()
}

func parseTS(s string) int64 {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return 0
	}
	return t.Unix()
}

var (
	wfLaunchMarker = []byte("Workflow launched in background")
	wfNoteMarker   = []byte("<task-notification>")
	wfNoteMarkerU  = []byte(`\u003ctask-notification`)
)

type wfNote struct {
	status, summary string
	at              int64
}

func scanWorkflowTranscript(path string) []wfRun {
	runs := []wfRun{}
	f, err := os.Open(path)
	if err != nil {
		return runs
	}
	defer f.Close()
	byCall := map[string]bool{}
	notes := map[string]wfNote{}
	r := bufio.NewReaderSize(f, 1<<20)
	for {
		line, err := r.ReadBytes('\n')
		launch := bytes.Contains(line, wfLaunchMarker)
		if launch || bytes.Contains(line, wfNoteMarker) || bytes.Contains(line, wfNoteMarkerU) {
			var l wfTranscriptLine
			if json.Unmarshal(line, &l) == nil {
				if launch && l.Type == "user" {
					runs = appendLaunches(runs, byCall, l)
				} else if l.Type == "queue-operation" || l.Type == "user" {
					if id, n, ok := parseNotification(l); ok {
						if _, seen := notes[id]; !seen {
							notes[id] = n
						}
					}
				}
			}
		}
		if err != nil {
			break
		}
	}
	for i := range runs {
		if n, ok := notes[runs[i].ToolCallID]; ok {
			runs[i].Status, runs[i].Summary, runs[i].EndedAt = n.status, n.summary, n.at
		}
	}
	return runs
}

func appendLaunches(runs []wfRun, seen map[string]bool, l wfTranscriptLine) []wfRun {
	var blocks []wfBlock
	_ = json.Unmarshal(l.Message.Content, &blocks)
	for _, b := range blocks {
		if b.Type != "tool_result" || seen[b.ToolUseID] {
			continue
		}
		text := rawText(b.Content)
		m := wfRunLineRe.FindStringSubmatch(text)
		if !strings.HasPrefix(text, string(wfLaunchMarker)) || m == nil {
			continue
		}
		run := wfRun{ToolCallID: b.ToolUseID, RunID: m[1], Status: "running", Title: "Workflow", StartedAt: parseTS(l.Timestamp), Phases: []wfPhase{}}
		if s := wfSummaryRe.FindStringSubmatch(text); s != nil {
			run.Description = truncRunes(strings.TrimSpace(s[1]), wfMaxSummary)
		}
		seen[b.ToolUseID] = true
		runs = append(runs, run)
	}
	return runs
}

func parseNotification(l wfTranscriptLine) (string, wfNote, bool) {
	text := rawText(l.Content)
	if text == "" {
		text = rawText(l.Message.Content)
	}
	if !strings.HasPrefix(text, "<task-notification>") {
		return "", wfNote{}, false
	}
	id := wfNoteIDRe.FindStringSubmatch(text)
	if id == nil {
		return "", wfNote{}, false
	}
	n := wfNote{status: "completed", at: parseTS(l.Timestamp)}
	if s := wfNoteStateRe.FindStringSubmatch(text); s != nil && strings.TrimSpace(s[1]) != "" {
		n.status = strings.TrimSpace(s[1])
	}
	if s := wfNoteSumRe.FindStringSubmatch(text); s != nil {
		n.summary = truncRunes(strings.TrimSpace(s[1]), wfMaxSummary)
	}
	return id[1], n, true
}

func truncRunes(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

type wfSlot struct{ phase, agent int }

func fillWorkflowRun(run *wfRun, sessionDir string) {
	if !wfRunIDRe.MatchString(run.RunID) {
		return
	}
	var phaseTitles []string
	if scripts, _ := filepath.Glob(filepath.Join(sessionDir, "workflows", "scripts", "*-"+run.RunID+".js")); len(scripts) > 0 {
		name, desc, titles := parseWorkflowMeta(scripts[0])
		if name != "" {
			run.Title = name
		}
		if desc != "" {
			run.Description = truncRunes(desc, wfMaxSummary)
		}
		phaseTitles = titles
	}
	dir := filepath.Join(sessionDir, "subagents", "workflows", run.RunID)
	phases := []wfPhase{}
	index := map[string]int{}
	phaseAt := func(title string) int {
		if i, ok := index[title]; ok {
			return i
		}
		index[title] = len(phases)
		phases = append(phases, wfPhase{Title: title, Agents: []wfAgent{}})
		return index[title]
	}
	for _, t := range phaseTitles {
		phaseAt(t)
	}
	byKey := map[string]wfSlot{}
	agentIDs := map[string]string{}
	if jf, err := os.Open(filepath.Join(dir, "journal.jsonl")); err == nil {
		r := bufio.NewReaderSize(jf, 256<<10)
		for {
			line, err := r.ReadBytes('\n')
			if bytes.Contains(line, []byte(`"type":"started"`)) || bytes.Contains(line, []byte(`"type":"result"`)) {
				var e struct {
					Type    string `json:"type"`
					Key     string `json:"key"`
					AgentID string `json:"agentId"`
					Label   string `json:"label"`
					Phase   string `json:"phase"`
				}
				if json.Unmarshal(line, &e) == nil && e.Key != "" {
					switch e.Type {
					case "started":
						if s, dup := byKey[e.Key]; dup {
							phases[s.phase].Agents[s.agent].State = "running"
						} else {
							pi := phaseAt(e.Phase)
							byKey[e.Key] = wfSlot{pi, len(phases[pi].Agents)}
							phases[pi].Agents = append(phases[pi].Agents, wfAgent{Label: e.Label, State: "running"})
						}
						agentIDs[e.Key] = e.AgentID
					case "result":
						if s, ok := byKey[e.Key]; ok {
							phases[s.phase].Agents[s.agent].State = "done"
						}
					}
				}
			}
			if err != nil {
				break
			}
		}
		jf.Close()
	}
	for key, s := range byKey {
		a := &phases[s.phase].Agents[s.agent]
		id := agentIDs[key]
		if !wfAgentIDRe.MatchString(id) {
			continue
		}
		file := filepath.Join(dir, "agent-"+id+".jsonl")
		if ts := firstLineTimestamp(file); ts != "" {
			a.StartedAt = parseTS(ts)
		}
		activity, last := tailInfo(file)
		if a.State == "done" {
			a.EndedAt = parseTS(last)
		} else if run.Status == "running" {
			a.Activity = activity
		}
	}
	run.Phases = phases
	for _, p := range phases {
		for _, a := range p.Agents {
			run.Agents.Total++
			if a.State == "done" {
				run.Agents.Done++
			} else {
				run.Agents.Running++
			}
		}
	}
}

func parseWorkflowMeta(path string) (name, desc string, phases []string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	buf, _ := io.ReadAll(io.LimitReader(f, 16<<10))
	src := string(buf)
	pick := func(m []string) string {
		for _, s := range m[1:] {
			if s != "" {
				return wfUnescape.Replace(s)
			}
		}
		return ""
	}
	head := src
	if loc := wfPhasesOpen.FindStringIndex(src); loc != nil {
		head = src[:loc[0]]
		rest := src[loc[1]:]
		if end := wfPhasesClose.FindStringIndex(rest); end != nil {
			rest = rest[:end[0]]
		}
		for _, m := range wfPhaseTitle.FindAllStringSubmatch(rest, -1) {
			if t := pick(m); t != "" {
				phases = append(phases, t)
			}
		}
	}
	if m := wfMetaNameRe.FindStringSubmatch(head); m != nil {
		name = pick(m)
	}
	if m := wfMetaDescRe.FindStringSubmatch(head); m != nil {
		desc = pick(m)
	}
	return
}

func firstLineTimestamp(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	line, _ := bufio.NewReaderSize(io.LimitReader(f, wfMaxHeadBytes), 64<<10).ReadBytes('\n')
	var l struct {
		Timestamp string `json:"timestamp"`
	}
	_ = json.Unmarshal(line, &l)
	return l.Timestamp
}

// tailInfo reads a bounded tail of an agent transcript: the newest tool call as a short string and
// the timestamp of the last complete line.
func tailInfo(path string) (activity, lastTS string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return
	}
	off := st.Size() - wfTailBytes
	if off < 0 {
		off = 0
	}
	buf := make([]byte, st.Size()-off)
	if _, err := f.ReadAt(buf, off); err != nil && err != io.EOF {
		return
	}
	lines := bytes.Split(bytes.TrimRight(buf, "\n"), []byte("\n"))
	if off > 0 && len(lines) > 0 {
		lines = lines[1:]
	}
	for i := len(lines) - 1; i >= 0; i-- {
		var l struct {
			Type      string `json:"type"`
			Timestamp string `json:"timestamp"`
			Message   struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(lines[i], &l) != nil {
			continue
		}
		if lastTS == "" {
			lastTS = l.Timestamp
		}
		if l.Type == "assistant" {
			var blocks []struct {
				Type  string                     `json:"type"`
				Name  string                     `json:"name"`
				Input map[string]json.RawMessage `json:"input"`
			}
			if json.Unmarshal(l.Message.Content, &blocks) == nil {
				for j := len(blocks) - 1; j >= 0; j-- {
					if blocks[j].Type == "tool_use" {
						return toolActivity(blocks[j].Name, blocks[j].Input), lastTS
					}
				}
			}
		}
	}
	return
}

func toolActivity(name string, input map[string]json.RawMessage) string {
	for _, k := range []string{"command", "file_path", "path", "pattern", "url", "query", "description", "prompt"} {
		var s string
		if json.Unmarshal(input[k], &s) == nil && s != "" {
			return truncRunes(name+": "+strings.Join(strings.Fields(s), " "), wfMaxActivity)
		}
	}
	return name
}
