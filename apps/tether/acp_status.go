package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

// defaultACPAgentCmd is the adapter `acp sessions` spawns; the app pins the same version for chats.
const defaultACPAgentCmd = "npx -y @agentclientprotocol/claude-agent-acp@0.95.0"

var acpSessionsTimeout = 15 * time.Second

type acpStatusLine struct {
	Name        string `json:"name"`
	State       string `json:"state"`
	Turn        string `json:"turn"`
	Title       string `json:"title"`
	Cwd         string `json:"cwd"`
	Created     int64  `json:"created"`
	LogBytes    int64  `json:"logBytes"`
	EndedReason string `json:"endedReason"`
	// Tasks counts the background commands still running (absent when none, and from older holders).
	Tasks int `json:"tasks,omitempty"`
	// Spawn is the command that started the agent, so a client can tell which agent a chat runs.
	Spawn string `json:"spawn,omitempty"`
	// MultiClient: the session's holder lets several clients attach at once (absent from older ones).
	MultiClient bool       `json:"multiClient,omitempty"`
	Pinned      bool       `json:"pinned,omitempty"`
	Archived    bool       `json:"archived,omitempty"`
	CustomTitle string     `json:"customTitle,omitempty"`
	ProjectRoot string     `json:"projectRoot,omitempty"`
	Parent      *acpParent `json:"parent,omitempty"`
}

func acpStatusOf(name string) (*acpStatusLine, error) {
	m, err := readACPMeta(name)
	if err != nil {
		return nil, err
	}
	l := &acpStatusLine{Name: m.Name, State: "ended", Turn: "idle", Title: m.Title, Cwd: m.Cwd, Created: m.Created, EndedReason: m.EndedReason, MultiClient: m.MultiClient, Spawn: m.Spawn}
	organization, err := readACPOrganization(name)
	if err != nil {
		return nil, err
	}
	l.Pinned, l.Archived, l.CustomTitle, l.Parent = organization.Pinned, organization.Archived, organization.Title, organization.Parent
	l.ProjectRoot = acpProjectRoot(m.Cwd)
	if metaRunning(m) {
		l.State = "running"
		if m.Turn == "working" || m.Turn == "waiting" {
			l.Turn = m.Turn
		}
		l.Tasks = m.Tasks
	}
	if st, err := os.Stat(filepath.Join(acpDir(name), "out.log")); err == nil {
		l.LogBytes = st.Size()
	}
	return l, nil
}

// acpStatus prints one JSON object per session, read from meta.json alone.
func acpStatus(names []string, w io.Writer) error {
	enc := json.NewEncoder(w)
	if len(names) == 0 {
		pruneEnded("")
		entries, err := os.ReadDir(filepath.Join(home(), "acp"))
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		for _, e := range entries {
			if l, err := acpStatusOf(e.Name()); err == nil {
				_ = enc.Encode(l)
			}
		}
		return nil
	}
	for _, name := range names {
		if !validSessionName(name) {
			return fmt.Errorf("invalid session name")
		}
		l, err := acpStatusOf(name)
		if err != nil {
			return err
		}
		_ = enc.Encode(l)
	}
	return nil
}

type acpSavedSession struct {
	SessionID string `json:"sessionId"`
	Title     string `json:"title"`
	UpdatedAt string `json:"updatedAt"`
	Cwd       string `json:"cwd"`
}

