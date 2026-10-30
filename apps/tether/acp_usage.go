package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

type acpQuotaWindow struct {
	UsedPercent float64 `json:"usedPercent"`
	ResetsAt    int64   `json:"resetsAt"`
}

type acpProviderUsage struct {
	FiveHour  *acpQuotaWindow `json:"fiveHour"`
	Weekly    *acpQuotaWindow `json:"weekly"`
	UpdatedAt int64           `json:"updatedAt"`
	Stale     bool            `json:"stale"`
	Error     string          `json:"error,omitempty"`
}

type acpUsageSnapshot struct {
	Claude    acpProviderUsage `json:"claude"`
	Codex     acpProviderUsage `json:"codex"`
	CheckedAt int64            `json:"checkedAt"`
}

type acpUsageDeps struct {
	claude func() (acpProviderUsage, error)
	codex  func() (acpProviderUsage, error)
	now    func() time.Time
}

func acpUsage(args []string, w io.Writer) error {
	fs := flag.NewFlagSet("acp usage", flag.ContinueOnError)
	fs.Bool("json", false, "print account plan usage as JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("usage: acp usage [--json]")
	}
	return acpUsageWith(w, acpUsageDeps{claude: readClaudePlanUsage, codex: readCodexPlanUsage, now: time.Now})
}

// All devices on a host share one refresh. Failures are throttled too, and keep
// the last successful reading with its original timestamp and an explicit error.
func acpUsageWith(w io.Writer, deps acpUsageDeps) error {
	return withSessionLock("acp-plan-usage", func() error {
		path := filepath.Join(home(), "plan-usage.json")
		var out acpUsageSnapshot
		if data, err := os.ReadFile(path); err == nil {
			_ = json.Unmarshal(data, &out)
		}
		now := deps.now().Unix()
		if out.CheckedAt <= 0 || now < out.CheckedAt || now-out.CheckedAt >= 60 {
			var wg sync.WaitGroup
			refresh := func(dst *acpProviderUsage, read func() (acpProviderUsage, error)) {
				defer wg.Done()
				fresh, err := read()
				if err == nil {
					fresh.UpdatedAt = now
					*dst = fresh
				} else {
					dst.Error = err.Error()
					dst.Stale = dst.UpdatedAt > 0
				}
			}
			wg.Add(2)
			go refresh(&out.Claude, deps.claude)
			go refresh(&out.Codex, deps.codex)
			wg.Wait()
			out.CheckedAt = now
			if err := writePrivateJSON(path, out); err != nil {
				return err
			}
		}
		return json.NewEncoder(w).Encode(out)
	})
}

// Provider limits are read by the CLIs that already own host authentication.
// No credential is read, copied to the phone, or included in an error message.
// These control requests never submit a user prompt or start a model turn.
func readClaudePlanUsage() (acpProviderUsage, error) {
	command := []string{"claude", "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--settings", `{"disableAllHooks":true}`, "--strict-mcp-config", "--mcp-config", `{"mcpServers":{}}`}
	raw, err := queryPlanRuntime(command, "claude")
	if err != nil {
		return acpProviderUsage{}, err
	}
	return parseClaudePlanUsage(raw)
}

func readCodexPlanUsage() (acpProviderUsage, error) {
	raw, err := queryPlanRuntime([]string{"codex", "app-server", "--listen", "stdio://"}, "codex")
	if err != nil {
		return acpProviderUsage{}, err
	}
	return parseCodexPlanUsage(raw)
}

