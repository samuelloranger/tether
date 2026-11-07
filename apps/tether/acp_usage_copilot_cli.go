package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var errCopilotCLIUnavailable = errors.New("copilot CLI unavailable")

func readCopilotCLIUsage(parent context.Context, command []string) (acpProviderUsage, error) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	if len(command) == 0 {
		return acpProviderUsage{}, errCopilotCLIUnavailable
	}
	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	cmd.Dir = os.TempDir()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stderr = io.Discard
	for _, entry := range os.Environ() {
		// This helper owns a private stdio connection, not the caller's server connection.
		if !strings.HasPrefix(entry, "COPILOT_CONNECTION_TOKEN=") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return acpProviderUsage{}, errCopilotCLIUnavailable
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return acpProviderUsage{}, errCopilotCLIUnavailable
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return acpProviderUsage{}, errCopilotCLIUnavailable
	}
	defer func() {
		cancel()
		_ = stdin.Close()
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Wait()
	}()
	type response struct {
		ID     int             `json:"id"`
		Method string          `json:"method"`
		Result json.RawMessage `json:"result"`
		Error  *struct{}       `json:"error"`
	}
	frames := make(chan response)
	go func() {
		defer close(frames)
		reader := bufio.NewReader(stdout)
		for {
			raw, err := readCopilotQuotaFrame(reader)
			if err != nil {
				return
			}
			var frame response
			if json.Unmarshal(raw, &frame) != nil || frame.Method != "" {
				continue
			}
			select {
			case frames <- frame:
			case <-ctx.Done():
				return
			}
		}
	}()
	id := 0
	call := func(method string) (json.RawMessage, error) {
		id++
		if err := writeCopilotQuotaFrame(stdin, map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": map[string]any{}}); err != nil {
			return nil, errors.New("copilot CLI quota unavailable")
		}
		for {
			select {
			case <-ctx.Done():
				return nil, errors.New("copilot CLI quota timed out")
			case frame, ok := <-frames:
				if !ok {
					return nil, errors.New("copilot CLI quota unavailable")
				}
				if frame.ID != id {
					continue
				}
				if frame.Error != nil {
					return nil, errors.New("copilot CLI quota request failed")
				}
				return frame.Result, nil
			}
		}
	}
	if _, err := call("connect"); err != nil {
		return acpProviderUsage{}, errCopilotCLIUnavailable
	}
	raw, err := call("auth.getStatus")
	if err != nil {
		return acpProviderUsage{}, errCopilotCLIUnavailable
	}
	var auth struct {
		Authenticated *bool  `json:"isAuthenticated"`
		Type          string `json:"authType"`
	}
	if json.Unmarshal(raw, &auth) != nil || auth.Authenticated == nil {
		return acpProviderUsage{}, errors.New("copilot CLI account status unavailable")
	}
	if !*auth.Authenticated || auth.Type == "api-key" {
		return acpProviderUsage{}, errCopilotCLIUnavailable
	}
	// Only subscription metadata is decoded. Authentication fields never enter the usage snapshot.
	raw, err = call("account.getCurrentAuth")
	if err != nil {
		return acpProviderUsage{}, errors.New("copilot CLI subscription unavailable; update the CLI")
	}
	var account struct {
		Info struct {
			User json.RawMessage `json:"copilotUser"`
		} `json:"authInfo"`
	}
	if json.Unmarshal(raw, &account) != nil || len(account.Info.User) == 0 {
		return acpProviderUsage{}, errors.New("copilot CLI did not report subscription metadata")
	}
	usage, err := parseCopilotPlanUsage(account.Info.User)
	if err != nil {
		return acpProviderUsage{}, err
	}
	if usage.Active != nil && !*usage.Active {
		return usage, nil
	}
	raw, err = call("account.getQuota")
	if err != nil {
		return acpProviderUsage{}, errors.New("copilot CLI quota unavailable")
	}
	return parseCopilotCLIQuota(usage, account.Info.User, raw, time.Now())
}

