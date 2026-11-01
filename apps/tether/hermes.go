package main

import (
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

//go:embed hermes_adapter.py
var hermesAdapter string

const hermesDefaultContainer = "hermes"

// hermesLoginMarker precedes the overrides the login shell prints, past anything its profile echoes.
const hermesLoginMarker = "tether-hermes-settings"

func hermesInvocation(python, container string) (string, []string) {
	adapter := "import sys, types, base64\n_cards = types.ModuleType('chat_cards')\nexec(base64.b64decode('" + base64.StdEncoding.EncodeToString([]byte(chatCardsSource)) + "'), _cards.__dict__)\nsys.modules['chat_cards'] = _cards\n" + hermesAdapter
	if python != "" {
		return python, []string{"-c", adapter}
	}
	if container == "" {
		container = hermesDefaultContainer
	}
	return "docker", []string{"exec", "-i", "--user", "hermes", "--env", "HOME=/opt/data", "--workdir", "/opt/hermes", container, "/opt/hermes/.venv/bin/python", "-c", adapter}
}

// hermesSettings resolves the interpreter or container. The holder runs under a login shell while
// the app's checks run under plain sh, so overrides set only in the login profile are read from it.
func hermesSettings(loginWait time.Duration) (python, container string) {
	python, container = os.Getenv("TETHER_HERMES_PYTHON"), os.Getenv("TETHER_HERMES_CONTAINER")
	if python == "" && container == "" {
		python, container = hermesLoginSettings(loginWait)
	}
	if python == "" && container == "" {
		home, _ := os.UserHomeDir()
		for _, candidate := range []string{filepath.Join(home, "hermes-agent", ".venv", "bin", "python"), filepath.Join(home, ".hermes", "hermes-agent", ".venv", "bin", "python")} {
			if st, err := os.Stat(candidate); err == nil && st.Mode()&0o111 != 0 {
				return candidate, ""
			}
		}
	}
	return python, container
}

func hermesLoginSettings(wait time.Duration) (python, container string) {
	ctx, cancel := context.WithTimeout(context.Background(), wait)
	defer cancel()
	script := `printf '%s\n%s\n%s\n' ` + hermesLoginMarker + ` "$TETHER_HERMES_PYTHON" "$TETHER_HERMES_CONTAINER"`
	out, err := exec.CommandContext(ctx, acpShell(), "-lc", script).Output()
	if err != nil {
		return "", ""
	}
	lines := strings.Split(string(out), "\n")
	for i, line := range lines {
		if line == hermesLoginMarker && i+2 < len(lines) {
			return lines[i+1], lines[i+2]
		}
	}
	return "", ""
}

// hermesAvailable is the quick probe for the app's shared host check, which runs before every new
// chat with any agent: it finds the interpreter or the running container without starting Hermes.
// The login-shell and docker probes take at most 2 s each, inside the 5 s the host check allows.
func hermesAvailable() error {
	python, container := hermesSettings(2 * time.Second)
	if python != "" {
		if st, err := os.Stat(python); err != nil || st.Mode()&0o111 == 0 {
			return fmt.Errorf("no Hermes interpreter at %s", python)
		}
		return nil
	}
	if container == "" {
		container = hermesDefaultContainer
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "inspect", "--format", "{{.State.Running}}", container).Output()
	if err != nil || strings.TrimSpace(string(out)) != "true" {
		return fmt.Errorf("the %s container is not running", container)
	}
	return nil
}

// checkHermes starts the adapter far enough to prove its Hermes imports still exist.
func checkHermes(out io.Writer) error {
	bin, argv := hermesInvocation(hermesSettings(5 * time.Second))
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, append(argv, "--check")...)
	cmd.Stdout, cmd.Stderr = out, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("Hermes could not start: %w; start its gateway and check TETHER_HERMES_CONTAINER or TETHER_HERMES_PYTHON", err)
	}
	return nil
}

func isHermesSpawn(spawn string) bool { return strings.Contains(spawn, "tether hermes") }

func runHermes(args []string) error {
	switch {
	case len(args) == 2 && args[0] == "--prepare":
		return prepareHermes(args[1])
	case len(args) == 1 && args[0] == "--check":
		return checkHermes(os.Stdout)
	case len(args) == 1 && args[0] == "--available":
		return hermesAvailable()
	case len(args) != 0:
		return fmt.Errorf("usage: tether hermes [--check | --available | --prepare NAME]")
	}
	return newHermesSupervisor(os.Stdout, spawnHermesAdapter).run(os.Stdin)
}

func spawnHermesAdapter() (*hermesProc, error) {
	bin, argv := hermesInvocation(hermesSettings(5 * time.Second))
	cmd := exec.Command(bin, argv...)
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "Hermes could not start: %v; start its gateway and check TETHER_HERMES_CONTAINER or TETHER_HERMES_PYTHON\n", err)
		return nil, err
	}
	return &hermesProc{stdin: stdin, stdout: stdout, wait: cmd.Wait}, nil
}

// hermesPrecheck runs before a fresh holder is spawned; a variable so tests need no Hermes.
var hermesPrecheck = func() error { return checkHermes(io.Discard) }

func prepareHermes(name string) error { return prepareHermesTo(name, os.Stdout) }

func prepareHermesTo(name string, out io.Writer) error {
	if !validSessionName(name) {
		return fmt.Errorf("invalid Hermes conversation name")
	}
	return withSessionLock("hermes-open", func() error {
		entries, err := os.ReadDir(filepath.Join(home(), "acp"))
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		for _, entry := range entries {
			m, err := readACPMeta(entry.Name())
			if err == nil && isHermesSpawn(m.Spawn) && metaRunning(m) {
				return json.NewEncoder(out).Encode(map[string]any{"name": m.Name, "cwd": m.Cwd, "fresh": false})
			}
		}
		if m, err := readACPMeta(name); err == nil {
			if !isHermesSpawn(m.Spawn) {
				return fmt.Errorf("the requested name belongs to another agent")
			}
			if err := hermesPrecheck(); err != nil {
				return err
			}
			if err := acpKill(name); err != nil {
				return err
			}
		} else if !errors.Is(err, errNoSession) {
			return err
		} else if err := hermesPrecheck(); err != nil {
			return err
		}
		cwd, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		m, err := spawnACPDaemon(name, "tether hermes", cwd)
		if err != nil {
			return err
		}
		return json.NewEncoder(out).Encode(map[string]any{"name": m.Name, "cwd": m.Cwd, "fresh": true})
	})
}
