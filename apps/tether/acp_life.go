package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	defaultACPIdle      = 12 * time.Hour
	defaultACPLogMax    = int64(256 << 20)
	defaultACPKeepEnded = 14 * 24 * time.Hour
	acpKillGrace        = 3 * time.Second
)

// acpDuration reads a Go duration, or a whole number of days ("14d"). "0" is zero; junk is the default.
func acpDuration(env string, def time.Duration) time.Duration {
	v := strings.TrimSpace(os.Getenv(env))
	if v == "" {
		return def
	}
	if days, ok := strings.CutSuffix(v, "d"); ok {
		if n, err := strconv.Atoi(days); err == nil && n >= 0 {
			return time.Duration(n) * 24 * time.Hour
		}
		return def
	}
	if d, err := time.ParseDuration(v); err == nil && d >= 0 {
		return d
	}
	if v == "0" {
		return 0
	}
	return def
}

func acpLogMax() int64 {
	if n, err := strconv.ParseInt(strings.TrimSpace(os.Getenv("TETHER_ACP_LOG_MAX")), 10, 64); err == nil && n >= 0 {
		return n
	}
	return defaultACPLogMax
}

// endAgent stops the agent on the daemon's own initiative and keeps the log. The first reason wins.
func (s *acpDaemonState) endAgent(reason string) {
	s.mu.Lock()
	if s.endReason != "" || s.ended {
		s.mu.Unlock()
		return
	}
	s.endReason = reason
	pid := s.agentPid
	s.mu.Unlock()
	if pid <= 0 {
		return
	}
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	time.AfterFunc(acpKillGrace, func() { _ = syscall.Kill(-pid, syscall.SIGKILL) })
}

func (s *acpDaemonState) touch() {
	s.mu.Lock()
	s.activity = time.Now()
	s.mu.Unlock()
}

func (s *acpDaemonState) busy() bool {
	s.mu.Lock()
	b := len(s.live) > 0 || s.clients > 0 || s.handshaking > 0
	s.mu.Unlock()
	return b || s.tr.working()
}

// idleLoop ends the agent once nothing has happened for window; stop closes it.
func (s *acpDaemonState) idleLoop(window time.Duration, stop <-chan struct{}) {
	tick := window / 10
	if tick < 10*time.Millisecond {
		tick = 10 * time.Millisecond
	}
	if tick > time.Minute {
		tick = time.Minute
	}
	t := time.NewTicker(tick)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
		}
		if s.busy() {
			s.touch()
			continue
		}
		s.mu.Lock()
		idle := time.Since(s.activity)
		s.mu.Unlock()
		if idle >= window {
			s.endAgent("idle")
			return
		}
	}
}

// working reports a request waiting for an answer, a turn in flight or a background command running.
func (t *acpTracker) working() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.st.Requests) > 0 || len(t.st.Prompts) > 0 || t.st.Autonomous || len(t.st.Tasks) > 0
}

// pruneEnded removes sessions that ended longer than keep ago and have no live daemon.
func pruneEnded(except string) {
	keep := acpDuration("TETHER_ACP_KEEP_ENDED", defaultACPKeepEnded)
	if keep <= 0 {
		return
	}
	entries, err := os.ReadDir(filepath.Join(home(), "acp"))
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.Name() == except {
			continue
		}
		m, err := readACPMeta(e.Name())
		if err != nil || procUp(m.Pid) {
			continue
		}
		at := time.Unix(m.Ended, 0)
		if m.Ended == 0 {
			st, err := os.Stat(acpMetaPath(e.Name()))
			if err != nil {
				continue
			}
			at = st.ModTime()
		}
		if time.Since(at) < keep {
			continue
		}
		_ = os.RemoveAll(filepath.Dir(m.Sock))
		_ = os.RemoveAll(acpDir(e.Name()))
	}
}

var (
	notFoundShell = regexp.MustCompile(`([^\s:]+): (?:command )?not found`)
	notFoundZsh   = regexp.MustCompile(`command not found: (\S+)`)
	notFoundFish  = regexp.MustCompile(`Unknown command: (\S+)`)
)

func missingProgram(errLog string) string {
	for _, re := range []*regexp.Regexp{notFoundZsh, notFoundFish, notFoundShell} {
		if m := re.FindStringSubmatch(errLog); m != nil {
			return m[1]
		}
	}
	return ""
}

func notFoundMessage(code int, errLog string) string {
	if code != 127 && !strings.Contains(errLog, "not found") {
		return ""
	}
	prog := missingProgram(errLog)
	if prog == "" {
		return fmt.Sprintf("agent command not found on this host (status %d)", code)
	}
	switch filepath.Base(prog) {
	case "node", "npx", "npm":
		return "agent command not found on this host: node/npx not found: install Node.js on this host"
	}
	return "agent command not found on this host: " + prog + " not found"
}
