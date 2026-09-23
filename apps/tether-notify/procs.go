package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

type runner func(name string, args ...string) (string, error)

func execRunner(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).Output()
	return string(out), err
}

// Same lookup the app uses: hook environments often lack ~/.local/bin on PATH.
func zmxPath() string {
	if p := os.Getenv("TETHER_ZMX"); p != "" {
		return p
	}
	if base, err := os.UserHomeDir(); err == nil {
		p := filepath.Join(base, ".local", "bin", "zmx")
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return "zmx"
}

// `zmx ls` rows are tab-separated key=value pairs; names may contain spaces.
func parseZmxClients(out string) map[string]int {
	sessions := map[string]int{}
	for _, line := range strings.Split(out, "\n") {
		fields := map[string]string{}
		for _, pair := range strings.Split(line, "\t") {
			key, value, ok := strings.Cut(strings.TrimSpace(pair), "=")
			if ok {
				fields[key] = value
			}
		}
		name := fields["name"]
		if name == "" {
			continue
		}
		clients, _ := strconv.Atoi(fields["clients"])
		sessions[name] = clients
	}
	return sessions
}

func zmxClients(run runner) (map[string]int, error) {
	out, err := run(zmxPath(), "ls")
	if err != nil {
		return nil, err
	}
	return parseZmxClients(out), nil
}

var passThroughComms = map[string]bool{"sh": true, "dash": true, "bash": true, "zsh": true, "fish": true}

func passThrough(comm string) bool {
	base := strings.TrimPrefix(filepath.Base(comm), "-")
	return passThroughComms[base] || strings.HasPrefix(base, "tether-notify")
}

// agentPid walks up from start past shells and the hook wrapper to the agent
// that fired the hook. `ps` rather than /proc so macOS hosts work too.
func agentPid(run runner, start int) int {
	pid := start
	for i := 0; i < 8 && pid > 1; i++ {
		out, err := run("ps", "-o", "ppid=,comm=", "-p", strconv.Itoa(pid))
		if err != nil {
			return 0
		}
		fields := strings.Fields(out)
		if len(fields) < 2 {
			return 0
		}
		if !passThrough(strings.Join(fields[1:], " ")) {
			return pid
		}
		parent, err := strconv.Atoi(fields[0])
		if err != nil {
			return 0
		}
		pid = parent
	}
	return 0
}

func pidAlive(pid int) bool {
	if pid <= 0 {
		return true
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
