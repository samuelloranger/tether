package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// An agent CLI the user installed on the host. Tether only reads its version and, on request,
// runs the CLI's own updater; it never installs or replaces one itself.
type hostCLI struct {
	Agent   string
	Command string
	// Dirs searched after PATH: installers that don't add themselves to a non-login PATH.
	Dirs []string
	pkg  func(version string) string
	args []string
	// Below SelfUpdateSince the CLI has no updater; the user runs a command instead.
	SelfUpdateSince string
}

var hostCLIs = []hostCLI{
	{Agent: "claude", Command: "claude", Dirs: []string{".local/bin", ".claude/local"},
		pkg: func(string) string { return "@anthropic-ai/claude-code" }, args: []string{"update"}},
	{Agent: "codex", Command: "codex", Dirs: []string{".local/bin"},
		pkg: func(string) string { return "@openai/codex" }, args: []string{"update"}, SelfUpdateSince: "0.126.0"},
	// 1.x ships as opencode-ai, 2.x as @opencode/cli; `opencode upgrade` stays on the installed major.
	{Agent: "opencode", Command: "opencode", Dirs: []string{".opencode/bin", ".local/bin"},
		pkg: func(v string) string {
			if versionLess(v, "2.0.0") {
				return "opencode-ai"
			}
			return "@opencode/cli"
		}, args: []string{"upgrade"}},
	{Agent: "copilot", Command: "copilot", Dirs: []string{".local/bin"},
		pkg: func(string) string { return "@github/copilot" }, args: []string{"update"}},
}

type foundCLI struct {
	program, realPath, version string
}

var cliVersionPattern = regexp.MustCompile(`\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?`)

// findHostCLI resolves the CLI as a chat would, and reads `--version`; false when it isn't installed.
var findHostCLI = func(c hostCLI) (foundCLI, bool) {
	program, err := exec.LookPath(c.Command)
	if err != nil {
		h, _ := os.UserHomeDir()
		for _, d := range c.Dirs {
			candidate := filepath.Join(h, d, c.Command)
			if st, err := os.Stat(candidate); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
				program = candidate
				break
			}
		}
	}
	if program == "" {
		return foundCLI{}, false
	}
	real, err := filepath.EvalSymlinks(program)
	if err != nil {
		real = program
	}
	ctx, cancel := context.WithTimeout(context.Background(), acpSmokeTimeout/6)
	defer cancel()
	out, _ := exec.CommandContext(ctx, program, "--version").Output()
	return foundCLI{program: program, realPath: real, version: cliVersionPattern.FindString(string(out))}, true
}

// plan is how to update: the CLI's own updater when it has one, else the command the user runs,
// chosen by how it was installed.
func (c hostCLI) plan(f foundCLI) (string, bool) {
	if c.SelfUpdateSince == "" || (f.version != "" && !versionLess(f.version, c.SelfUpdateSince)) {
		return strings.Join(append([]string{c.Command}, c.args...), " "), true
	}
	path := filepath.ToSlash(f.realPath)
	switch {
	case strings.Contains(path, "/node_modules/"):
		return "npm install -g " + c.pkg(f.version) + "@latest", false
	case strings.Contains(path, "/Cellar/") || strings.Contains(path, "/Caskroom/"):
		return "brew upgrade " + c.Command, false
	}
	return "npm install -g " + c.pkg(f.version) + "@latest", false
}

func lookupHostCLI(agent string) (hostCLI, bool) {
	for _, c := range hostCLIs {
		if c.Agent == agent {
			return c, true
		}
	}
	return hostCLI{}, false
}

// updateHostCLI runs the CLI's own updater, then reads its version again.
func updateHostCLI(agent string, w io.Writer) error {
	c, ok := lookupHostCLI(agent)
	if !ok {
		return fmt.Errorf("no CLI update for %q", agent)
	}
	found, ok := findHostCLI(c)
	if !ok {
		return fmt.Errorf("%s is not installed on this host", c.Command)
	}
	command, runnable := c.plan(found)
	if !runnable {
		return fmt.Errorf("run this to update: %s", command)
	}
	ctx, cancel := context.WithTimeout(context.Background(), acpCLITimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, found.program, c.args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s failed: %s", command, clip(strings.TrimSpace(string(out)), 300))
	}
	after, _ := findHostCLI(c)
	return json.NewEncoder(w).Encode(map[string]string{"agent": agent, "kind": "cli", "from": found.version, "to": after.version})
}
