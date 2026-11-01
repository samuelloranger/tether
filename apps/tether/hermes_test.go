package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHermesInvocationKeepsDockerUnprivilegedAndStdio(t *testing.T) {
	bin, args := hermesInvocation("", "hermes-test")
	if bin != "docker" || strings.Join(args[:10], " ") != "exec -i --user hermes --env HOME=/opt/data --workdir /opt/hermes hermes-test /opt/hermes/.venv/bin/python" {
		t.Fatalf("unsafe invocation: %s %q", bin, args[:10])
	}
	if args[10] != "-c" || !strings.Contains(args[11], "commands.catalog") {
		t.Fatal("missing embedded gateway adapter")
	}
}

func TestHermesNativeInterpreterIsAnArgumentNotShellCode(t *testing.T) {
	bin, args := hermesInvocation("/a path/python; echo nope", "ignored")
	if bin != "/a path/python; echo nope" || len(args) != 2 || args[0] != "-c" {
		t.Fatal("native interpreter must be executed directly")
	}
}

func TestHermesPrepareReusesLiveHolderAcrossNames(t *testing.T) {
	acpEnv(t)
	if err := os.MkdirAll(acpDir("hermes-existing"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeACPMeta(&acpMeta{Name: "hermes-existing", Cwd: "/home/owner", Spawn: "tether hermes", State: "running", Pid: os.Getpid()}); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := prepareHermesTo("hermes-other-device", &out); err != nil {
		t.Fatal(err)
	}
	var got struct {
		Name  string
		Fresh bool
	}
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Name != "hermes-existing" || got.Fresh {
		t.Fatalf("should reuse existing holder: %s", out.String())
	}
}

func TestHermesPrepareRefusesToReplaceOtherAgents(t *testing.T) {
	acpEnv(t)
	if err := os.MkdirAll(acpDir("hermes-name"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeACPMeta(&acpMeta{Name: "hermes-name", Spawn: "other-agent", State: "ended", Pid: 99999999}); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := prepareHermesTo("hermes-name", &out); err == nil {
		t.Fatal("must not remove another agent's holder")
	}
	if _, err := readACPMeta("hermes-name"); err != nil {
		t.Fatal("metadata was removed")
	}
}

func TestHermesSettingsReadPastLoginProfileNoise(t *testing.T) {
	t.Setenv("TETHER_HERMES_PYTHON", "")
	t.Setenv("TETHER_HERMES_CONTAINER", "")
	shell := filepath.Join(t.TempDir(), "login-shell")
	script := "#!/bin/sh\necho 'welcome back'\nTETHER_HERMES_CONTAINER=from-login; export TETHER_HERMES_CONTAINER\nexec /bin/sh -c \"$2\"\n"
	if err := os.WriteFile(shell, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SHELL", shell)
	if python, container := hermesSettings(); python != "" || container != "from-login" {
		t.Fatalf("login override not used: %q %q", python, container)
	}
}

func TestHermesPrepareDoesNotSpawnWhenHermesCannotStart(t *testing.T) {
	acpEnv(t)
	saved := hermesPrecheck
	t.Cleanup(func() { hermesPrecheck = saved })
	hermesPrecheck = func() error { return errors.New("gateway imports missing") }
	var out bytes.Buffer
	if err := prepareHermesTo("hermes-new", &out); err == nil || !strings.Contains(err.Error(), "imports missing") {
		t.Fatalf("expected the check's error, got %v", err)
	}
	if _, err := readACPMeta("hermes-new"); !errors.Is(err, errNoSession) {
		t.Fatalf("a holder was created: %v", err)
	}
}
