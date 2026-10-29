package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// `acp workflows` reads Claude Code's own session files, a private layout that can change between
// releases: the transcript says when a background Workflow run was launched and when it ended,
// the run's journal says which agents started and finished. ACP carries neither.

type wfAgent struct {
	Label     string `json:"label"`
	State     string `json:"state"` // running, done, or stopped (no result and the run is over)
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
	Stopped int `json:"stopped,omitempty"`
}

type wfRun struct {
	ToolCallID  string `json:"toolCallId"`
	RunID       string `json:"runId"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
	Status      string `json:"status"`
	StartedAt   int64  `json:"startedAt,omitempty"`
	EndedAt     int64  `json:"endedAt,omitempty"`
	// LastActivityAt is the newest write to the run's journal or agent transcripts, so a client
	// can tell a quiet run from a live one when no end notification has arrived.
	LastActivityAt int64     `json:"lastActivityAt,omitempty"`
	Summary        string    `json:"summary,omitempty"`
	Agents         wfCounts  `json:"agents"`
	Phases         []wfPhase `json:"phases"`
}

const wfQuoted = `(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|` + "`((?:\\\\.|[^`\\\\])*)`)"

var (
	wfSessionIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	wfRunIDRe     = regexp.MustCompile(`^wf_[A-Za-z0-9_-]+$`)
	wfAgentIDRe   = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	wfRunLineRe   = regexp.MustCompile(`(?m)^Run ID: (wf_[A-Za-z0-9_-]+)\s*$`)
	wfSummaryRe   = regexp.MustCompile(`(?m)^Summary: (.*)$`)
	wfNoteIDRe    = regexp.MustCompile(`<tool-use-id>([^<\s]+)</tool-use-id>`)
	wfNoteStateRe = regexp.MustCompile(`<status>([^<]*)</status>`)
	wfNoteSumRe   = regexp.MustCompile(`(?s)<summary>(.*?)</summary>`)
	wfRawStampRe  = regexp.MustCompile(`"timestamp":"([^"]+)"`)
	wfMetaNameRe  = regexp.MustCompile(`\bname:\s*` + wfQuoted)
	wfMetaDescRe  = regexp.MustCompile(`\bdescription:\s*` + wfQuoted)
	wfPhaseTitle  = regexp.MustCompile(`\btitle:\s*` + wfQuoted)
	wfPhasesOpen  = regexp.MustCompile(`\bphases:\s*\[`)
	wfPhasesClose = regexp.MustCompile(`(?m)^\s*\],?\s*$`)
)

const (
	wfTailBytes    = 128 << 10
	wfMaxSummary   = 400
	wfMaxActivity  = 90
	wfMaxHeadBytes = 4 << 20
	wfCacheMaxAge  = 14 * 24 * time.Hour
)

// A transcript line longer than wfMaxLine is never held whole: only its first wfPrefixBytes are
// looked at, which is enough to read a task notification that carries a large result.
var (
	wfMaxLine     = 1 << 20
	wfPrefixBytes = 64 << 10
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

// findTranscript returns the newest `<config>/projects/<dir>/<session>.jsonl`: the same session id
// can sit under several project directories.
func findTranscript(configDir, sessionID string) string {
	entries, err := os.ReadDir(filepath.Join(configDir, "projects"))
	if err != nil {
		return ""
	}
	var best string
	var bestTime time.Time
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		path := filepath.Join(configDir, "projects", e.Name(), sessionID+".jsonl")
		st, err := os.Stat(path)
		if err != nil || !st.Mode().IsRegular() {
			continue
		}
		if best == "" || st.ModTime().After(bestTime) {
			best, bestTime = path, st.ModTime()
		}
	}
	return best
}

// readWorkflowRuns returns the session's Workflow runs in launch order; a missing session or
// unreadable file yields fewer (or no) runs, never an error.
func readWorkflowRuns(configDir, sessionID string) []wfRun {
	transcript := findTranscript(configDir, sessionID)
	if transcript == "" {
		return []wfRun{}
	}
	sessionDir := strings.TrimSuffix(transcript, ".jsonl")
	runs := scanWorkflowTranscript(transcript, sessionID)
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
	Status  string `json:"status"`
	Summary string `json:"summary"`
	At      int64  `json:"at"`
}

type wfLaunch struct {
	ToolCallID  string `json:"toolCallId"`
	RunID       string `json:"runId"`
	Description string `json:"description,omitempty"`
	StartedAt   int64  `json:"startedAt,omitempty"`
}

// wfScan is what a transcript scan found, plus how far it got; it is the unit that is cached.
type wfScan struct {
	Path     string            `json:"path"`
	Inode    uint64            `json:"inode"`
	Offset   int64             `json:"offset"`
	HeadCRC  uint32            `json:"headCrc"`
	Launches []wfLaunch        `json:"launches"`
	Notes    map[string]wfNote `json:"notes"`
}

const wfHeadCheckBytes = 4096

func fileInode(st os.FileInfo) uint64 {
	if s, ok := st.Sys().(*syscall.Stat_t); ok {
		return uint64(s.Ino)
	}
	return 0
}

func headCRC(f *os.File, upTo int64) (uint32, bool) {
	n := upTo
	if n > wfHeadCheckBytes {
		n = wfHeadCheckBytes
	}
	buf := make([]byte, n)
	if _, err := f.ReadAt(buf, 0); err != nil && err != io.EOF {
		return 0, false
	}
	return crc32.ChecksumIEEE(buf), true
}

func wfCachePath(sessionID string) string {
	return filepath.Join(home(), "workflows", sessionID+".json")
}

func loadWfCache(sessionID string) *wfScan {
	b, err := os.ReadFile(wfCachePath(sessionID))
	if err != nil {
		return nil
	}
	var c wfScan
	if json.Unmarshal(b, &c) != nil || c.Notes == nil {
		return nil
	}
	return &c
}

func saveWfCache(sessionID string, c *wfScan) {
	dir := filepath.Dir(wfCachePath(sessionID))
	if os.MkdirAll(dir, 0o700) != nil {
		return
	}
	b, err := json.Marshal(c)
	if err != nil {
		return
	}
	tmp, err := os.CreateTemp(dir, ".wf-*")
	if err != nil {
		return
	}
	_, werr := tmp.Write(b)
	cerr := tmp.Close()
	if werr != nil || cerr != nil || os.Rename(tmp.Name(), wfCachePath(sessionID)) != nil {
		os.Remove(tmp.Name())
		return
	}
	pruneWfCache(dir)
}

func pruneWfCache(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > wfCacheMaxAge {
			os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

// readBoundedLine reads one line without ever holding more than max bytes of it. A longer line
// comes back as its first prefix bytes with long set, the rest discarded. consumed counts every
// byte read; complete is false when the data ended before a newline.
func readBoundedLine(r *bufio.Reader, max, prefix int) (line []byte, long, complete bool, consumed int64, err error) {
	for {
		chunk, e := r.ReadSlice('\n')
		consumed += int64(len(chunk))
		if !long {
			line = append(line, chunk...)
			if len(line) > max {
				long = true
				line = line[:prefix]
			}
		}
		if e == nil {
			complete = true
			return
		}
		if e == bufio.ErrBufferFull {
			continue
		}
		return line, long, false, consumed, e
	}
}

func scanWorkflowTranscript(path, sessionID string) []wfRun {
	runs := []wfRun{}
	f, err := os.Open(path)
	if err != nil {
		return runs
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return runs
	}
	inode := fileInode(st)
	scan := &wfScan{Path: path, Inode: inode, Notes: map[string]wfNote{}}
	if c := loadWfCache(sessionID); c != nil && c.Path == path && c.Inode == inode && c.Offset <= st.Size() {
		if crc, ok := headCRC(f, c.Offset); ok && crc == c.HeadCRC {
			scan = c
		}
	}
	start := scan.Offset
	seen := map[string]bool{}
	for _, l := range scan.Launches {
		seen[l.ToolCallID] = true
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return runs
	}
	r := bufio.NewReaderSize(f, 256<<10)
	for {
		line, long, complete, n, err := readBoundedLine(r, wfMaxLine, wfPrefixBytes)
		if !complete {
			break
		}
		scan.Offset += n
		scanWorkflowLine(scan, seen, line, long)
		if err != nil {
			break
		}
	}
	if scan.Offset != start {
		if crc, ok := headCRC(f, scan.Offset); ok {
			scan.HeadCRC = crc
			saveWfCache(sessionID, scan)
		}
	}
	for _, l := range scan.Launches {
		run := wfRun{ToolCallID: l.ToolCallID, RunID: l.RunID, Status: "running", Title: "Workflow", Description: l.Description, StartedAt: l.StartedAt, Phases: []wfPhase{}}
		if n, ok := scan.Notes[l.ToolCallID]; ok {
			run.Status, run.Summary, run.EndedAt = n.Status, n.Summary, n.At
		}
		runs = append(runs, run)
	}
	return runs
}

func scanWorkflowLine(scan *wfScan, seen map[string]bool, line []byte, long bool) {
	isNote := bytes.Contains(line, wfNoteMarker) || bytes.Contains(line, wfNoteMarkerU)
	launch := !long && bytes.Contains(line, wfLaunchMarker)
	if !isNote && !launch {
		return
	}
	if long {
		if id, n, ok := parseRawNotification(line); ok {
			if _, dup := scan.Notes[id]; !dup {
				scan.Notes[id] = n
			}
		}
		return
	}
	var l wfTranscriptLine
	if json.Unmarshal(line, &l) != nil {
		return
	}
	if launch && l.Type == "user" {
		scan.Launches = appendLaunches(scan.Launches, seen, l)
	} else if l.Type == "queue-operation" || l.Type == "user" {
		if id, n, ok := parseNotification(l); ok {
			if _, dup := scan.Notes[id]; !dup {
				scan.Notes[id] = n
			}
		}
	}
}

func appendLaunches(launches []wfLaunch, seen map[string]bool, l wfTranscriptLine) []wfLaunch {
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
		launch := wfLaunch{ToolCallID: b.ToolUseID, RunID: m[1], StartedAt: parseTS(l.Timestamp)}
		if s := wfSummaryRe.FindStringSubmatch(text); s != nil {
			launch.Description = truncRunes(strings.TrimSpace(s[1]), wfMaxSummary)
		}
		seen[b.ToolUseID] = true
		launches = append(launches, launch)
	}
	return launches
}

func noteFromText(text, stamp string) (string, wfNote, bool) {
	if !strings.HasPrefix(text, "<task-notification>") {
		return "", wfNote{}, false
	}
	id := wfNoteIDRe.FindStringSubmatch(text)
	if id == nil {
		return "", wfNote{}, false
	}
	n := wfNote{Status: "completed", At: parseTS(stamp)}
	if s := wfNoteStateRe.FindStringSubmatch(text); s != nil && strings.TrimSpace(s[1]) != "" {
		n.Status = strings.TrimSpace(s[1])
	}
	if s := wfNoteSumRe.FindStringSubmatch(text); s != nil {
		n.Summary = truncRunes(strings.TrimSpace(s[1]), wfMaxSummary)
	}
	return id[1], n, true
}

func parseNotification(l wfTranscriptLine) (string, wfNote, bool) {
	text := rawText(l.Content)
	if text == "" {
		text = rawText(l.Message.Content)
	}
	return noteFromText(text, l.Timestamp)
}

// parseRawNotification reads a notification from the start of a line too long to decode: the
// content is still JSON-escaped, so it is unquoted first.
func parseRawNotification(prefix []byte) (string, wfNote, bool) {
	i := bytes.Index(prefix, []byte(`"content":"`))
	if i < 0 {
		return "", wfNote{}, false
	}
	raw := prefix[i+len(`"content":`):]
	// Cut at the first unescaped quote if the string closes inside the prefix; otherwise the
	// prefix ends mid-string and is closed by hand.
	end := len(raw)
	for j := 1; j < len(raw); j++ {
		if raw[j] == '\\' {
			j++
		} else if raw[j] == '"' {
			end = j + 1
			break
		}
	}
	quoted := raw[:end]
	if end == len(raw) {
		quoted = append(bytes.TrimRight(quoted, `\`), '"')
	}
	text, err := strconv.Unquote(string(quoted))
	if err != nil {
		var s string
		if json.Unmarshal(quoted, &s) != nil {
			return "", wfNote{}, false
		}
		text = s
	}
	stamp := ""
	if m := wfRawStampRe.FindSubmatch(prefix); m != nil {
		stamp = string(m[1])
	}
	return noteFromText(text, stamp)
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
	var newest time.Time
	touch := func(path string) {
		if st, err := os.Stat(path); err == nil && st.ModTime().After(newest) {
			newest = st.ModTime()
		}
	}
	journal := filepath.Join(dir, "journal.jsonl")
	if jf, err := os.Open(journal); err == nil {
		touch(journal)
		r := bufio.NewReaderSize(jf, 256<<10)
		for {
			line, _, complete, _, err := readBoundedLine(r, wfMaxLine, wfPrefixBytes)
			if !complete && len(line) == 0 {
				break
			}
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
						if _, dup := byKey[e.Key]; !dup {
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
		touch(file)
		if ts := firstLineTimestamp(file); ts != "" {
			a.StartedAt = parseTS(ts)
		}
		activity, last := tailInfo(file)
		switch {
		case a.State == "done":
			a.EndedAt = parseTS(last)
		case run.Status == "running":
			a.Activity = activity
		default:
			a.State = "stopped"
			a.EndedAt = parseTS(last)
		}
	}
	if !newest.IsZero() {
		run.LastActivityAt = newest.Unix()
	}
	run.Phases = phases
	for _, p := range phases {
		for _, a := range p.Agents {
			run.Agents.Total++
			switch a.State {
			case "done":
				run.Agents.Done++
			case "stopped":
				run.Agents.Stopped++
			default:
				run.Agents.Running++
			}
		}
	}
}

// unescapeJS undoes the escapes a quoted JavaScript string literal can carry.
func unescapeJS(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	rs := []rune(s)
	for i := 0; i < len(rs); i++ {
		if rs[i] != '\\' || i+1 == len(rs) {
			b.WriteRune(rs[i])
			continue
		}
		i++
		switch rs[i] {
		case 'n':
			b.WriteByte('\n')
		case 't':
			b.WriteByte('\t')
		case 'r':
			b.WriteByte('\r')
		case 'b':
			b.WriteByte('\b')
		case 'f':
			b.WriteByte('\f')
		case 'v':
			b.WriteByte('\v')
		case '0':
			b.WriteByte(0)
		case '\n':
		case 'x', 'u':
			width := 2
			if rs[i] == 'u' {
				width = 4
			}
			if i+width < len(rs) {
				if v, err := strconv.ParseUint(string(rs[i+1:i+1+width]), 16, 32); err == nil {
					b.WriteRune(rune(v))
					i += width
					continue
				}
			}
			b.WriteRune(rs[i])
		default:
			b.WriteRune(rs[i])
		}
	}
	return b.String()
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
				return unescapeJS(s)
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
	line, _, _, _, _ := readBoundedLine(bufio.NewReaderSize(io.LimitReader(f, wfMaxHeadBytes), 64<<10), wfMaxHeadBytes, wfMaxHeadBytes)
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
