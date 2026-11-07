package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"os/exec"
	"strings"
	"time"
)

func readCopilotPlanUsage() (acpProviderUsage, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	return readCopilotUsageWith(func() (acpProviderUsage, error) {
		cliCtx, cliCancel := context.WithTimeout(ctx, 8*time.Second)
		defer cliCancel()
		return readCopilotCLIUsage(cliCtx, []string{"copilot", "--headless", "--no-auto-update", "--stdio"})
	}, func() (acpProviderUsage, error) { return readCopilotGHUsage(ctx) })
}

func readCopilotUsageWith(cli, gh func() (acpProviderUsage, error)) (acpProviderUsage, error) {
	usage, err := cli()
	if !errors.Is(err, errCopilotCLIUnavailable) {
		return usage, err
	}
	return gh()
}

func readCopilotGHUsage(ctx context.Context) (acpProviderUsage, error) {
	cmd := exec.CommandContext(ctx, "gh", "api", "--hostname", "github.com", "--method", "GET", "copilot_internal/user")
	cmd.Dir = os.TempDir()
	cmd.Env = append(os.Environ(), "GH_PROMPT_DISABLED=1", "GIT_TERMINAL_PROMPT=0")
	cmd.Stderr = io.Discard
	raw, err := cmd.Output()
	if err != nil {
		return acpProviderUsage{}, errors.New("copilot usage unavailable; check gh sign-in on the host")
	}
	return parseCopilotPlanUsage(raw)
}

func parseCopilotPlanUsage(raw []byte) (acpProviderUsage, error) {
	type quota struct {
		Entitlement      *float64 `json:"entitlement"`
		Remaining        *float64 `json:"remaining"`
		QuotaRemaining   *float64 `json:"quota_remaining"`
		PercentRemaining *float64 `json:"percent_remaining"`
		CreditsUsed      *float64 `json:"credits_used"`
		Unlimited        bool     `json:"unlimited"`
		Reset            int64    `json:"quota_reset_at"`
		TokenBased       bool     `json:"token_based_billing"`
	}
	var data struct {
		Plan       string `json:"copilot_plan"`
		SKU        string `json:"access_type_sku"`
		TokenBased bool   `json:"token_based_billing"`
		Reset      string `json:"quota_reset_date"`
		ResetUTC   string `json:"quota_reset_date_utc"`
		Quotas     struct {
			Premium *quota `json:"premium_interactions"`
			Chat    *quota `json:"chat"`
		} `json:"quota_snapshots"`
	}
	if json.Unmarshal(raw, &data) != nil {
		return acpProviderUsage{}, errors.New("copilot returned unreadable plan usage")
	}
	plan := strings.ToLower(data.Plan)
	if data.SKU == "subscription_ended" || data.SKU == "free_limited_copilot" || plan == "free" || plan == "none" || plan == "free_limited_copilot" {
		return inactivePlanUsage(), nil
	}
	if plan == "" {
		return acpProviderUsage{}, errors.New("copilot subscription status unavailable")
	}
	meter := &acpMonthlyMeter{Unit: "requests"}
	for _, value := range []string{data.ResetUTC, data.Reset} {
		for _, layout := range []string{time.RFC3339Nano, "2006-01-02"} {
			if at, err := time.Parse(layout, value); err == nil && at.Unix() > 0 {
				meter.ResetsAt = at.Unix()
				break
			}
		}
		if meter.ResetsAt > 0 {
			break
		}
	}
	q := data.Quotas.Premium
	if q == nil {
		q = data.Quotas.Chat
	}
	tokenBased := data.TokenBased || (q != nil && q.TokenBased)
	if tokenBased {
		meter.Unit = "credits"
	}
	valid := func(v *float64) bool { return v != nil && !math.IsNaN(*v) && !math.IsInf(*v, 0) && *v >= 0 }
	if q != nil {
		if q.Reset > 0 {
			meter.ResetsAt = q.Reset
		}
		if tokenBased {
			// Credit-billed plans can return legacy request placeholders. They are not credit ceilings.
			if valid(q.CreditsUsed) {
				meter.Used = q.CreditsUsed
			} else if data.Quotas.Chat != nil && valid(data.Quotas.Chat.CreditsUsed) {
				meter.Used = data.Quotas.Chat.CreditsUsed
			}
		} else {
			meter.Unlimited = q.Unlimited || (q.Entitlement != nil && *q.Entitlement == -1)
			if valid(q.Entitlement) && *q.Entitlement > 0 && !meter.Unlimited {
				meter.Limit = q.Entitlement
				remaining := q.Remaining
				if remaining == nil {
					remaining = q.QuotaRemaining
				}
				if valid(remaining) && *remaining <= *meter.Limit {
					used := *meter.Limit - *remaining
					meter.Used = &used
				} else if valid(q.PercentRemaining) && *q.PercentRemaining <= 100 {
					used := *meter.Limit * (1 - *q.PercentRemaining/100)
					meter.Used = &used
				}
			}
		}
	}
	active := true
	return acpProviderUsage{Active: &active, MonthlyMeter: meter}, nil
}
