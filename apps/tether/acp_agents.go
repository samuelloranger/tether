package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// A chat agent whose ACP adapter the host installs and updates on request. Nothing updates on
// its own: `acp versions` reports, `acp update` changes, and an agent never updated runs the
// adapter version the apps pinned before (through npx, as they did).
type managedAgent struct {
	Key     string
	Package string
	Default string
	Bin     string
	// RegistryID names the adapter in the official ACP Registry, the source of "latest".
	RegistryID string
	// The engine the adapter bundles, read from its installed package.json.
	EngineName, EnginePackage, EngineField string
}

var managedAgents = []managedAgent{
	{Key: "claude", Package: "@agentclientprotocol/claude-agent-acp", Default: "0.95.0", Bin: "claude-agent-acp", RegistryID: "claude-acp",
		EngineName: "Claude Code", EnginePackage: "@anthropic-ai/claude-agent-sdk", EngineField: "claudeCodeVersion"},
	{Key: "codex", Package: "@agentclientprotocol/codex-acp", Default: "2.3.0", Bin: "codex-acp", RegistryID: "codex-acp",
		EngineName: "Codex", EnginePackage: "@openai/codex", EngineField: "version"},
}

const managedSpawnPrefix = "tether acp agent "

const acpRegistryURL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"

var (
	acpLatestTTL    = time.Hour
	acpNpmTimeout   = 5 * time.Minute
	acpSmokeTimeout = 90 * time.Second
	acpCLITimeout   = 10 * time.Minute
	// latestRelease answers "registry:<id>" from the ACP Registry and "npm:<package>" from npm.
	latestRelease = func(source string) (string, error) {
		kind, name, _ := strings.Cut(source, ":")
		client := &http.Client{Timeout: 20 * time.Second}
		switch kind {
		case "registry":
			var reg struct {
				Agents []struct {
					ID      string `json:"id"`
					Version string `json:"version"`
				} `json:"agents"`
			}
			if err := getJSON(client, acpRegistryURL, &reg); err != nil {
				return "", err
			}
			for _, a := range reg.Agents {
				if a.ID == name {
					return a.Version, nil
				}
			}
			return "", fmt.Errorf("%s is not in the ACP Registry", name)
		case "npm":
			var pkg struct {
				Version string `json:"version"`
			}
			if err := getJSON(client, "https://registry.npmjs.org/"+strings.Replace(name, "/", "%2f", 1)+"/latest", &pkg); err != nil {
				return "", err
			}
			return pkg.Version, nil
		}
		return "", fmt.Errorf("unknown release source %q", source)
	}
)

func getJSON(client *http.Client, url string, into any) error {
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %s", url, resp.Status)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(into)
}

var npmInstall = func(prefix, spec string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), acpNpmTimeout)
	defer cancel()
	return exec.CommandContext(ctx, "npm", "install", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel=error", spec).
		CombinedOutput()
}

func lookupManagedAgent(key string) (managedAgent, bool) {
	for _, a := range managedAgents {
		if a.Key == key {
			return a, true
		}
	}
	return managedAgent{}, false
}

// managedSpawnKey is the agent a `tether acp agent <key>` spawn line runs, or "".
func managedSpawnKey(spawn string) string {
	rest, ok := strings.CutPrefix(strings.TrimSpace(spawn), managedSpawnPrefix)
	if !ok {
		return ""
	}
	key, _, _ := strings.Cut(rest, " ")
	if _, ok := lookupManagedAgent(key); !ok {
		return ""
	}
	return key
}

// withSelf points a `tether acp agent` spawn line at this binary: a login shell may reset PATH.
func withSelf(spawn string) string {
	if managedSpawnKey(spawn) == "" {
		return spawn
	}
	exe, err := os.Executable()
	if err != nil {
		return spawn
	}
	return shQuote(exe) + strings.TrimPrefix(strings.TrimSpace(spawn), "tether")
}

func shQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'" }

