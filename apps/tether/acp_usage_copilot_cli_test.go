package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCopilotQuotaHelper(t *testing.T) {
	mode := os.Getenv("TETHER_COPILOT_QUOTA_HELPER")
	if mode == "" {
		return
	}
	if mode == "hang" {
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	reader := bufio.NewReader(os.Stdin)
	for {
		raw, err := readCopilotQuotaFrame(reader)
		if err != nil {
			os.Exit(0)
		}
		var request struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
		}
		if json.Unmarshal(raw, &request) != nil {
			os.Exit(2)
		}
		if path := os.Getenv("TETHER_COPILOT_QUOTA_CAPTURE"); path != "" {
			f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
			if err != nil {
				os.Exit(2)
			}
			_, _ = f.Write(append(raw, '\n'))
			_ = f.Close()
		}
		var result any
		switch request.Method {
		case "connect":
			_ = writeCopilotQuotaFrame(os.Stdout, map[string]any{"jsonrpc": "2.0", "method": "log", "params": map[string]any{}})
			result = map[string]any{"ok": true, "protocolVersion": 3}
		case "auth.getStatus":
			result = map[string]any{"isAuthenticated": mode != "unsigned", "authType": "user"}
		case "account.getCurrentAuth":
			user := map[string]any{"copilot_plan": "individual", "quota_reset_date_utc": "2026-12-01T00:00:00Z", "token_based_billing": mode != "legacy",
				"quota_snapshots": map[string]any{"premium_interactions": map[string]any{"credits_used": 12.5, "entitlement": 300, "remaining": 90, "timestamp_utc": "2026-11-07T00:00:00Z"}}}
			if mode == "free" {
				user["access_type_sku"] = "free_limited_copilot"
			}
			result = map[string]any{"authInfo": map[string]any{"copilotUser": user, "token": "private-test-credential"}}
		case "account.getQuota":
			if mode == "failed" {
				_ = writeCopilotQuotaFrame(os.Stdout, map[string]any{"jsonrpc": "2.0", "id": request.ID, "error": map[string]any{"code": -32000, "message": "private-test-credential"}})
				continue
			}
			result = map[string]any{"quotaSnapshots": map[string]any{"premium_interactions": map[string]any{"entitlementRequests": 300, "usedRequests": 210, "resetDate": "2026-11-07T00:00:00Z"}}}
		default:
			os.Exit(2)
		}
		if writeCopilotQuotaFrame(os.Stdout, map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result}) != nil {
			os.Exit(2)
		}
	}
}

func copilotQuotaHelperCommand(t *testing.T, mode string) []string {
	t.Helper()
	t.Setenv("TETHER_COPILOT_QUOTA_HELPER", mode)
	return []string{os.Args[0], "-test.run=^TestCopilotQuotaHelper$", "--", "--headless", "--no-auto-update", "--stdio"}
}

func TestCopilotCLIReadsOnlyAccountMetadataAndQuota(t *testing.T) {
	for _, mode := range []string{"credits", "legacy", "free"} {
		t.Run(mode, func(t *testing.T) {
			command := copilotQuotaHelperCommand(t, mode)
			capture := filepath.Join(t.TempDir(), "requests")
			t.Setenv("TETHER_COPILOT_QUOTA_CAPTURE", capture)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			usage, err := readCopilotCLIUsage(ctx, command)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "free" {
				if usage.Active == nil || *usage.Active || usage.MonthlyMeter != nil {
					t.Fatal("CLI Free plan was displayed")
				}
			} else {
				meter := usage.MonthlyMeter
				if meter == nil {
					t.Fatal("missing monthly usage")
				}
				if mode == "credits" && (meter.Unit != "credits" || meter.Used == nil || *meter.Used != 12.5 || meter.Limit != nil) {
					t.Fatal("request placeholders became credit usage")
				}
				if mode == "legacy" && (meter.Used == nil || *meter.Used != 210 || meter.Limit == nil || *meter.Limit != 300) {
					t.Fatal("lost CLI request allowance")
				}
				reset, _ := time.Parse(time.RFC3339, "2026-12-01T00:00:00Z")
				observed, _ := time.Parse(time.RFC3339, "2026-11-07T00:00:00Z")
				if meter.ResetsAt != reset.Unix() || usage.UpdatedAt != observed.Unix() {
					t.Fatal("observation time became a reset time or was refreshed")
				}
			}
			output, _ := json.Marshal(usage)
			if bytes.Contains(output, []byte("private-test-credential")) {
				t.Fatal("credential escaped into usage")
			}
			input, err := os.ReadFile(capture)
			if err != nil {
				t.Fatal(err)
			}
			for _, forbidden := range []string{"session.create", "session.send", "session/prompt", "turn/start", "account.login", "account.logout"} {
				if bytes.Contains(input, []byte(forbidden)) {
					t.Fatalf("unexpected model work or auth mutation: %s", forbidden)
				}
			}
			if mode != "free" && !bytes.Contains(input, []byte("account.getQuota")) {
				t.Fatal("quota RPC was not called")
			}
		})
	}
}