func queryPlanRuntime(command []string, provider string) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	cmd.Dir = os.TempDir()
	// Keep this helper separate from any parent Claude session. Hooks and MCP
	// are disabled in its arguments; user authentication remains host-owned.
	for _, e := range os.Environ() {
		if !strings.HasPrefix(e, "CLAUDECODE=") {
			cmd.Env = append(cmd.Env, e)
		}
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stderr = io.Discard
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("%s usage unavailable", provider)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("%s usage unavailable", provider)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("%s is not available on this host", provider)
	}
	defer func() { _ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); _ = cmd.Wait() }()
	lines := make(chan []byte)
	go func() {
		defer close(lines)
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 4096), 2<<20)
		for sc.Scan() {
			line := append([]byte(nil), sc.Bytes()...)
			select {
			case lines <- line:
			case <-ctx.Done():
				return
			}
		}
	}()
	write := func(value any) error { return json.NewEncoder(stdin).Encode(value) }
	var request any
	if provider == "claude" {
		request = map[string]any{"type": "control_request", "request_id": "usage-init", "request": map[string]any{"subtype": "initialize"}}
	} else {
		request = map[string]any{"id": 1, "method": "initialize", "params": map[string]any{"clientInfo": map[string]any{"name": "tether-usage", "version": "1"}, "capabilities": map[string]any{}}}
	}
	if err := write(request); err != nil {
		return nil, fmt.Errorf("%s usage request failed", provider)
	}
	initialized := false
	for {
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("%s usage timed out", provider)
		case line, ok := <-lines:
			if !ok {
				return nil, fmt.Errorf("%s usage unavailable; update the host CLI if needed", provider)
			}
			var envelope struct {
				ID       int             `json:"id"`
				Type     string          `json:"type"`
				Result   json.RawMessage `json:"result"`
				Error    json.RawMessage `json:"error"`
				Response struct {
					RequestID string          `json:"request_id"`
					Subtype   string          `json:"subtype"`
					Response  json.RawMessage `json:"response"`
				} `json:"response"`
			}
			if json.Unmarshal(line, &envelope) != nil {
				continue
			}
			if provider == "claude" {
				if envelope.Type != "control_response" {
					continue
				}
				want := "usage-init"
				if initialized {
					want = "usage-read"
				}
				if envelope.Response.RequestID != want {
					continue
				}
				if envelope.Response.Subtype != "success" {
					return nil, errors.New("claude plan usage unavailable in this CLI")
				}
				if initialized {
					return envelope.Response.Response, nil
				}
				request = map[string]any{"type": "control_request", "request_id": "usage-read", "request": map[string]any{"subtype": "get_usage", "skip_behaviors": true}}
			} else {
				want := 1
				if initialized {
					want = 2
				}
				if envelope.ID != want {
					continue
				}
				if len(envelope.Error) > 0 && string(envelope.Error) != "null" {
					return nil, errors.New("codex plan usage unavailable; sign in with ChatGPT on the host")
				}
				if initialized {
					return envelope.Result, nil
				}
				if err := write(map[string]any{"method": "initialized"}); err != nil {
					return nil, errors.New("codex usage request failed")
				}
				request = map[string]any{"id": 2, "method": "account/rateLimits/read"}
			}
			initialized = true
			if err := write(request); err != nil {
				return nil, fmt.Errorf("%s usage request failed", provider)
			}
		}
	}
}

func quotaWindow(used *float64, reset int64) *acpQuotaWindow {
	if used == nil || math.IsNaN(*used) || math.IsInf(*used, 0) || *used < 0 || *used > 100 || reset <= 0 {
		return nil
	}
	return &acpQuotaWindow{UsedPercent: *used, ResetsAt: reset}
}

func parseClaudePlanUsage(raw json.RawMessage) (acpProviderUsage, error) {
	type bucket struct {
		Utilization *float64 `json:"utilization"`
		Reset       string   `json:"resets_at"`
	}
	var data struct {
		Available bool `json:"rate_limits_available"`
		Limits    *struct {
			FiveHour *bucket `json:"five_hour"`
			Weekly   *bucket `json:"seven_day"`
		} `json:"rate_limits"`
	}
	if json.Unmarshal(raw, &data) != nil || !data.Available || data.Limits == nil {
		return acpProviderUsage{}, errors.New("claude plan usage unavailable for this sign-in")
	}
	window := func(b *bucket) *acpQuotaWindow {
		if b == nil {
			return nil
		}
		reset, err := time.Parse(time.RFC3339, b.Reset)
		if err != nil {
			return nil
		}
		return quotaWindow(b.Utilization, reset.Unix())
	}
	out := acpProviderUsage{FiveHour: window(data.Limits.FiveHour), Weekly: window(data.Limits.Weekly)}
	if out.FiveHour == nil && out.Weekly == nil {
		return out, errors.New("claude did not report 5-hour or weekly limits")
	}
	return out, nil
}

func parseCodexPlanUsage(raw json.RawMessage) (acpProviderUsage, error) {
	type bucket struct {
		Used    *float64 `json:"usedPercent"`
		Minutes int      `json:"windowDurationMins"`
		Reset   int64    `json:"resetsAt"`
	}
	type limits struct {
		ID        string  `json:"limitId"`
		Primary   *bucket `json:"primary"`
		Secondary *bucket `json:"secondary"`
	}
	var data struct {
		Limits limits            `json:"rateLimits"`
		All    map[string]limits `json:"rateLimitsByLimitId"`
	}
	if json.Unmarshal(raw, &data) != nil {
		return acpProviderUsage{}, errors.New("codex returned unreadable plan limits")
	}
	current := data.Limits
	if l, ok := data.All["codex"]; ok {
		current = l
	}
	// Never relabel a different metered product or a changed time window as 5h/weekly.
	if current.ID != "" && current.ID != "codex" {
		return acpProviderUsage{}, errors.New("codex plan bucket unavailable")
	}
	out := acpProviderUsage{}
	for _, b := range []*bucket{current.Primary, current.Secondary} {
		if b == nil {
			continue
		}
		switch b.Minutes {
		case 300:
			out.FiveHour = quotaWindow(b.Used, b.Reset)
		case 10080:
			out.Weekly = quotaWindow(b.Used, b.Reset)
		}
	}
	if out.FiveHour == nil && out.Weekly == nil {
		return out, errors.New("codex did not report 5-hour or weekly limits")
	}
	return out, nil
}
