package main

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func wfProject(cfg string) string { return filepath.Join(cfg, "projects", "-some-project") }

func TestWorkflowDuplicateStartedAfterResultStaysDone(t *testing.T) {
	cfg := wfFixture(t)
	dir := filepath.Join(wfProject(cfg), wfTestSession, "subagents", "workflows", "wf_aaaa-111")
	f, err := os.OpenFile(filepath.Join(dir, "journal.jsonl"), os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString(`{"type":"started","key":"k1","agentId":"a1","label":"planner","phase":"Plan"}` + "\n")
	f.Close()
	a := readWorkflowRuns(cfg, wfTestSession)[0]
	if got := a.Phases[0].Agents; len(got) != 1 || got[0].State != "done" {
		t.Fatalf("planner = %+v", got)
	}
}

func TestWorkflowLastActivityIsTheNewestWriteAndNoNotificationMeansRunning(t *testing.T) {
	cfg := wfFixture(t)
	dir := filepath.Join(wfProject(cfg), wfTestSession, "subagents", "workflows", "wf_aaaa-111")
	old := time.Unix(1_700_000_000, 0)
	for _, name := range []string{"journal.jsonl", "agent-a1.jsonl", "agent-a2.jsonl"} {
		if err := os.Chtimes(filepath.Join(dir, name), old, old); err != nil {
			t.Fatal(err)
		}
	}
	newest := time.Unix(1_700_000_500, 0)
	if err := os.Chtimes(filepath.Join(dir, "agent-a2.jsonl"), newest, newest); err != nil {
		t.Fatal(err)
	}
	runs := readWorkflowRuns(cfg, wfTestSession)
	if runs[0].LastActivityAt != newest.Unix() {
		t.Fatalf("lastActivityAt = %d", runs[0].LastActivityAt)
	}
	// Run B has no notification and is reported running however quiet it is.
	if runs[1].Status != "running" || runs[1].EndedAt != 0 {
		t.Fatalf("run B = %+v", runs[1])
	}
}

func TestWorkflowScanIsIncremental(t *testing.T) {
	cfg := wfFixture(t)
	path := filepath.Join(wfProject(cfg), wfTestSession+".jsonl")
	readWorkflowRuns(cfg, wfTestSession)
	st, _ := os.Stat(path)
	c := loadWfCache(wfTestSession)
	if c == nil || c.Offset != st.Size() {
		t.Fatalf("cache after the first read = %+v (size %d)", c, st.Size())
	}

	// The next call trusts the cache for what it already scanned: a planted ending shows up
	// without the file being read again.
	c.Notes["toolu_B"] = wfNote{Status: "killed", Summary: "planted", At: 1}
	saveWfCache(wfTestSession, c)
	if got := readWorkflowRuns(cfg, wfTestSession)[1]; got.Status != "killed" {
		t.Fatalf("run B = %+v", got)
	}

	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	_, _ = f.WriteString(wfLaunchLine(t, "2026-01-01T11:00:00.000Z", "toolu_D", "wf_dddd-444", "fourth run"))
	_, _ = f.WriteString(wfNoteLine(t, "queue-operation", "2026-01-01T11:10:00.000Z", "toolu_D", "completed", "fourth done"))
	f.Close()
	runs := readWorkflowRuns(cfg, wfTestSession)
	if len(runs) != 4 || runs[3].Status != "completed" || runs[3].Summary != "fourth done" {
		t.Fatalf("runs = %+v", runs)
	}
	st, _ = os.Stat(path)
	if c := loadWfCache(wfTestSession); c.Offset != st.Size() {
		t.Fatalf("offset = %d, size %d", c.Offset, st.Size())
	}
}

func TestWorkflowPartialLastLineWaitsForItsNewline(t *testing.T) {
	cfg := wfFixture(t)
	path := filepath.Join(wfProject(cfg), wfTestSession+".jsonl")
	line := wfLaunchLine(t, "2026-01-01T11:00:00.000Z", "toolu_D", "wf_dddd-444", "fourth run")
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	_, _ = f.WriteString(line[:len(line)/2])
	f.Close()
	if runs := readWorkflowRuns(cfg, wfTestSession); len(runs) != 3 {
		t.Fatalf("runs = %d", len(runs))
	}
	f, _ = os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	_, _ = f.WriteString(line[len(line)/2:])
	f.Close()
	if runs := readWorkflowRuns(cfg, wfTestSession); len(runs) != 4 {
		t.Fatalf("runs after the line completed = %d", len(runs))
	}
}

func TestWorkflowScanRestartsWhenTheTranscriptShrinksOrIsReplaced(t *testing.T) {
	cfg := wfFixture(t)
	path := filepath.Join(wfProject(cfg), wfTestSession+".jsonl")
	if runs := readWorkflowRuns(cfg, wfTestSession); len(runs) != 3 {
		t.Fatalf("runs = %d", len(runs))
	}

	wfWrite(t, path, wfLaunchLine(t, "2026-01-01T10:00:00.000Z", "toolu_A", "wf_aaaa-111", "first run"))
	runs := readWorkflowRuns(cfg, wfTestSession)
	if len(runs) != 1 || runs[0].Status != "running" {
		t.Fatalf("after truncation: %+v", runs)
	}

	replacement := wfLaunchLine(t, "2026-02-01T10:00:00.000Z", "toolu_X", "wf_xxxx-777", "other") +
		wfNoteLine(t, "queue-operation", "2026-02-01T10:05:00.000Z", "toolu_X", "failed", "broke") +
		wfLaunchLine(t, "2026-02-01T10:06:00.000Z", "toolu_Y", "wf_yyyy-888", "next")
	tmp := path + ".new"
	wfWrite(t, tmp, replacement)
	if err := os.Rename(tmp, path); err != nil {
		t.Fatal(err)
	}
	runs = readWorkflowRuns(cfg, wfTestSession)
	if len(runs) != 2 || runs[0].ToolCallID != "toolu_X" || runs[0].Status != "failed" || runs[1].ToolCallID != "toolu_Y" {
		t.Fatalf("after replacement: %+v", runs)
	}

	// Rewritten in place with the same size: the head check catches it.
	wfWrite(t, path, strings.Replace(replacement, "toolu_X", "toolu_Z", 2))
	runs = readWorkflowRuns(cfg, wfTestSession)
	if len(runs) != 2 || runs[0].ToolCallID != "toolu_Z" {
		t.Fatalf("after rewrite: %+v", runs)
	}
}

func TestWorkflowHugeLinesAreNeverHeldWhole(t *testing.T) {
	wfEnv(t)
	oldMax, oldPrefix := wfMaxLine, wfPrefixBytes
	wfMaxLine, wfPrefixBytes = 2000, 1500
	t.Cleanup(func() { wfMaxLine, wfPrefixBytes = oldMax, oldPrefix })

	cfg := t.TempDir()
	note := `{"type":"queue-operation","operation":"enqueue","timestamp":"2026-01-01T10:20:00.000Z","sessionId":"s","content":"<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>toolu_A</tool-use-id>\n<status>failed</status>\n<summary>ended badly</summary>\n<result>` +
		strings.Repeat("x", 3<<20) + `</result>\n</task-notification>"}` + "\n"
	unrelated := wfJSON(t, map[string]any{"type": "assistant", "message": map[string]any{"content": strings.Repeat("z", 3<<20)}})
	transcript := wfLaunchLine(t, "2026-01-01T10:00:00.000Z", "toolu_A", "wf_aaaa-111", "first run") +
		unrelated + note + wfLaunchLine(t, "2026-01-01T10:30:00.000Z", "toolu_B", "wf_bbbb-222", "after the huge lines")
	wfWrite(t, filepath.Join(cfg, "projects", "p", wfTestSession+".jsonl"), transcript)
	runs := readWorkflowRuns(cfg, wfTestSession)
	if len(runs) != 2 {
		t.Fatalf("runs = %+v", runs)
	}
	if runs[0].Status != "failed" || runs[0].Summary != "ended badly" || runs[0].EndedAt != parseTS("2026-01-01T10:20:00.000Z") {
		t.Fatalf("run A = %+v", runs[0])
	}
	if runs[1].Status != "running" {
		t.Fatalf("run B = %+v", runs[1])
	}
}

func TestReadBoundedLineKeepsOnlyAPrefixOfALongLine(t *testing.T) {
	data := strings.Repeat("a", 10000) + "\nshort\npartial"
	r := bufio.NewReaderSize(strings.NewReader(data), 16)
	line, long, complete, n, _ := readBoundedLine(r, 100, 20)
	if !long || !complete || len(line) != 20 || n != 10001 {
		t.Fatalf("long line: %d %v %v %d", len(line), long, complete, n)
	}
	line, long, complete, n, _ = readBoundedLine(r, 100, 20)
	if long || !complete || string(line) != "short\n" || n != 6 {
		t.Fatalf("short line: %q %v %v %d", line, long, complete, n)
	}
	line, _, complete, n, _ = readBoundedLine(r, 100, 20)
	if complete || string(line) != "partial" || n != 7 {
		t.Fatalf("partial line: %q %v %d", line, complete, n)
	}
}

func TestWorkflowTailThatIsOnePartialLineGivesNothing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent-x.jsonl")
	wfWrite(t, path, `{"type":"assistant","timestamp":"2026-01-01T10:00:00.000Z","pad":"`+strings.Repeat("p", wfTailBytes*2))
	if activity, last := tailInfo(path); activity != "" || last != "" {
		t.Fatalf("tail = %q %q", activity, last)
	}
	wfWrite(t, path, wfJSON(t, map[string]any{"type": "assistant", "timestamp": "2026-01-01T10:00:00.000Z", "message": map[string]any{"content": []any{
		map[string]any{"type": "tool_use", "name": "Read", "input": map[string]any{"file_path": "a/b.go"}}}}}))
	if activity, last := tailInfo(path); activity != "Read: a/b.go" || last == "" {
		t.Fatalf("tail = %q %q", activity, last)
	}
}

