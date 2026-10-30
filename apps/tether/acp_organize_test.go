package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestACPOrganizationSurvivesDaemonStateAndMergesPatches(t *testing.T) {
	acpEnv(t)
	writeEnded(t, "chat", time.Now().Unix(), 0)
	var out bytes.Buffer
	if err := acpOrganize([]string{"chat", "--json", `{"pinned":true,"title":"My title"}`}, &out); err != nil {
		t.Fatal(err)
	}
	// A stream title update must never overwrite the user's sidecar metadata.
	m, _ := readACPMeta("chat")
	m.Title = "Agent title"
	if err := writeACPMeta(m); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for _, patch := range []string{`{"archived":true}`, `{"title":"User renamed it"}`} {
		wg.Add(1)
		go func(patch string) {
			defer wg.Done()
			if err := acpOrganize([]string{"chat", "--json", patch}, &bytes.Buffer{}); err != nil {
				t.Error(err)
			}
		}(patch)
	}
	wg.Wait()
	l, err := acpStatusOf("chat")
	if err != nil || !l.Pinned || !l.Archived || l.CustomTitle != "User renamed it" || l.Title != "Agent title" {
		t.Fatalf("%+v %v", l, err)
	}
	st, err := os.Stat(acpOrganizationPath("chat"))
	if err != nil || st.Mode().Perm() != 0600 {
		t.Fatalf("private metadata: %v %v", st, err)
	}
}

func TestACPOrganizationCanPrepareBranchBeforeSpawn(t *testing.T) {
	acpEnv(t)
	var out bytes.Buffer
	err := acpOrganize([]string{"child", "--json", `{"title":"Alternative","parent":{"name":"original","title":"Original","method":"copy"}}`}, &out)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(acpDir("child")); !os.IsNotExist(err) {
		t.Fatalf("organization created a holder: %v", err)
	}
	writeEnded(t, "child", time.Now().Unix(), 0)
	l, err := acpStatusOf("child")
	if err != nil || l.CustomTitle != "Alternative" || l.Parent == nil || l.Parent.Name != "original" {
		t.Fatalf("%+v %v", l, err)
	}
}

func TestACPArchiveAndPinPreventRetentionWithoutChangingAgent(t *testing.T) {
	acpEnv(t)
	t.Setenv("TETHER_ACP_KEEP_ENDED", "1h")
	for _, name := range []string{"archive", "pin", "ordinary"} {
		writeEnded(t, name, time.Now().Add(-48*time.Hour).Unix(), 0)
	}
	for name, patch := range map[string]string{"archive": `{"archived":true}`, "pin": `{"pinned":true}`} {
		if err := acpOrganize([]string{name, "--json", patch}, &bytes.Buffer{}); err != nil {
			t.Fatal(err)
		}
	}
	pruneEnded("")
	if !exists("archive") || !exists("pin") || exists("ordinary") {
		t.Fatal("retention ignored explicit organization")
	}
	if err := acpOrganize([]string{"archive", "--json", `{"archived":false}`}, &bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	pruneEnded("")
	if exists("archive") {
		t.Fatal("unarchived old chat should follow normal retention")
	}
}

func TestACPOrganizationValidatesPatchesAndNames(t *testing.T) {
	acpEnv(t)
	for _, args := range [][]string{
		{"../escape", "--json", `{}`}, {"c", "--json", `null`}, {"c", "--json", `{"unknown":true}`},
		{"c", "--json", `{} {}`}, {"c", "--json", `{"title":"a\nb"}`}, {"c", "--json", `{"pinned":"yes"}`},
		{"c", "--json", `{"parent":{"name":"c","title":"self","method":"copy"}}`},
		{"c", "--json", `{"parent":{"name":"p","title":"parent","method":"native"}}`},
		{"gone", "--json", `{"archived":true}`},
	} {
		if err := acpOrganize(args, &bytes.Buffer{}); err == nil {
			t.Errorf("accepted %q", args)
		}
	}
}

func TestACPProjectRootFindsRepositoryAndWorktreeMarkers(t *testing.T) {
	for _, isDir := range []bool{true, false} {
		root := t.TempDir()
		sub := filepath.Join(root, "clients", "ios")
		if err := os.MkdirAll(sub, 0700); err != nil {
			t.Fatal(err)
		}
		if isDir {
			if err := os.Mkdir(filepath.Join(root, ".git"), 0700); err != nil {
				t.Fatal(err)
			}
		} else {
			if err := os.WriteFile(filepath.Join(root, ".git"), []byte("gitdir: /other/.git/worktrees/test"), 0600); err != nil {
				t.Fatal(err)
			}
		}
		if got := acpProjectRoot(sub); got != root {
			t.Fatalf("root %q want %q", got, root)
		}
	}
	var decoded acpOrganization
	if err := json.Unmarshal([]byte(`{}`), &decoded); err != nil || decoded.Pinned || decoded.Archived {
		t.Fatal("old metadata defaults changed")
	}
}