func agentsRoot() string                          { return filepath.Join(home(), "acp-agents") }
func (a managedAgent) dir() string                { return filepath.Join(agentsRoot(), a.Key) }
func (a managedAgent) versionDir(v string) string { return filepath.Join(a.dir(), v) }
func (a managedAgent) binDir(v string) string {
	return filepath.Join(a.versionDir(v), "node_modules", ".bin")
}
func (a managedAgent) pointer(name string) string { return filepath.Join(a.dir(), name) }
func (a managedAgent) readPointer(name string) string {
	data, err := os.ReadFile(a.pointer(name))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// installed is the version `acp update` put in place, "" when the agent still runs the default.
func (a managedAgent) installed() string {
	v := a.readPointer("current")
	if v == "" {
		return ""
	}
	if _, err := os.Stat(filepath.Join(a.binDir(v), a.Bin)); err != nil {
		return ""
	}
	return v
}

func (a managedAgent) running() string {
	if v := a.installed(); v != "" {
		return v
	}
	return a.Default
}

func runACPAgent(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: acp agent <%s> [adapter args…]", agentKeys())
	}
	a, ok := lookupManagedAgent(args[0])
	if !ok {
		return fmt.Errorf("unknown agent %q (managed: %s)", args[0], agentKeys())
	}
	env := os.Environ()
	if v := a.installed(); v != "" {
		bin := filepath.Join(a.binDir(v), a.Bin)
		// codex-acp runs the `codex` first on PATH: the one it was installed with, as under npx.
		env = append(env, "PATH="+a.binDir(v)+string(os.PathListSeparator)+os.Getenv("PATH"))
		return syscall.Exec(bin, append([]string{bin}, args[1:]...), env)
	}
	npx, err := exec.LookPath("npx")
	if err != nil {
		return fmt.Errorf("node/npx not found: install Node.js on this host")
	}
	return syscall.Exec(npx, append([]string{"npx", "-y", a.Package + "@" + a.Default}, args[1:]...), env)
}

func agentKeys() string {
	keys := make([]string, len(managedAgents))
	for i, a := range managedAgents {
		keys[i] = a.Key
	}
	return strings.Join(keys, "|")
}

type agentVersion struct {
	// Kind is "adapter" (the ACP adapter chats run) or "cli" (the user's own agent CLI on the host).
	Kind    string `json:"kind"`
	Agent   string `json:"agent"`
	Package string `json:"package,omitempty"`
	// Version runs new chats; Managed is false while it is still the apps' old pinned default.
	Version  string `json:"version"`
	Managed  bool   `json:"managed"`
	Engine   string `json:"engine,omitempty"`
	Previous string `json:"previous,omitempty"`
	Latest   string `json:"latest,omitempty"`
	// CheckedAt is when Latest was read (unix); Error says why it could not be.
	CheckedAt       int64  `json:"checkedAt,omitempty"`
	UpdateAvailable bool   `json:"updateAvailable"`
	Error           string `json:"error,omitempty"`
	// Command updates a CLI; Runnable says `acp update <agent> --cli` can run it, else the user does.
	Command  string `json:"command,omitempty"`
	Runnable bool   `json:"runnable,omitempty"`
}

type latestEntry struct {
	Version   string `json:"version"`
	CheckedAt int64  `json:"checkedAt"`
}

func latestPath() string { return filepath.Join(agentsRoot(), "latest.json") }

func readLatest() map[string]latestEntry {
	out := map[string]latestEntry{}
	if data, err := os.ReadFile(latestPath()); err == nil {
		_ = json.Unmarshal(data, &out)
	}
	return out
}

// latestFor asks a source at most once per acpLatestTTL unless refresh; a failed read keeps the
// last answer and waits out the TTL too, so an offline host isn't asked on every check.
func latestFor(source string, cache map[string]latestEntry, refresh bool, now time.Time) (latestEntry, error) {
	entry, ok := cache[source]
	if ok && !refresh && now.Sub(time.Unix(entry.CheckedAt, 0)) < acpLatestTTL {
		return entry, nil
	}
	v, err := latestRelease(source)
	if err != nil {
		cache[source] = latestEntry{Version: entry.Version, CheckedAt: now.Unix()}
		return entry, err
	}
	entry = latestEntry{Version: v, CheckedAt: now.Unix()}
	cache[source] = entry
	return entry, nil
}