func TestWorkflowTheNewestTranscriptWinsWhenTheSessionIsInTwoProjects(t *testing.T) {
	wfEnv(t)
	cfg := t.TempDir()
	older := filepath.Join(cfg, "projects", "-a", wfTestSession+".jsonl")
	newer := filepath.Join(cfg, "projects", "-b", wfTestSession+".jsonl")
	wfWrite(t, older, wfLaunchLine(t, "2026-01-01T10:00:00.000Z", "toolu_OLD", "wf_old-1", "old"))
	wfWrite(t, newer, wfLaunchLine(t, "2026-01-02T10:00:00.000Z", "toolu_NEW", "wf_new-1", "new"))
	past := time.Now().Add(-time.Hour)
	if err := os.Chtimes(older, past, past); err != nil {
		t.Fatal(err)
	}
	runs := readWorkflowRuns(cfg, wfTestSession)
	if len(runs) != 1 || runs[0].ToolCallID != "toolu_NEW" {
		t.Fatalf("runs = %+v", runs)
	}
	if got := readWorkflowRuns(filepath.Join(cfg, "nope"), wfTestSession); len(got) != 0 {
		t.Fatalf("got %+v", got)
	}
}

func TestWorkflowMetaEscapes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s-wf_x.js")
	wfWrite(t, path, "export const meta = {\n  name: 'it\\'s a\\nname',\n  description: \"say \\\"hi\\\"\\tnow \\u00e9\",\n  phases: [\n    { title: 'One\\ntwo' },\n  ],\n}\n")
	name, desc, phases := parseWorkflowMeta(path)
	if name != "it's a\nname" || desc != "say \"hi\"\tnow \u00e9" || len(phases) != 1 || phases[0] != "One\ntwo" {
		t.Fatalf("%q %q %q", name, desc, phases)
	}
	if got := unescapeJS(`a\xZZ\u12`); got != `axZZu12` {
		t.Fatalf("lenient escapes: %q", got)
	}
}
