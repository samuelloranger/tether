package main

import (
	"strings"
	"testing"
	"time"
)

func TestCopilotLegacyPremiumAllowanceAndReset(t *testing.T) {
	out, err := parseCopilotPlanUsage([]byte(`{"copilot_plan":"individual","quota_reset_date":"2026-12-01","quota_snapshots":{"premium_interactions":{"entitlement":300,"remaining":90,"percent_remaining":30}}}`))
	if err != nil || out.Active == nil || !*out.Active || out.MonthlyMeter == nil {
		t.Fatalf("%+v %v", out, err)
	}
	m := out.MonthlyMeter
	if m.Used == nil || *m.Used != 210 || m.Limit == nil || *m.Limit != 300 || m.Unit != "requests" {
		t.Fatalf("incorrect premium allowance: %+v", m)
	}
	reset, _ := time.Parse("2006-01-02", "2026-12-01")
	if m.ResetsAt != reset.Unix() {
		t.Fatal("incorrect reset date")
	}
	if out.FiveHour != nil || out.Weekly != nil {
		t.Fatal("invented 5-hour/weekly limits")
	}
}

func TestCopilotCreditBillingNeverTreatsRequestPlaceholdersAsQuota(t *testing.T) {
	out, err := parseCopilotPlanUsage([]byte(`{"copilot_plan":"individual","token_based_billing":true,"quota_reset_date_utc":"2026-12-01T00:00:00.000Z","quota_snapshots":{"premium_interactions":{"entitlement":0,"remaining":0,"percent_remaining":0,"has_quota":false,"credits_used":0,"token_based_billing":true},"chat":{"entitlement":200,"percent_remaining":100,"credits_used":0}}}`))
	if err != nil || out.MonthlyMeter == nil {
		t.Fatal(err)
	}
	m := out.MonthlyMeter
	if m.Unit != "credits" || m.Used == nil || *m.Used != 0 || m.Limit != nil || m.Unlimited {
		t.Fatalf("invented credit ceiling/exhaustion: %+v", m)
	}
	if m.ResetsAt <= 0 {
		t.Fatal("lost authoritative reset")
	}
	missing, err := parseCopilotPlanUsage([]byte(`{"copilot_plan":"business","token_based_billing":true,"quota_snapshots":{"premium_interactions":{"entitlement":0,"percent_remaining":0}}}`))
	if err != nil || missing.MonthlyMeter.Used != nil {
		t.Fatal("missing credits became zero")
	}
}

func TestCopilotInactiveUnlimitedAndUnavailableStates(t *testing.T) {
	for _, raw := range []string{`{"copilot_plan":"free"}`, `{"access_type_sku":"free_limited_copilot","copilot_plan":"individual"}`, `{"access_type_sku":"subscription_ended","copilot_plan":"individual"}`} {
		out, err := parseCopilotPlanUsage([]byte(raw))
		if err != nil || out.Active == nil || *out.Active || out.MonthlyMeter != nil {
			t.Fatalf("inactive plan displayed: %+v %v", out, err)
		}
	}
	out, err := parseCopilotPlanUsage([]byte(`{"copilot_plan":"enterprise","quota_snapshots":{"premium_interactions":{"entitlement":-1,"unlimited":true}}}`))
	if err != nil || out.MonthlyMeter == nil || !out.MonthlyMeter.Unlimited || out.MonthlyMeter.Used != nil || out.MonthlyMeter.Limit != nil {
		t.Fatal("unlimited plan became 0%", err)
	}
	for _, raw := range []string{`{}`, `{"message":"token-must-not-leak"}`, `not json`} {
		_, err := parseCopilotPlanUsage([]byte(raw))
		if err == nil || strings.Contains(err.Error(), "token-must-not-leak") {
			t.Fatal("accepted missing status or exposed raw response")
		}
	}
}
