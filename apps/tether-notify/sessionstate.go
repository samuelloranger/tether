package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// SessionState is one zmx session's agent state, written by hooks via `state`.
type SessionState struct {
	Session  string `json:"session"`
	Agent    string `json:"agent"`
	State    string `json:"state"`
	Since    int64  `json:"since"`
	Updated  int64  `json:"updated"`
	Message  string `json:"message,omitempty"`
	Link     string `json:"link,omitempty"`
	AgentPid int    `json:"agentPid,omitempty"`
}

const (
	stateWorking = "working"
	stateWaiting = "waiting"
	stateDone    = "done"
	stateClear   = "clear"
)

func validState(s string) bool {
	switch s {
	case stateWorking, stateWaiting, stateDone, stateClear:
		return true
	}
	return false
}

// The name becomes a file name, so it must be exactly one path segment.
func validSessionName(name string) bool {
	if name == "" || name == "." || name == ".." || len(name) > 200 {
		return false
	}
	return !strings.ContainsAny(name, "/\x00")
}

func sessionsDir() string { return filepath.Join(home(), "sessions") }

func sessionPath(name string) string { return filepath.Join(sessionsDir(), name+".json") }

// nextState returns the record to store, or nil to delete it. A repeated
// `working` (every PreToolUse) only moves `updated`, so `since` stays the turn start.
func nextState(prev *SessionState, in SessionState, now int64) *SessionState {
	if in.State == stateClear {
		return nil
	}
	if prev != nil && prev.State == stateWorking && in.State == stateWorking {
		next := *prev
		next.Updated = now
		if in.AgentPid != 0 {
			next.AgentPid = in.AgentPid
		}
		return &next
	}
	next := in
	next.Since = now
	next.Updated = now
	if next.AgentPid == 0 && prev != nil {
		next.AgentPid = prev.AgentPid
	}
	return &next
}

// One lock for the whole directory: hooks and `status` pruning never interleave.
func withSessionsLock(fn func() error) error {
	if err := os.MkdirAll(sessionsDir(), 0o700); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(sessionsDir(), ".lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	return fn()
}

func readSession(name string) (*SessionState, error) {
	if !validSessionName(name) {
		return nil, fmt.Errorf("invalid session name %q", name)
	}
	data, err := os.ReadFile(sessionPath(name))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var s SessionState
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

func writeSession(s *SessionState) error {
	if !validSessionName(s.Session) {
		return fmt.Errorf("invalid session name %q", s.Session)
	}
	if err := os.MkdirAll(sessionsDir(), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(sessionsDir(), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), sessionPath(s.Session))
}

func removeSession(name string) error {
	if !validSessionName(name) {
		return fmt.Errorf("invalid session name %q", name)
	}
	err := os.Remove(sessionPath(name))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

func listSessions() ([]SessionState, error) {
	entries, err := os.ReadDir(sessionsDir())
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []SessionState
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || strings.HasPrefix(name, ".") || !strings.HasSuffix(name, ".json") {
			continue
		}
		s, err := readSession(strings.TrimSuffix(name, ".json"))
		if err != nil || s == nil {
			continue
		}
		out = append(out, *s)
	}
	return out, nil
}
