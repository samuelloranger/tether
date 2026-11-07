package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func inactivePlanUsage() acpProviderUsage {
	active := false
	return acpProviderUsage{Active: &active}
}

func readOpenCodePlanUsage() (acpProviderUsage, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	key, err := openCodeUsageKey(ctx)
	if err != nil {
		return acpProviderUsage{}, err
	}
	if key == "" {
		return inactivePlanUsage(), nil
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return fetchOpenCodePlanUsage(ctx, client, "https://opencode.ai/zen/go/v1/usage", key, time.Now())
}

func openCodeUsageKey(ctx context.Context) (string, error) {
	if key := strings.TrimSpace(os.Getenv("OPENCODE_API_KEY")); key != "" {
		return key, nil
	}
	// Let current OpenCode versions read their own database, including the active account.
	binary, err := exec.LookPath("opencode")
	if err != nil {
		if dir, e := os.UserHomeDir(); e == nil {
			binary = filepath.Join(dir, ".opencode", "bin", "opencode")
		}
	}
	cmd := exec.CommandContext(ctx, binary, "auth", "export", "opencode-go")
	cmd.Dir = os.TempDir()
	cmd.Stderr = io.Discard
	if raw, err := cmd.Output(); err == nil {
		return parseOpenCodeUsageKey(raw, time.Now())
	}
	// OpenCode 1.x stores API credentials here and has no auth export command.
	base := os.Getenv("XDG_DATA_HOME")
	if !filepath.IsAbs(base) {
		dir, err := os.UserHomeDir()
		if err != nil {
			return "", errors.New("opencode account unavailable")
		}
		base = filepath.Join(dir, ".local", "share")
	}
	raw, err := os.ReadFile(filepath.Join(base, "opencode", "auth.json"))
	if errors.Is(err, os.ErrNotExist) {
		if _, dbErr := os.Stat(filepath.Join(base, "opencode", "opencode.db")); dbErr == nil {
			return "", errors.New("opencode account unavailable; check the host CLI")
		}
		return "", nil
	}
	if err != nil {
		return "", errors.New("opencode account unavailable")
	}
	var entries map[string]struct {
		Type string `json:"type"`
		Key  string `json:"key"`
	}
	if json.Unmarshal(raw, &entries) != nil {
		return "", errors.New("opencode account unavailable")
	}
	entry := entries["opencode-go"]
	if entry.Type != "api" {
		return "", nil
	}
	if strings.TrimSpace(entry.Key) == "" {
		return "", errors.New("opencode account unavailable")
	}
	return entry.Key, nil
}

func parseOpenCodeUsageKey(raw []byte, now time.Time) (string, error) {
	var entries []struct {
		Integration string `json:"integrationID"`
		Active      bool   `json:"active"`
		Value       struct {
			Type    string `json:"type"`
			Key     string `json:"key"`
			Access  string `json:"access"`
			Expires int64  `json:"expires"`
		} `json:"value"`
	}
	if json.Unmarshal(raw, &entries) != nil {
		return "", errors.New("opencode account unavailable")
	}
	key := ""
	for _, entry := range entries {
		if entry.Integration != "opencode-go" || !entry.Active {
			continue
		}
		if key != "" {
			return "", errors.New("opencode active account is ambiguous")
		}
		switch entry.Value.Type {
		case "key":
			key = entry.Value.Key
		case "oauth":
			if entry.Value.Expires <= now.UnixMilli() {
				return "", errors.New("opencode sign-in expired")
			}
			key = entry.Value.Access
		default:
			return "", errors.New("opencode account type unavailable")
		}
		if key == "" || strings.ContainsAny(key, " \t\n\r") {
			return "", errors.New("opencode account unavailable")
		}
	}
	return key, nil
}

func fetchOpenCodePlanUsage(ctx context.Context, client *http.Client, endpoint, key string, now time.Time) (acpProviderUsage, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return acpProviderUsage{}, errors.New("opencode usage unavailable")
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return acpProviderUsage{}, errors.New("opencode usage unavailable")
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return acpProviderUsage{}, errors.New("opencode usage unavailable")
	}
	if resp.StatusCode != http.StatusOK {
		// An expired credential must retain the last known reading, unlike an ended subscription.
		var failure struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		_ = json.Unmarshal(raw, &failure)
		if failure.Error.Code == "no_subscription" {
			return inactivePlanUsage(), nil
		}
		return acpProviderUsage{}, errors.New("opencode usage unavailable; check host sign-in")
	}
	return parseOpenCodePlanUsage(raw, now)
}

func parseOpenCodePlanUsage(raw []byte, now time.Time) (acpProviderUsage, error) {
	type bucket struct {
		Percent        *float64 `json:"usagePercent"`
		CurrentPercent *float64 `json:"percent"`
		Used           *float64 `json:"used"`
		Limit          *float64 `json:"limit"`
		Reset          *int64   `json:"resetInSec"`
		ResetsAt       string   `json:"resetsAt"`
	}
	var data struct {
		Usage *struct {
			Rolling *bucket `json:"rolling"`
			Weekly  *bucket `json:"weekly"`
			Monthly *bucket `json:"monthly"`
		} `json:"usage"`
	}
	if json.Unmarshal(raw, &data) != nil || data.Usage == nil {
		return acpProviderUsage{}, errors.New("opencode returned unreadable plan usage")
	}
	window := func(b *bucket) *acpQuotaWindow {
		if b == nil {
			return nil
		}
		var reset int64
		if b.ResetsAt != "" {
			at, err := time.Parse(time.RFC3339Nano, b.ResetsAt)
			if err != nil {
				return nil
			}
			reset = at.Unix()
		} else if b.Reset != nil && *b.Reset >= 0 && *b.Reset <= 366*86400 {
			reset = now.Unix() + *b.Reset
		} else {
			return nil
		}
		percent := b.Percent
		if percent == nil {
			percent = b.CurrentPercent
		}
		if percent == nil && b.Used != nil && b.Limit != nil && *b.Limit > 0 {
			value := *b.Used / *b.Limit * 100
			percent = &value
		}
		if percent == nil || *percent < 0 {
			return nil
		}
		value := math.Min(*percent, 100)
		return quotaWindow(&value, reset)
	}
	out := acpProviderUsage{FiveHour: window(data.Usage.Rolling), Weekly: window(data.Usage.Weekly), Monthly: window(data.Usage.Monthly)}
	if out.FiveHour == nil && out.Weekly == nil && out.Monthly == nil {
		return out, errors.New("opencode did not report plan limits")
	}
	return out, nil
}
