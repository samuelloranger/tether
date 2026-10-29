package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const wfTestSession = "11111111-2222-3333-4444-555555555555"

func wfJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b) + "\n"
}

func wfLaunchLine(t *testing.T, ts, toolID, runID, summary string) string {
	text := "Workflow launched in background. Task ID: t1\nSummary: " + summary + "\nTranscript dir: /x/subagents/workflows/" + runID + "\nRun ID: " + runID + "\nTo resume: ..."
	return wfJSON(t, map[string]any{
		"type": "user", "timestamp": ts,
		"message": map[string]any{"content": []any{map[string]any{"type": "tool_result", "tool_use_id": toolID, "content": text}}},
	})
}

func wfNoteLine(t *testing.T, typ, ts, toolID, status, summary string) string {
	text := "<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>" + toolID + "</tool-use-id>\n<status>" + status + "</status>\n<summary>" + summary + "</summary>\n<result>" + strings.Repeat("x", 5000) + "</result>\n</task-notification>"
	if typ == "user" {
		return wfJSON(t, map[string]any{"type": "user", "timestamp": ts, "message": map[string]any{"content": text}})
	}
	return wfJSON(t, map[string]any{"type": typ, "operation": "enqueue", "timestamp": ts, "content": text})
}

func wfWrite(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func wfAgentFile(t *testing.T, dir, id string, lines ...string) {
	wfWrite(t, filepath.Join(dir, "agent-"+id+".jsonl"), strings.Join(lines, ""))
}

func wfFixture(t *testing.T) string {
	cfg := t.TempDir()
	proj := filepath.Join(cfg, "projects", "-some-project")
	sess := filepath.Join(proj, wfTestSession)

	transcript := wfLaunchLine(t, "2026-01-01T10:00:00.000Z", "toolu_A", "wf_aaaa-111", "first run") +
		wfJSON(t, map[string]any{"type": "assistant", "message": map[string]any{"content": "Run ID: wf_decoy-000 text"}}) +
		wfLaunchLine(t, "2026-01-01T10:05:00.000Z", "toolu_B", "wf_bbbb-222", "second run") +
		wfLaunchLine(t, "2026-01-01T10:06:00.000Z", "toolu_C", "wf_cccc-333", "third run") +
		wfNoteLine(t, "queue-operation", "2026-01-01T10:20:00.000Z", "toolu_A", "completed", "first run finished") +
		wfNoteLine(t, "user", "2026-01-01T10:20:01.000Z", "toolu_A", "completed", "first run finished") +
		wfNoteLine(t, "queue-operation", "2026-01-01T10:30:00.000Z", "toolu_C", "failed", "third run broke")
	wfWrite(t, filepath.Join(proj, wfTestSession+".jsonl"), transcript)

	wfWrite(t, filepath.Join(sess, "workflows", "scripts", "demo-wf_aaaa-111.js"), `export const meta = {
  name: 'demo-flow',
  description: 'Does the \'demo\' thing',
  phases: [
    { title: 'Plan', detail: 'think [first]' },
    { title: "Build" },
    { title: 'Ship' },
  ],
}
export default async function run() {}
`)

	dirA := filepath.Join(sess, "subagents", "workflows", "wf_aaaa-111")
	wfWrite(t, filepath.Join(dirA, "journal.jsonl"),
		`{"type":"launched"}`+"\n"+
			`{"type":"started","key":"k1","agentId":"a1","label":"planner","phase":"Plan"}`+"\n"+
			`{"type":"result","key":"k1","agentId":"a1","result":"`+strings.Repeat("y", 3000)+`"}`+"\n"+
			`{"type":"started","key":"k2","agentId":"a2","label":"builder","phase":"Build"}`+"\n"+
			`{"type":"started","key":"k3","agentId":"a3","label":"extra","phase":"Surprise"}`+"\n")
	wfAgentFile(t, dirA, "a1",
		wfJSON(t, map[string]any{"type": "user", "timestamp": "2026-01-01T10:00:10.000Z"}),
		wfJSON(t, map[string]any{"type": "assistant", "timestamp": "2026-01-01T10:02:00.000Z"}))
	wfAgentFile(t, dirA, "a2",
		wfJSON(t, map[string]any{"type": "user", "timestamp": "2026-01-01T10:03:00.000Z"}),
		wfJSON(t, map[string]any{"type": "assistant", "timestamp": "2026-01-01T10:04:00.000Z", "message": map[string]any{"content": []any{
			map[string]any{"type": "text", "text": "ok"},
			map[string]any{"type": "tool_use", "name": "Bash", "input": map[string]any{"command": "go   test\n./..."}},
		}}}),
		wfJSON(t, map[string]any{"type": "user", "timestamp": "2026-01-01T10:04:30.000Z"}))

	dirB := filepath.Join(sess, "subagents", "workflows", "wf_bbbb-222")
	wfWrite(t, filepath.Join(dirB, "journal.jsonl"), `{"type":"launched"}`+"\n")
	return cfg
}

func TestWorkflowRunsFromSessionFiles(t *testing.T) {
	cfg := wfFixture(t)
	runs := readWorkflowRuns(cfg, wfTestSession)
	if len(runs) != 3 {
		t.Fatalf("runs = %d, want 3: %+v", len(runs), runs)
	}
	a := runs[0]
	if a.ToolCallID != "toolu_A" || a.RunID != "wf_aaaa-111" || a.Title != "demo-flow" || a.Description != "Does the 'demo' thing" {
		t.Fatalf("run A header: %+v", a)
	}
	if a.Status != "completed" || a.Summary != "first run finished" || a.EndedAt-a.StartedAt != 20*60 {
		t.Fatalf("run A end: %+v", a)
	}
	var titles []string
	for _, p := range a.Phases {
		titles = append(titles, p.Title)
	}
	if strings.Join(titles, ",") != "Plan,Build,Ship,Surprise" {
		t.Fatalf("phases = %v", titles)
	}
	if a.Agents != (wfCounts{Total: 3, Running: 2, Done: 1}) {
		t.Fatalf("counts = %+v", a.Agents)
	}
	plan := a.Phases[0].Agents[0]
	if plan.Label != "planner" || plan.State != "done" || plan.EndedAt-plan.StartedAt != 110 {
		t.Fatalf("planner = %+v", plan)
	}
	if len(a.Phases[2].Agents) != 0 {
		t.Fatalf("Ship should have no agents: %+v", a.Phases[2])
	}
	// A finished run does not report live activity even when an agent never wrote a result.
	if got := a.Phases[1].Agents[0].Activity; got != "" {
		t.Fatalf("activity on an ended run = %q", got)
	}

	b := runs[1]
	if b.Status != "running" || b.Title != "Workflow" || b.Description != "second run" || b.EndedAt != 0 || len(b.Phases) != 0 {
		t.Fatalf("run B: %+v", b)
	}
	if c := runs[2]; c.Status != "failed" || c.Summary != "third run broke" {
		t.Fatalf("run C: %+v", c)
	}
}

func TestWorkflowRunningAgentActivity(t *testing.T) {
	cfg := wfFixture(t)
	// Drop run A's notification so it is still running.
	path := filepath.Join(cfg, "projects", "-some-project", wfTestSession+".jsonl")
	raw, _ := os.ReadFile(path)
	var kept []string
	for _, l := range strings.Split(string(raw), "\n") {
		if !(strings.Contains(l, "task-notification") && strings.Contains(l, "toolu_A")) {
			kept = append(kept, l)
		}
	}
	wfWrite(t, path, strings.Join(kept, "\n"))
	a := readWorkflowRuns(cfg, wfTestSession)[0]
	if a.Status != "running" || a.EndedAt != 0 {
		t.Fatalf("run A: %+v", a)
	}
	builder := a.Phases[1].Agents[0]
	if builder.State != "running" || builder.Activity != "Bash: go test ./..." || builder.StartedAt == 0 {
		t.Fatalf("builder = %+v", builder)
	}
}

func TestWorkflowMissingSessionIsEmpty(t *testing.T) {
	cfg := t.TempDir()
	var out bytes.Buffer
	t.Setenv("CLAUDE_CONFIG_DIR", cfg)
	if err := acpWorkflows([]string{"--session", "nope", "--json"}, &out); err != nil || out.Len() != 0 {
		t.Fatalf("err=%v out=%q", err, out.String())
	}
	if err := acpWorkflows([]string{"--session", "../etc"}, &out); err == nil {
		t.Fatal("a path-like session id must be refused")
	}
	if err := acpWorkflows(nil, &out); err == nil {
		t.Fatal("--session is required")
	}
}

func TestWorkflowOutputIsOneJSONLinePerRun(t *testing.T) {
	cfg := wfFixture(t)
	t.Setenv("CLAUDE_CONFIG_DIR", cfg)
	var out bytes.Buffer
	if err := acpWorkflows([]string{"--session", wfTestSession, "--json"}, &out); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("lines = %d", len(lines))
	}
	var r wfRun
	if err := json.Unmarshal([]byte(lines[0]), &r); err != nil || r.ToolCallID != "toolu_A" {
		t.Fatalf("line 0: %v %+v", err, r)
	}
}

func TestWorkflowTranscriptMissingFilesTolerated(t *testing.T) {
	cfg := t.TempDir()
	wfWrite(t, filepath.Join(cfg, "projects", "p", wfTestSession+".jsonl"),
		wfLaunchLine(t, "2026-01-01T10:00:00.000Z", "toolu_A", "wf_zzzz-999", "lonely")+"not json\n")
	runs := readWorkflowRuns(cfg, wfTestSession)
	if len(runs) != 1 || runs[0].Status != "running" || runs[0].Phases == nil {
		t.Fatalf("runs = %+v", runs)
	}
}
