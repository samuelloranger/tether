package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestOpenCodeUsageKeepsPercentUnitsAndMonthlyLimit(t *testing.T) {
	now := time.Unix(1800000000, 0)
	out, err := parseOpenCodePlanUsage([]byte(`{"usage":{"rolling":{"usagePercent":0.25,"resetInSec":600},"weekly":{"used":12,"limit":30,"resetInSec":7200},"monthly":{"usagePercent":63,"resetInSec":86400}}}`), now)
	if err != nil || out.FiveHour == nil || out.FiveHour.UsedPercent != 0.25 || out.FiveHour.ResetsAt != now.Unix()+600 || out.Weekly == nil || out.Weekly.UsedPercent != 40 || out.Monthly == nil || out.Monthly.UsedPercent != 63 {
		t.Fatalf("incorrect plan windows: %+v, %v", out, err)
	}
	for _, raw := range []string{`{}`, `{"usage":{}}`, `{"usage":{"rolling":{"usagePercent":0}}}`, `{"usage":{"rolling":{"usagePercent":-1,"resetInSec":100}}}`} {
		if _, err := parseOpenCodePlanUsage([]byte(raw), now); err == nil {
			t.Errorf("accepted missing/invalid usage: %s", raw)
		}
	}
}

func TestOpenCodeCurrentUsageResponseUsesPercentAndAbsoluteReset(t *testing.T) {
	out, err := parseOpenCodePlanUsage([]byte(`{"usage":{"rolling":{"status":"ok","percent":0.25,"resetsAt":"2026-11-07T16:30:00.000Z"},"weekly":{"status":"exhausted","percent":100,"resetsAt":"2026-11-10T00:00:00Z"},"monthly":{"percent":50,"resetsAt":"2026-12-01T00:00:00Z"}}}`), time.Now())
	if err != nil || out.FiveHour == nil || out.FiveHour.UsedPercent != 0.25 || out.Weekly == nil || out.Weekly.UsedPercent != 100 || out.Monthly == nil || out.Monthly.UsedPercent != 50 {
		t.Fatalf("incorrect current API response: %+v, %v", out, err)
	}
	want, _ := time.Parse(time.RFC3339, "2026-11-07T16:30:00Z")
	if out.FiveHour.ResetsAt != want.Unix() {
		t.Fatal("absolute reset was changed")
	}
}

func TestOpenCodeCredentialSelectsOnlyActiveGoAccount(t *testing.T) {
	now := time.Unix(1800000000, 0)
	raw := []byte(`[{"integrationID":"opencode","active":true,"value":{"type":"key","key":"zen-only"}},{"integrationID":"opencode-go","active":false,"value":{"type":"key","key":"old"}},{"integrationID":"opencode-go","active":true,"value":{"type":"key","key":"go-test"}}]`)
	key, err := parseOpenCodeUsageKey(raw, now)
	if err != nil || key != "go-test" {
		t.Fatal("did not select active Go account")
	}
	key, err = parseOpenCodeUsageKey([]byte(`[{"integrationID":"opencode","active":true,"value":{"type":"key","key":"zen-only"}}]`), now)
	if err != nil || key != "" {
		t.Fatal("Zen must not become a Go subscription")
	}
	for _, raw := range []string{
		`[{"integrationID":"opencode-go","active":true,"value":{"type":"oauth","access":"expired-secret","expires":1}}]`,
		`[{"integrationID":"opencode-go","active":true,"value":{"type":"key","key":"a"}},{"integrationID":"opencode-go","active":true,"value":{"type":"key","key":"b"}}]`,
	} {
		if _, err := parseOpenCodeUsageKey([]byte(raw), now); err == nil {
			t.Error("accepted expired or ambiguous account")
		}
	}
}

func TestOpenCodeUsageRequestIsReadOnlyAndErrorsDoNotExposeCredentials(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer private-test-key" {
			t.Error("incorrect usage request")
		}
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"private-test-key"}`))
	}))
	defer server.Close()
	_, err := fetchOpenCodePlanUsage(context.Background(), server.Client(), server.URL, "private-test-key", time.Now())
	if err == nil || bytes.Contains([]byte(err.Error()), []byte("private-test-key")) {
		t.Fatal("error included credentials or was missing")
	}
}

func TestUsageCacheClearsInactivePlansButRetainsTransientFailures(t *testing.T) {
	acpEnv(t)
	now := time.Unix(1800000000, 0)
	state := "active"
	read := func() (acpProviderUsage, error) {
		switch state {
		case "inactive":
			return inactivePlanUsage(), nil
		case "failed":
			return acpProviderUsage{}, errors.New("temporarily offline")
		default:
			return acpProviderUsage{FiveHour: &acpQuotaWindow{UsedPercent: 0, ResetsAt: now.Unix() + 600}}, nil
		}
	}
	deps := acpUsageDeps{opencode: read, now: func() time.Time { return now }}
	fetch := func() acpProviderUsage {
		t.Helper()
		var b bytes.Buffer
		if err := acpUsageWith(&b, deps); err != nil {
			t.Fatal(err)
		}
		var snapshot acpUsageSnapshot
		if err := json.Unmarshal(b.Bytes(), &snapshot); err != nil {
			t.Fatal(err)
		}
		return snapshot.OpenCode
	}
	first := fetch()
	if first.Active == nil || !*first.Active || first.FiveHour == nil {
		t.Fatal("zero usage must still count as active")
	}
	now = now.Add(time.Minute + time.Second)
	state = "failed"
	stale := fetch()
	if !stale.Stale || stale.FiveHour == nil || stale.UpdatedAt != first.UpdatedAt {
		t.Fatal("transient error lost last reading")
	}
	now = now.Add(time.Minute + time.Second)
	state = "inactive"
	inactive := fetch()
	if inactive.Active == nil || *inactive.Active || inactive.FiveHour != nil || inactive.Stale {
		t.Fatal("ended plan retained cached quota")
	}
}
