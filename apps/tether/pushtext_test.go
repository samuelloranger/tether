package main

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestPlainLine(t *testing.T) {
	for in, want := range map[string]string{
		"## Summary\n\nAll **tests** pass.":            "Summary All tests pass.",
		"> quoted\n- item one\n- item two":             "quoted - item one - item two",
		"See [the PR](https://x.test/1) and `go vet`.": "See the PR and go vet.",
		"PR #376 renamed my_file.py; a -> b":           "PR #376 renamed my_file.py; a -> b",
		"Fixed __init__ and a__b, see issue # 5":       "Fixed __init__ and a__b, see issue # 5",
		"  \t ":                                        "",
	} {
		if got := plainLine(in); got != want {
			t.Errorf("plainLine(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPushTextRepairsAndClips(t *testing.T) {
	cut := "café"[:4] // a hook cut through the é
	if got := pushText(" "+cut+" ", 10); got != "caf" {
		t.Fatalf("got %q", got)
	}
	got := pushText(strings.Repeat("é", 300), pushBodyLimit)
	if !utf8.ValidString(got) || utf8.RuneCountInString(got) != pushBodyLimit || !strings.HasSuffix(got, "…") {
		t.Fatalf("got %d runes %q", utf8.RuneCountInString(got), got)
	}
}

func TestTitleNames(t *testing.T) {
	for _, c := range []struct {
		title, sub string
		want       bool
	}{
		{"tether · done", "tether", true},
		{"tether", "tether", true},
		{"tether-notif · done", "tether", false},
		{"Fix the bug · needs you", "tether", false},
		{"tether · done", "", false},
	} {
		if got := titleNames(c.title, c.sub); got != c.want {
			t.Errorf("titleNames(%q, %q) = %v", c.title, c.sub, got)
		}
	}
}

func TestPermissionBody(t *testing.T) {
	long := "O=/tmp/x/" + strings.Repeat("a", 200) + " && grim \"$O\""
	for _, c := range []struct {
		name string
		req  acpRequest
		want string
	}{
		{"command with description", acpRequest{Kind: "execute", Title: "npm  test\n--watch", Description: "Run the tests"}, "Run: Run the tests\n$ npm test --watch"},
		{"command alone", acpRequest{Kind: "execute", Title: "ls -la"}, "Run: ls -la?"},
		{"description alone", acpRequest{Kind: "execute", Description: "Take a screenshot"}, "Run: Take a screenshot?"},
		{"edit", acpRequest{Kind: "edit", Title: "Write out.txt"}, "Allow: Write out.txt?"},
		{"mcp tool", acpRequest{Kind: "other", Title: "mcp__glim__present"}, "Allow: glim: present?"},
		{"plan", acpRequest{Kind: "switch_mode", Title: "Approve Plan"}, "Approve the plan?"},
		{"nothing", acpRequest{}, "Allow: a tool?"},
	} {
		if got := permissionBody(&c.req); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
	got := permissionBody(&acpRequest{Kind: "execute", Title: long, Description: "Screenshot the desktop"})
	if !strings.HasPrefix(got, "Run: Screenshot the desktop\n$ O=/tmp/x/") || utf8.RuneCountInString(got) > pushBodyLimit {
		t.Fatalf("long command: %q", got)
	}
}

func TestStopNote(t *testing.T) {
	if stopNote("max_tokens") != "Stopped at the output token limit" || stopNote("weird") != "Stopped (weird)" {
		t.Fatal(stopNote("max_tokens"), stopNote("weird"))
	}
}

func TestToolLabel(t *testing.T) {
	for in, want := range map[string]string{"mcp__glim__present": "glim: present", "mcp__a__b__c": "a: b__c", "mcp__": "mcp__", "Bash": "Bash"} {
		if got := toolLabel(in); got != want {
			t.Errorf("toolLabel(%q) = %q", in, got)
		}
	}
}

// The subtitle only shows when it adds something, and a separate thread groups the push
// without being shown.
func TestSendPushSubtitleAndThread(t *testing.T) {
	acpEnv(t)
	fr := newFakeRelay(t, 200)
	if err := sendPush(PushContent{Title: "tether · done", Body: "ok", Session: "tether"}, "c", false); err != nil {
		t.Fatal(err)
	}
	if err := sendPush(PushContent{Title: "Fix it · done", Body: "ok", Session: "tether", Thread: "chat-1"}, "c", false); err != nil {
		t.Fatal(err)
	}
	got := fr.waitPushes(t, 2)
	if got[0].Session != "" || fr.reqs[0].ThreadKey != threadKey("box", "tether") {
		t.Fatalf("named twice: %+v %+v", got[0], fr.reqs[0])
	}
	if got[1].Session != "tether" || fr.reqs[1].ThreadKey != threadKey("box", "chat-1") {
		t.Fatalf("thread: %+v %+v", got[1], fr.reqs[1])
	}
}
