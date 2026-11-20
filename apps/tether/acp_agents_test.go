package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// installFake puts an executable adapter at the agent's version dir, as `acp update` leaves it.
func installFake(t *testing.T, root, bin, body string) {
	t.Helper()
	dir := filepath.Join(root, "node_modules", ".bin")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, bin), []byte("#!/bin/sh\n"+body+"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
}

const initAnswer = `read l; echo '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'; sleep 30`

func TestManagedSpawnLines(t *testing.T) {
	for spawn, want := range map[string]string{
		"tether acp agent claude":               "claude",
		"tether acp agent codex --flag":         "codex",
		"tether acp agent opencode":             "",
		"npx -y @agentclientprotocol/codex-acp": "",
	} {
		if got := managedSpawnKey(spawn); got != want {
			t.Fatalf("%q: %q, want %q", spawn, got, want)
		}
	}
	exe, _ := os.Executable()
	if got := withSelf("tether acp agent codex"); got != shQuote(exe)+" acp agent codex" {
		t.Fatalf("withSelf %q", got)
	}
	if withSelf("npx -y x") != "npx -y x" {
		t.Fatal("rewrote an unmanaged spawn")
	}
	if !supportsChatCards("tether acp agent claude") {
		t.Fatal("managed agents lost the cards server")
	}
}

func TestVersionOrder(t *testing.T) {
	for _, c := range [][2]string{{"0.95.0", "0.109.0"}, {"2.3.0", "2.8.0"}, {"1.2", "1.2.1"}, {"2.0.0-beta.1", "2.0.0"}} {
		if !versionLess(c[0], c[1]) || versionLess(c[1], c[0]) {
			t.Fatalf("%s < %s", c[0], c[1])
		}
	}
	if versionLess("2.8.0", "2.8.0") {
		t.Fatal("equal versions")
	}
}

func TestACPAgentRunsTheInstalledAdapterWithItsBinFirstOnPath(t *testing.T) {
	acpEnv(t)
	a, _ := lookupManagedAgent("codex")
	installFake(t, a.versionDir("9.9.9"), "codex-acp", `echo "adapter $* path=${PATH%%:*}"`)
	if err := a.switchTo("9.9.9"); err != nil {
		t.Fatal(err)
	}
	out, errb, code := runAcp(t, "agent", "codex", "--x")
	if code != 0 || strings.TrimSpace(out) != "adapter --x path="+a.binDir("9.9.9") {
		t.Fatalf("exit %d out %q err %q", code, out, errb)
	}
	if _, errb, code := runAcp(t, "agent", "nope"); code == 0 || !strings.Contains(errb, "unknown agent") {
		t.Fatalf("unknown: %d %q", code, errb)
	}
}

func TestACPVersionsReportsAdaptersAndCLIsAndCachesForAnHour(t *testing.T) {
	acpEnv(t)
	calls := 0
	oldLatest, oldFind := latestRelease, findHostCLI
	defer func() { latestRelease, findHostCLI = oldLatest, oldFind }()
	latestRelease = func(source string) (string, error) {
		calls++
		switch source {
		case "registry:claude-acp":
			return "0.109.0", nil
		case "npm:@anthropic-ai/claude-code":
			return "2.1.329", nil
		}
		return "", fmt.Errorf("offline")
	}
	findHostCLI = func(c hostCLI) (foundCLI, bool) {
		if c.Agent != "claude" {
			return foundCLI{}, false
		}
		return foundCLI{program: "/x/claude", realPath: "/x/claude", version: "2.1.327"}, true
	}
	read := func(args ...string) map[string]agentVersion {
		var b bytes.Buffer
		if err := acpVersions(args, &b); err != nil {
			t.Fatal(err)
		}
		out := map[string]agentVersion{}
		for _, l := range strings.Split(strings.TrimSpace(b.String()), "\n") {
			var v agentVersion
			if err := json.Unmarshal([]byte(l), &v); err != nil {
				t.Fatal(err)
			}
			out[v.Kind+":"+v.Agent] = v
		}
		return out
	}
	got := read()
	adapter, codex, cli := got["adapter:claude"], got["adapter:codex"], got["cli:claude"]
	if adapter.Version != "0.95.0" || adapter.Managed || adapter.Latest != "0.109.0" || !adapter.UpdateAvailable || adapter.CheckedAt == 0 {
		t.Fatalf("adapter %+v", adapter)
	}
	if codex.Version != "2.3.0" || codex.UpdateAvailable || !strings.Contains(codex.Error, "offline") {
		t.Fatalf("codex %+v", codex)
	}
	if cli.Version != "2.1.327" || cli.Latest != "2.1.329" || !cli.UpdateAvailable || cli.Command != "claude update" || !cli.Runnable {
		t.Fatalf("cli %+v", cli)
	}
	if _, ok := got["cli:codex"]; ok {
		t.Fatal("a CLI that isn't installed was listed")
	}
	read()
	if calls != 3 {
		t.Fatalf("asked %d times, want 3: answers and failures both wait out the hour", calls)
	}
	read("--refresh")
	if calls != 6 {
		t.Fatalf("refresh asked %d times", calls)
	}
	cache := readLatest()
	entry := cache["registry:claude-acp"]
	entry.CheckedAt = time.Now().Add(-2 * time.Hour).Unix()
	cache["registry:claude-acp"] = entry
	_ = writePrivateJSON(latestPath(), cache)
	read()
	if calls != 7 {
		t.Fatalf("an hour-old answer was not refreshed: %d", calls)
	}
}

