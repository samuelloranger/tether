package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestClaudePlanWindowsArePercentagesNotFractions(t *testing.T) {
	raw := json.RawMessage(`{"rate_limits_available":true,"rate_limits":{"five_hour":{"utilization":0,"resets_at":"2026-11-01T00:00:00Z"},"seven_day":{"utilization":68.5,"resets_at":"2026-11-03T00:00:00Z"}}}`)
	got, err := parseClaudePlanUsage(raw)
	if err != nil || got.FiveHour == nil || got.FiveHour.UsedPercent != 0 || got.Weekly == nil || got.Weekly.UsedPercent != 68.5 {
		t.Fatalf("%+v %v", got, err)
	}
	for _, raw := range []string{`{}`, `{"rate_limits_available":false,"rate_limits":null}`, `{"rate_limits_available":true,"rate_limits":{"five_hour":{"utilization":null,"resets_at":"2026-11-01T00:00:00Z"}}}`} {
		if _, err := parseClaudePlanUsage(json.RawMessage(raw)); err == nil {
			t.Errorf("accepted missing usage %s", raw)
		}
	}
}

func TestCodexPlanWindowsMatchDurationsAndProductBucket(t *testing.T) {
	got, err := parseCodexPlanUsage(json.RawMessage(`{"rateLimits":{"limitId":"other","primary":{"usedPercent":99,"windowDurationMins":300,"resetsAt":100}},"rateLimitsByLimitId":{"codex":{"limitId":"codex","primary":{"usedPercent":83,"windowDurationMins":10080,"resetsAt":200},"secondary":{"usedPercent":24,"windowDurationMins":300,"resetsAt":100}}}}`))
	if err != nil || got.FiveHour == nil || got.Weekly == nil || got.FiveHour.UsedPercent != 24 || got.Weekly.UsedPercent != 83 {
		t.Fatalf("%+v %v", got, err)
	}
	for _, raw := range []string{`{}`, `{"rateLimits":{"primary":{"usedPercent":30,"windowDurationMins":15,"resetsAt":100}}}`, `{"rateLimits":{"primary":{"windowDurationMins":300,"resetsAt":100}}}`, `{"rateLimits":{"primary":{"usedPercent":-1,"windowDurationMins":300,"resetsAt":100}}}`, `{"rateLimits":{"limitId":"other","primary":{"usedPercent":10,"windowDurationMins":300,"resetsAt":100}}}`} {
		if _, err := parseCodexPlanUsage(json.RawMessage(raw)); err == nil {
			t.Errorf("accepted unknown/missing window %s", raw)
		}
	}
	got, err = parseCodexPlanUsage(json.RawMessage(`{"rateLimits":{"primary":{"usedPercent":0,"windowDurationMins":300,"resetsAt":100}}}`))
	if err != nil || got.FiveHour == nil || got.Weekly != nil {
		t.Fatalf("partial missing window: %+v %v", got, err)
	}
}

func TestUsageCacheThrottlesAndPreservesTimestampOnFailure(t *testing.T) {
	acpEnv(t)
	now := time.Unix(1800000000, 0)
	var calls atomic.Int32
	failed := false
	read := func() (acpProviderUsage, error) {
		calls.Add(1)
		if failed {
			return acpProviderUsage{}, errors.New("provider unavailable")
		}
		return acpProviderUsage{FiveHour: &acpQuotaWindow{UsedPercent: 42, ResetsAt: now.Unix() + 1000}}, nil
	}
	deps := acpUsageDeps{claude: read, codex: read, now: func() time.Time { return now }}
	fetch := func() acpUsageSnapshot {
		t.Helper()
		var b bytes.Buffer
		if err := acpUsageWith(&b, deps); err != nil {
			t.Fatal(err)
		}
		var out acpUsageSnapshot
		if err := json.Unmarshal(b.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	first := fetch()
	if first.Claude.Stale || first.Claude.UpdatedAt != now.Unix() {
		t.Fatalf("%+v", first)
	}
	fetch()
	if calls.Load() != 2 {
		t.Fatal("cache did not throttle multiple devices")
	}
	now = now.Add(61 * time.Second)
	failed = true
	stale := fetch()
	if !stale.Claude.Stale || stale.Claude.FiveHour == nil || stale.Claude.UpdatedAt != first.Claude.UpdatedAt || stale.Claude.Error == "" {
		t.Fatalf("failure hid or refreshed stale reading: %+v", stale)
	}
	fetch()
	if calls.Load() != 4 {
		t.Fatal("failed refresh not throttled")
	}
	st, err := os.Stat(filepath.Join(home(), "plan-usage.json"))
	if err != nil || st.Mode().Perm() != 0600 {
		t.Fatal("cache permissions", err)
	}
}

func TestPlanRuntimeControlRequestsDoNotSubmitPrompts(t *testing.T) {
	for _, provider := range []string{"claude", "codex"} {
		t.Run(provider, func(t *testing.T) {
			capture := filepath.Join(t.TempDir(), "input")
			var body string
			if provider == "claude" {
				body = `read l; echo "$l" >> "$CAPTURE"; echo '{"type":"control_response","response":{"subtype":"success","request_id":"usage-init","response":{}}}'
read l; echo "$l" >> "$CAPTURE"; echo '{"type":"control_response","response":{"subtype":"success","request_id":"usage-read","response":{"rate_limits_available":false,"rate_limits":null}}}'
sleep 30
`
			} else {
				body = `read l; echo "$l" >> "$CAPTURE"; echo '{"id":1,"result":{}}'
read l; echo "$l" >> "$CAPTURE"
read l; echo "$l" >> "$CAPTURE"; echo '{"id":2,"result":{"rateLimits":{}}}'
sleep 30
`
			}
			t.Setenv("CAPTURE", capture)
			command := strings.Fields(fakeAgent(t, body))
			start := time.Now()
			raw, err := queryPlanRuntime(command, provider)
			if err != nil || len(raw) == 0 || time.Since(start) > 3*time.Second {
				t.Fatalf("%s %v after %v", raw, err, time.Since(start))
			}
			input, err := os.ReadFile(capture)
			if err != nil {
				t.Fatal(err)
			}
			for _, forbidden := range []string{"session/prompt", "turn/start", `"type":"user"`} {
				if bytes.Contains(input, []byte(forbidden)) {
					t.Errorf("submitted model work: %s", input)
				}
			}
			want := "get_usage"
			if provider == "codex" {
				want = "account/rateLimits/read"
			}
			if !bytes.Contains(input, []byte(want)) {
				t.Fatal(fmt.Sprintf("missing %s in %s", want, input))
			}
		})
	}
}