func TestCopilotFallbackDoesNotSwitchAnAuthenticatedCLIAccount(t *testing.T) {
	for _, mode := range []string{"credits", "free", "failed", "unsigned"} {
		t.Run(mode, func(t *testing.T) {
			command := copilotQuotaHelperCommand(t, mode)
			fallback := false
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_, err := readCopilotUsageWith(func() (acpProviderUsage, error) { return readCopilotCLIUsage(ctx, command) }, func() (acpProviderUsage, error) {
				fallback = true
				return inactivePlanUsage(), nil
			})
			if fallback != (mode == "unsigned") {
				t.Fatal("incorrect gh fallback policy")
			}
			if (mode == "failed") != (err != nil) {
				t.Fatal("authenticated CLI failure was hidden")
			}
			if err != nil && strings.Contains(err.Error(), "private-test-credential") {
				t.Fatal("raw RPC error escaped")
			}
		})
	}
	_, err := readCopilotCLIUsage(context.Background(), []string{filepath.Join(t.TempDir(), "missing-copilot")})
	if !errors.Is(err, errCopilotCLIUnavailable) {
		t.Fatal("missing CLI did not permit gh fallback")
	}
}

func TestCopilotCLIProbeHasABoundedLifetime(t *testing.T) {
	command := copilotQuotaHelperCommand(t, "hang")
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := readCopilotCLIUsage(ctx, command)
	if err == nil || time.Since(start) > time.Second {
		t.Fatal("headless probe did not terminate promptly")
	}
}

func TestCopilotQuotaFramesAreBoundedAndHandleUTF8(t *testing.T) {
	var output bytes.Buffer
	if err := writeCopilotQuotaFrame(&output, map[string]string{"text": "quota été"}); err != nil {
		t.Fatal(err)
	}
	raw, err := readCopilotQuotaFrame(bufio.NewReader(&output))
	if err != nil || !bytes.Contains(raw, []byte("été")) {
		t.Fatal("invalid UTF-8 framing", err)
	}
	for _, raw := range []string{"Content-Length: 2097153\r\n\r\n", "Content-Length: -1\r\n\r\n", "Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}", "\r\n{}", "Content-Length: 2\r\n\r\n{"} {
		if _, err := readCopilotQuotaFrame(bufio.NewReader(strings.NewReader(raw))); err == nil {
			t.Fatal("accepted malformed/oversize frame")
		}
	}
}

func TestCopilotCacheKeepsTheCLIsObservationTime(t *testing.T) {
	for _, fixture := range []struct {
		name     string
		observed int64
	}{{"dated", 1800000000}, {"undated", 0}} {
		t.Run(fixture.name, func(t *testing.T) {
			acpEnv(t)
			now := time.Unix(1800000600, 0)
			used := 12.5
			failed := false
			read := func() (acpProviderUsage, error) {
				if failed {
					return acpProviderUsage{}, errors.New("temporarily unavailable")
				}
				return acpProviderUsage{MonthlyMeter: &acpMonthlyMeter{Used: &used, Unit: "credits"}, UpdatedAt: fixture.observed, Stale: true}, nil
			}
			var output bytes.Buffer
			if err := acpUsageWith(&output, acpUsageDeps{copilot: read, now: func() time.Time { return now }}); err != nil {
				t.Fatal(err)
			}
			var usage acpUsageSnapshot
			if err := json.Unmarshal(output.Bytes(), &usage); err != nil {
				t.Fatal(err)
			}
			if usage.Copilot.UpdatedAt != fixture.observed || !usage.Copilot.Stale || usage.CheckedAt != now.Unix() {
				t.Fatal("polling the CLI cache made an old or undated reading fresh")
			}
			failed = true
			now = now.Add(61 * time.Second)
			output.Reset()
			if err := acpUsageWith(&output, acpUsageDeps{copilot: read, now: func() time.Time { return now }}); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(output.Bytes(), &usage); err != nil {
				t.Fatal(err)
			}
			if usage.Copilot.UpdatedAt != fixture.observed || !usage.Copilot.Stale || usage.Copilot.MonthlyMeter == nil {
				t.Fatal("a failed refresh lost the cached reading's freshness state")
			}
		})
	}
}