func acpSessions(args []string, w io.Writer) error {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		return fmt.Errorf("usage: acp sessions <cwd> [--limit N] [--agent-cmd CMD]")
	}
	cwd := args[0]
	fs := flag.NewFlagSet("acp sessions", flag.ContinueOnError)
	limit := fs.Int("limit", 0, "most sessions to print (0 = all)")
	agentCmd := fs.String("agent-cmd", "", "agent command (default $TETHER_ACP_AGENT_CMD, else the pinned adapter)")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if *limit < 0 {
		return fmt.Errorf("--limit must not be negative")
	}
	cmdline := *agentCmd
	if cmdline == "" {
		cmdline = os.Getenv("TETHER_ACP_AGENT_CMD")
	}
	if cmdline == "" {
		cmdline = defaultACPAgentCmd
	}
	list, err := listAgentSessions(cmdline, cwd, acpSessionsTimeout)
	if err != nil {
		return err
	}
	sort.SliceStable(list, func(i, j int) bool { return list[i].UpdatedAt > list[j].UpdatedAt })
	if *limit > 0 && len(list) > *limit {
		list = list[:*limit]
	}
	enc := json.NewEncoder(w)
	for _, s := range list {
		_ = enc.Encode(s)
	}
	return nil
}

type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

type rpcReply struct {
	line rpcLine
	key  string
}

// listAgentSessions runs the agent just long enough to ask it for its saved conversations in cwd.
func listAgentSessions(cmdline, cwd string, timeout time.Duration) ([]acpSavedSession, error) {
	cmd := exec.Command(acpShell(), "-lc", cmdline)
	if st, err := os.Stat(cwd); err == nil && st.IsDir() {
		cmd.Dir = cwd
	}
	stderr := &lockedBuf{}
	cmd.Stderr = stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	pgid := cmd.Process.Pid
	defer func() {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		_ = cmd.Wait()
	}()

	replies := make(chan rpcReply, 16)
	go func() {
		defer close(replies)
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 64*1024), maxACPLine)
		for sc.Scan() {
			if m, key, ok := parseRPC(sc.Bytes()); ok && m.Method == "" && key != "" {
				replies <- rpcReply{m, key}
			}
		}
	}()
	deadline := time.After(timeout)
	call := func(id int, method string, params any) (json.RawMessage, error) {
		line, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
		if _, err := stdin.Write(append(line, '\n')); err != nil {
			return nil, agentGone(cmdline, stderr)
		}
		for {
			select {
			case r, ok := <-replies:
				if !ok {
					return nil, agentGone(cmdline, stderr)
				}
				if r.key != fmt.Sprint(id) {
					continue
				}
				if len(r.line.Error) > 0 {
					return nil, fmt.Errorf("agent refused %s: %s", method, clip(string(r.line.Error), 300))
				}
				return r.line.Result, nil
			case <-deadline:
				return nil, fmt.Errorf("agent did not answer %s within %s", method, timeout)
			}
		}
	}

	caps := map[string]any{"fs": map[string]any{"readTextFile": false, "writeTextFile": false}, "terminal": false, "elicitation": map[string]any{"form": map[string]any{}}}
	if _, err := call(1, "initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": caps}); err != nil {
		return nil, err
	}
	var out []acpSavedSession
	cursor := ""
	for id := 2; ; id++ {
		params := map[string]any{"cwd": cwd}
		if cursor != "" {
			params["cursor"] = cursor
		}
		raw, err := call(id, "session/list", params)
		if err != nil {
			return nil, err
		}
		var res struct {
			Sessions   []acpSavedSession `json:"sessions"`
			NextCursor string            `json:"nextCursor"`
		}
		if err := json.Unmarshal(raw, &res); err != nil {
			return nil, fmt.Errorf("agent sent an unreadable session list: %w", err)
		}
		out = append(out, res.Sessions...)
		if res.NextCursor == "" || res.NextCursor == cursor || len(out) >= 1000 {
			return out, nil
		}
		cursor = res.NextCursor
	}
}

func agentGone(cmdline string, stderr *lockedBuf) error {
	errLog := stderr.String()
	if msg := notFoundMessage(0, errLog); strings.Contains(errLog, "not found") && msg != "" {
		return fmt.Errorf("%s", msg)
	}
	msg := "agent exited before listing sessions"
	if lines := strings.Split(strings.TrimSpace(errLog), "\n"); lines[0] != "" {
		msg += ": " + clip(strings.TrimSpace(lines[len(lines)-1]), 300)
	}
	return fmt.Errorf("%s", msg)
}