func acpVersions(args []string, w io.Writer) error {
	fs := flag.NewFlagSet("acp versions", flag.ContinueOnError)
	refresh := fs.Bool("refresh", false, "ask now instead of using the answer from the last hour")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := os.MkdirAll(agentsRoot(), 0o700); err != nil {
		return err
	}
	cache := readLatest()
	now := time.Now()
	enc := json.NewEncoder(w)
	for _, a := range managedAgents {
		line := agentVersion{Kind: "adapter", Agent: a.Key, Package: a.Package, Version: a.running(), Managed: a.installed() != "",
			Previous: a.readPointer("previous")}
		line.Engine = a.engineVersion(line.Version, line.Managed)
		entry, err := latestFor("registry:"+a.RegistryID, cache, *refresh, now)
		if err != nil {
			line.Error = clip(err.Error(), 200)
		}
		line.Latest, line.CheckedAt = entry.Version, entry.CheckedAt
		line.UpdateAvailable = line.Latest != "" && versionLess(line.Version, line.Latest)
		_ = enc.Encode(line)
	}
	for _, c := range hostCLIs {
		found, ok := findHostCLI(c)
		if !ok {
			continue
		}
		line := agentVersion{Kind: "cli", Agent: c.Agent, Version: found.version}
		line.Package = c.pkg(found.version)
		line.Command, line.Runnable = c.plan(found)
		entry, err := latestFor("npm:"+line.Package, cache, *refresh, now)
		if err != nil {
			line.Error = clip(err.Error(), 200)
		}
		line.Latest, line.CheckedAt = entry.Version, entry.CheckedAt
		line.UpdateAvailable = line.Version != "" && line.Latest != "" && versionLess(line.Version, line.Latest)
		_ = enc.Encode(line)
	}
	return writePrivateJSON(latestPath(), cache)
}

// engineVersion reads the bundled engine's version: from the managed install, or from npx's
// cache for the default; "" when it was never fetched.
func (a managedAgent) engineVersion(version string, managed bool) string {
	var roots []string
	if managed {
		roots = []string{filepath.Join(a.versionDir(version), "node_modules")}
	} else {
		cache := os.Getenv("npm_config_cache")
		if cache == "" {
			if h, err := os.UserHomeDir(); err == nil {
				cache = filepath.Join(h, ".npm")
			}
		}
		matches, _ := filepath.Glob(filepath.Join(cache, "_npx", "*", "node_modules"))
		for _, m := range matches {
			if packageField(filepath.Join(m, a.Package), "version") == version {
				roots = append(roots, m)
			}
		}
	}
	for _, root := range roots {
		if v := packageField(filepath.Join(root, a.EnginePackage), a.EngineField); v != "" {
			return a.EngineName + " " + v
		}
	}
	return ""
}

func packageField(dir, field string) string {
	data, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return ""
	}
	var pkg map[string]any
	if json.Unmarshal(data, &pkg) != nil {
		return ""
	}
	v, _ := pkg[field].(string)
	return v
}

// versionLess compares dotted release numbers; a pre-release suffix sorts before its release.
func versionLess(a, b string) bool {
	pa, pb := versionParts(a), versionParts(b)
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			return x < y
		}
	}
	return strings.Contains(a, "-") && !strings.Contains(b, "-")
}

func versionParts(v string) []int {
	core, _, _ := strings.Cut(strings.TrimPrefix(v, "v"), "-")
	var out []int
	for _, p := range strings.Split(core, ".") {
		n, _ := strconv.Atoi(p)
		out = append(out, n)
	}
	return out
}