func TestHostCLIUpdatePlans(t *testing.T) {
	codex, _ := lookupHostCLI("codex")
	if cmd, ok := codex.plan(foundCLI{version: "0.171.0"}); cmd != "codex update" || !ok {
		t.Fatalf("new codex %q %v", cmd, ok)
	}
	if cmd, ok := codex.plan(foundCLI{version: "0.120.0", realPath: "/usr/lib/node_modules/@openai/codex/bin/codex.js"}); ok || cmd != "npm install -g @openai/codex@latest" {
		t.Fatalf("old npm codex %q %v", cmd, ok)
	}
	if cmd, _ := codex.plan(foundCLI{version: "0.120.0", realPath: "/opt/homebrew/Cellar/codex/0.120.0/bin/codex"}); cmd != "brew upgrade codex" {
		t.Fatalf("old brew codex %q", cmd)
	}
	opencode, _ := lookupHostCLI("opencode")
	if opencode.pkg("1.4.0") != "opencode-ai" || opencode.pkg("2.2.5") != "@opencode/cli" {
		t.Fatal("opencode package by major")
	}
}

func TestACPUpdateCLIRunsTheCLIsOwnUpdater(t *testing.T) {
	acpEnv(t)
	bin := t.TempDir()
	state := filepath.Join(bin, "version")
	_ = os.WriteFile(state, []byte("2.2.5"), 0o600)
	script := "#!/bin/sh\nif [ \"$1\" = upgrade ]; then echo 2.3.2 > " + state + "; echo upgraded; exit 0; fi\necho \"opencode v$(cat " + state + ")\"\n"
	if err := os.WriteFile(filepath.Join(bin, "opencode"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":/usr/bin:/bin")
	var b bytes.Buffer
	if err := acpUpdate([]string{"opencode", "--cli"}, &b); err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(b.String()) != `{"agent":"opencode","from":"2.2.5","kind":"cli","to":"2.3.2"}` {
		t.Fatalf("out %q", b.String())
	}
	if err := acpUpdate([]string{"copilot", "--cli"}, &b); err == nil || !strings.Contains(err.Error(), "not installed") {
		t.Fatalf("missing CLI: %v", err)
	}
}

func TestACPUpdateInstallsChecksSwitchesAndRollsBack(t *testing.T) {
	acpEnv(t)
	t.Setenv("PATH", "/usr/bin:/bin")
	oldInstall, oldLatest := npmInstall, latestRelease
	defer func() { npmInstall, latestRelease = oldInstall, oldLatest }()
	body := initAnswer
	npmInstall = func(prefix, spec string) ([]byte, error) {
		installFake(t, prefix, "claude-agent-acp", body)
		return nil, nil
	}
	latestRelease = func(string) (string, error) { return "1.0.0", nil }
	a, _ := lookupManagedAgent("claude")
	update := func(args ...string) (map[string]string, error) {
		var b bytes.Buffer
		err := acpUpdate(append([]string{"claude"}, args...), &b)
		out := map[string]string{}
		_ = json.Unmarshal(b.Bytes(), &out)
		return out, err
	}
	if out, err := update(); err != nil || out["from"] != "0.95.0" || out["to"] != "1.0.0" || a.installed() != "1.0.0" {
		t.Fatalf("first update %v %v installed %q", out, err, a.installed())
	}
	if out, err := update("--version", "1.1.0"); err != nil || out["to"] != "1.1.0" || a.readPointer("previous") != "1.0.0" {
		t.Fatalf("second update %v %v", out, err)
	}
	body = "exit 1"
	if _, err := update("--version", "2.0.0"); err == nil || !strings.Contains(err.Error(), "kept 1.1.0") {
		t.Fatalf("broken release: %v", err)
	}
	if a.installed() != "1.1.0" {
		t.Fatalf("a failed check moved current to %q", a.installed())
	}
	if _, err := os.Stat(a.versionDir("2.0.0")); err == nil {
		t.Fatal("a failed install was kept")
	}
	if out, err := update("--rollback"); err != nil || out["to"] != "1.0.0" || a.readPointer("previous") != "1.1.0" {
		t.Fatalf("rollback %v %v", out, err)
	}
}

func TestACPManagedSpawnRunsThroughTheHolder(t *testing.T) {
	acpEnv(t)
	cleanupSession(t, "m1")
	a, _ := lookupManagedAgent("claude")
	installFake(t, a.versionDir("3.0.0"), "claude-agent-acp", echoAgent)
	if err := a.switchTo("3.0.0"); err != nil {
		t.Fatal(err)
	}
	p := startAttach(t, "m1", "--spawn", "tether acp agent claude", "--cwd", t.TempDir())
	fmt.Fprintln(p.stdin, "hi")
	if l := p.readLine(t); l != "echo:hi\n" {
		t.Fatalf("got %q", l)
	}
	if m, err := readACPMeta("m1"); err != nil || m.AgentVersion != "3.0.0" {
		t.Fatalf("meta %+v %v", m, err)
	}
	if l, err := acpStatusOf("m1"); err != nil || l.AgentVersion != "3.0.0" {
		t.Fatalf("status %+v %v", l, err)
	}
}
