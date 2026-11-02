package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const maxACPPrompt = 64 << 10

var (
	errNoACPSession = errors.New("the chat has no session yet: open it in the app once")
	errBusy         = errors.New("the agent is in a turn; try again when it is done")
	acpSessionIDRe  = regexp.MustCompile(`"sessionId"\s*:\s*"([^"\\]+)"`)
)

// acpPrompt sends a message into a running chat as the host's own client, `host`: attached
// clients see it echoed like one of theirs, and since `host` leaves once the holder has taken it,
// the answer gets the push a turn nobody watches gets. Works with any holder version.
func acpPrompt(args []string, in io.Reader) error {
	if len(args) != 1 || strings.HasPrefix(args[0], "-") {
		return fmt.Errorf("usage: acp prompt <name>   (the message on stdin)")
	}
	name := args[0]
	if !validSessionName(name) {
		return fmt.Errorf("invalid session name")
	}
	text, err := io.ReadAll(io.LimitReader(in, maxACPPrompt+1))
	if err != nil {
		return err
	}
	if len(text) > maxACPPrompt || strings.TrimSpace(string(text)) == "" {
		return fmt.Errorf("the message must be 1 byte to 64 KiB")
	}
	m, err := readACPMeta(name)
	if err != nil {
		return err
	}
	if !metaRunning(m) {
		return fmt.Errorf("chat %s is not running", name)
	}
	if acpBusy(name) {
		return errBusy
	}
	logPath := filepath.Join(acpDir(name), "out.log")
	session, size, err := acpLastSession(logPath)
	if err != nil {
		return err
	}
	if session == "" {
		return errNoACPSession
	}
	id := fmt.Sprintf("host-%d", time.Now().UnixNano())
	line, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": id, "method": "session/prompt",
		"params": map[string]any{"sessionId": session, "prompt": []any{map[string]any{"type": "text", "text": string(text)}}},
	})
	conn, err := net.DialTimeout("unix", m.Sock, 5*time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	if _, err := fmt.Fprintf(conn, "%d 0 host\n%s\n", size, line); err != nil {
		return err
	}
	r := bufio.NewReader(conn)
	for {
		got, err := r.ReadString('\n')
		if strings.Contains(got, `"`+id+`"`) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("the holder did not take the message: %w", err)
		}
	}
}

func acpBusy(name string) bool {
	var st acpTrackerState
	b, err := os.ReadFile(filepath.Join(acpDir(name), "pending.json"))
	if err != nil || json.Unmarshal(b, &st) != nil {
		return false
	}
	return len(st.Prompts) > 0 || len(st.Requests) > 0 || st.Autonomous
}

// acpLastSession is the last session id the log names, from the end of a log that may be large.
func acpLastSession(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", 0, err
	}
	const tail = 4 << 20
	start := max(info.Size()-tail, 0)
	b := make([]byte, info.Size()-start)
	if _, err := f.ReadAt(b, start); err != nil && !errors.Is(err, io.EOF) {
		return "", 0, err
	}
	all := acpSessionIDRe.FindAllSubmatch(b, -1)
	if len(all) == 0 {
		return "", info.Size(), nil
	}
	return string(all[len(all)-1][1]), info.Size(), nil
}