func acpUpdate(args []string, w io.Writer) error {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		return fmt.Errorf("usage: acp update <%s> [--version V] [--rollback] | acp update <agent> --cli", agentKeys())
	}
	if slices.Contains(args[1:], "--cli") {
		return updateHostCLI(args[0], w)
	}
	a, ok := lookupManagedAgent(args[0])
	if !ok {
		return fmt.Errorf("unknown agent %q (managed: %s)", args[0], agentKeys())
	}
	fs := flag.NewFlagSet("acp update", flag.ContinueOnError)
	want := fs.String("version", "", "install this version instead of the latest")
	rollback := fs.Bool("rollback", false, "go back to the version before the last update")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if err := os.MkdirAll(a.dir(), 0o700); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(a.dir(), ".lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return fmt.Errorf("another update of %s is running", a.Key)
	}
	from := a.running()
	if *rollback {
		prev := a.readPointer("previous")
		if prev == "" {
			return fmt.Errorf("no earlier version of %s to go back to", a.Key)
		}
		if _, err := os.Stat(filepath.Join(a.binDir(prev), a.Bin)); err != nil {
			return fmt.Errorf("%s %s is no longer installed", a.Key, prev)
		}
		if err := a.switchTo(prev); err != nil {
			return err
		}
		return json.NewEncoder(w).Encode(map[string]string{"agent": a.Key, "from": from, "to": prev})
	}
	version := *want
	if version == "" {
		if version, err = latestRelease("registry:" + a.RegistryID); err != nil {
			return err
		}
	}
	if version == a.installed() {
		return json.NewEncoder(w).Encode(map[string]string{"agent": a.Key, "from": from, "to": version})
	}
	tmp := filepath.Join(a.dir(), ".install-"+version)
	_ = os.RemoveAll(tmp)
	defer os.RemoveAll(tmp)
	if err := os.MkdirAll(tmp, 0o700); err != nil {
		return err
	}
	if out, err := npmInstall(tmp, a.Package+"@"+version); err != nil {
		return fmt.Errorf("npm install %s@%s failed: %s", a.Package, version, clip(strings.TrimSpace(string(out)), 300))
	}
	bin := filepath.Join(tmp, "node_modules", ".bin")
	cmdline := "PATH=" + shQuote(bin) + ":\"$PATH\" " + shQuote(filepath.Join(bin, a.Bin))
	userHome, _ := os.UserHomeDir()
	if err := withAgent(cmdline, userHome, "answering initialize", acpSmokeTimeout,
		func(json.RawMessage, agentCall) error { return nil }); err != nil {
		return fmt.Errorf("%s %s did not start, kept %s: %w", a.Key, version, from, err)
	}
	_ = os.RemoveAll(a.versionDir(version))
	if err := os.Rename(tmp, a.versionDir(version)); err != nil {
		return err
	}
	if err := a.switchTo(version); err != nil {
		return err
	}
	a.prune()
	return json.NewEncoder(w).Encode(map[string]string{"agent": a.Key, "from": from, "to": version})
}

// switchTo makes v current and what ran before it the rollback target.
func (a managedAgent) switchTo(v string) error {
	if cur := a.installed(); cur != "" && cur != v {
		if err := os.WriteFile(a.pointer("previous"), []byte(cur+"\n"), 0o600); err != nil {
			return err
		}
	}
	tmp := a.pointer(".current.tmp")
	if err := os.WriteFile(tmp, []byte(v+"\n"), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, a.pointer("current"))
}

// prune drops versions other than current and previous that no running process uses; where
// processes can't be listed (no /proc), nothing is removed.
func (a managedAgent) prune() {
	keep := map[string]bool{a.readPointer("current"): true, a.readPointer("previous"): true}
	entries, err := os.ReadDir(a.dir())
	if err != nil {
		return
	}
	cmdlines, ok := processCmdlines()
	if !ok {
		return
	}
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") || keep[e.Name()] {
			continue
		}
		dir := a.versionDir(e.Name())
		if strings.Contains(cmdlines, dir) {
			continue
		}
		_ = os.RemoveAll(dir)
	}
}

func processCmdlines() (string, bool) {
	procs, err := filepath.Glob("/proc/[0-9]*/cmdline")
	if err != nil || len(procs) == 0 {
		return "", false
	}
	var b strings.Builder
	for _, p := range procs {
		data, err := os.ReadFile(p)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			continue
		}
		b.Write(data)
		b.WriteByte('\n')
	}
	return b.String(), true
}
