package main

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestACPProjectsSeedAddRemove(t *testing.T) {
	acpEnv(t)
	t.Setenv("TETHER_ACP_KEEP_ENDED", "1h")
	writeEnded(t, "live", time.Now().Unix(), 0)
	writeEnded(t, "old", time.Now().Unix(), 0)
	m, _ := readACPMeta("old")
	m.Cwd = "/archived"
	if err := writeACPMeta(m); err != nil {
		t.Fatal(err)
	}
	if err := acpOrganize([]string{"old", "--json", `{"archived":true}`}, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	if err := acpProjects(nil, &out); err != nil || out.String() != "{\"path\":\"/w\"}\n" {
		t.Fatalf("seed: %q %v", out.String(), err)
	}
	out.Reset()
	if err := acpProjects([]string{"add", "/a/b/"}, &out); err != nil || out.String() != "{\"path\":\"/a/b\"}\n{\"path\":\"/w\"}\n" {
		t.Fatalf("add: %q %v", out.String(), err)
	}
	out.Reset()
	if err := acpProjects([]string{"remove", "/w"}, &out); err != nil || out.String() != "{\"path\":\"/a/b\"}\n" {
		t.Fatalf("remove: %q %v", out.String(), err)
	}
	// Removing every project must not re-seed from the chats.
	_ = acpProjects([]string{"remove", "/a/b"}, &bytes.Buffer{})
	out.Reset()
	if err := acpProjects(nil, &out); err != nil || out.Len() != 0 {
		t.Fatalf("after removing all: %q %v", out.String(), err)
	}
}

func TestACPProjectsRejectsBadPaths(t *testing.T) {
	acpEnv(t)
	for _, args := range [][]string{{"add", "relative"}, {"add", "/a\nb"}, {"remove"}, {"bogus", "/a"}} {
		if err := acpProjects(args, &bytes.Buffer{}); err == nil {
			t.Fatalf("%q accepted", args)
		}
	}
}

func TestRememberACPProjectUsesTheGitRoot(t *testing.T) {
	acpEnv(t)
	rememberACPProject(t.TempDir())
	rememberACPProject("relative")
	var out bytes.Buffer
	if err := acpProjects(nil, &out); err != nil || strings.Count(out.String(), "\n") != 1 {
		t.Fatalf("%q %v", out.String(), err)
	}
}