func parseCopilotCLIQuota(usage acpProviderUsage, metadata, raw json.RawMessage, now time.Time) (acpProviderUsage, error) {
	type quota struct {
		Unlimited   bool     `json:"isUnlimitedEntitlement"`
		Entitlement *float64 `json:"entitlementRequests"`
		Used        *float64 `json:"usedRequests"`
		CreditsUsed *float64 `json:"creditsUsed"`
	}
	var data struct {
		Quotas map[string]quota `json:"quotaSnapshots"`
	}
	if json.Unmarshal(raw, &data) != nil || data.Quotas == nil || usage.MonthlyMeter == nil {
		return acpProviderUsage{}, errors.New("copilot CLI returned unreadable quota")
	}
	q, ok := data.Quotas["premium_interactions"]
	key := "premium_interactions"
	if !ok {
		q, ok = data.Quotas["chat"]
		key = "chat"
	}
	if !ok {
		return acpProviderUsage{}, errors.New("copilot CLI did not report a monthly quota")
	}
	valid := func(v *float64) bool { return v != nil && !math.IsNaN(*v) && !math.IsInf(*v, 0) && *v >= 0 }
	meter := usage.MonthlyMeter
	if meter.Unit == "credits" {
		if valid(q.CreditsUsed) {
			meter.Used = q.CreditsUsed
		}
	} else {
		meter.Unlimited = q.Unlimited || (q.Entitlement != nil && *q.Entitlement == -1)
		if meter.Unlimited {
			meter.Used = nil
			meter.Limit = nil
		}
		if !meter.Unlimited && valid(q.Entitlement) && *q.Entitlement > 0 && valid(q.Used) {
			meter.Limit = q.Entitlement
			meter.Used = q.Used
		}
	}
	// The CLI can serve cached quotas. Its resetDate has represented the observation
	// time in released runtimes, so resets come only from the canonical user metadata.
	var source struct {
		Quotas map[string]struct {
			Timestamp string `json:"timestamp_utc"`
		} `json:"quota_snapshots"`
	}
	if json.Unmarshal(metadata, &source) == nil {
		if at, err := time.Parse(time.RFC3339Nano, source.Quotas[key].Timestamp); err == nil && at.Unix() > 0 {
			usage.UpdatedAt = at.Unix()
		}
	}
	usage.Stale = usage.UpdatedAt <= 0 || now.Unix()-usage.UpdatedAt >= 180 || usage.UpdatedAt > now.Unix()+60
	return usage, nil
}

func writeCopilotQuotaFrame(w io.Writer, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "Content-Length: %d\r\n\r\n", len(raw)); err != nil {
		return err
	}
	_, err = w.Write(raw)
	return err
}

func readCopilotQuotaFrame(reader *bufio.Reader) ([]byte, error) {
	length := -1
	bytes := 0
	for {
		line, err := reader.ReadSlice('\n')
		if err != nil {
			return nil, err
		}
		bytes += len(line)
		if bytes > 8192 {
			return nil, errors.New("copilot quota header too large")
		}
		text := strings.TrimSpace(string(line))
		if text == "" {
			break
		}
		key, value, ok := strings.Cut(text, ":")
		if !ok {
			return nil, errors.New("invalid copilot quota header")
		}
		if strings.EqualFold(key, "Content-Length") {
			if length != -1 {
				return nil, errors.New("duplicate copilot quota length")
			}
			length, err = strconv.Atoi(strings.TrimSpace(value))
			if err != nil || length <= 0 || length > 2<<20 {
				return nil, errors.New("invalid copilot quota length")
			}
		}
	}
	if length <= 0 {
		return nil, errors.New("missing copilot quota length")
	}
	raw := make([]byte, length)
	_, err := io.ReadFull(reader, raw)
	return raw, err
}
