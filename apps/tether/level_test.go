package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPushLevelTiersByCategory(t *testing.T) {
	for category, want := range map[string]string{
		"tether.agent.waiting":  levelUrgent,
		"tether.agent.question": levelUrgent,
		"tether.agent.done":     levelQuiet,
		"":                      levelNormal,
		"something.else":        levelNormal,
	} {
		if got := pushLevel(category); got != want {
			t.Errorf("pushLevel(%q) = %q, want %q", category, got, want)
		}
	}
}

func TestThreadKeyIsStableOpaqueAndPerSession(t *testing.T) {
	a := threadKey("host", "alpha")
	if a != threadKey("host", "alpha") {
		t.Fatal("not stable")
	}
	if a == threadKey("host", "beta") || a == threadKey("other", "alpha") {
		t.Fatal("collides across session or host")
	}
	if strings.Contains(a, "alpha") || len(a) != 16 {
		t.Fatalf("key %q leaks or has wrong length", a)
	}
	if threadKey("host", "") != "" {
		t.Fatal("no session must mean no key")
	}
}

func TestRelayRequestCarriesOnlyLevelAndOpaqueKeyInCleartext(t *testing.T) {
	out, _ := json.Marshal(relayRequest{Token: "t", Ciphertext: "c", CollapseID: "x", Level: levelUrgent, ThreadKey: threadKey("h", "secret-session")})
	if strings.Contains(string(out), "secret-session") || !strings.Contains(string(out), `"level":"urgent"`) {
		t.Fatalf("body %s", out)
	}
	old, _ := json.Marshal(relayRequest{Token: "t", Ciphertext: "c", CollapseID: "x"})
	if strings.Contains(string(old), "level") || strings.Contains(string(old), "threadKey") {
		t.Fatalf("empty fields must be omitted: %s", old)
	}
}

func TestAgentCollapseIDHidesTheSessionAndSeparatesSessions(t *testing.T) {
	work := agentCollapseID("work")
	if strings.Contains(work, "work") || work != "agent-"+threadKey(hostLabel(), "work") {
		t.Fatalf("collapse id %q must be the hashed form", work)
	}
	if work == agentCollapseID("other") {
		t.Fatal("two sessions share a collapse id")
	}
}
