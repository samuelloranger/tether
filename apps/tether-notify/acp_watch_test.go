package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeRelay struct {
	mu     sync.Mutex
	status int
	got    []PushContent
	reqs   []relayRequest
	key    string
}

func newFakeRelay(t *testing.T, status int) *fakeRelay {
	t.Helper()
	fr := &fakeRelay{status: status, key: generateSecretKeyBase64()}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req relayRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		fr.mu.Lock()
		defer fr.mu.Unlock()
		if fr.status == http.StatusOK {
			c, err := decryptPushContent(fr.key, req.Ciphertext)
			if err != nil {
				t.Errorf("decrypt: %v", err)
			}
			fr.got = append(fr.got, c)
			fr.reqs = append(fr.reqs, req)
		}
		w.WriteHeader(fr.status)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("TETHER_PUSH_RELAY_URL", srv.URL)
	if err := saveDevices([]Device{{Token: "tok", SecretKey: fr.key}}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hostLabelPath(), []byte("box"), 0o600); err != nil {
		t.Fatal(err)
	}
	return fr
}

func (fr *fakeRelay) pushes() []PushContent {
	fr.mu.Lock()
	defer fr.mu.Unlock()
	return append([]PushContent(nil), fr.got...)
}

func (fr *fakeRelay) waitPushes(t *testing.T, n int) []PushContent {
	t.Helper()
	waitFor(t, fmt.Sprintf("%d pushes", n), func() bool { return len(fr.pushes()) >= n })
	return fr.pushes()
}

// scriptedAgent runs a shell agent that logs whole stdin to in.log and prints each emit.N
// file (in order) to stdout once it appears.
type scriptedAgent struct {
	dir string
	n   int
}

func newScriptedAgent(t *testing.T) (*scriptedAgent, string) {
	dir := t.TempDir()
	script := fmt.Sprintf(`n=0; while :; do f=%[1]s/emit.$n; if [ -f $f ]; then cat $f; n=$((n+1)); else sleep 0.03; fi; done & cat >> %[1]s/in.log`, dir)
	return &scriptedAgent{dir: dir}, script
}

func (a *scriptedAgent) emit(t *testing.T, line string) {
	t.Helper()
	tmp := filepath.Join(a.dir, "tmp")
	if err := os.WriteFile(tmp, []byte(line+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, filepath.Join(a.dir, fmt.Sprintf("emit.%d", a.n))); err != nil {
		t.Fatal(err)
	}
	a.n++
}

func (a *scriptedAgent) stdin() string {
	b, _ := os.ReadFile(filepath.Join(a.dir, "in.log"))
	return string(b)
}

const permReq = `{"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{"sessionId":"s","toolCall":{"toolCallId":"t","title":"Write out.txt","kind":"edit"},"options":[{"optionId":"allow","name":"Allow","kind":"allow_once"},{"optionId":"always","name":"Always allow","kind":"allow_always"},{"optionId":"reject","name":"Reject","kind":"reject_once"}]}}`

// startDetached spawns the holder and drops the client, leaving nobody attached.
func startDetached(t *testing.T, name, script string) {
	t.Helper()
	cleanupSession(t, name)
	p := startAttach(t, name, "--spawn", script, "--cwd", t.TempDir())
	_ = p.stdin.Close()
	if code := p.exitCode(t); code != 0 {
		t.Fatalf("attach exit %d", code)
	}
	time.Sleep(250 * time.Millisecond)
}

func runAcp(t *testing.T, args ...string) (string, string, int) {
	t.Helper()
	exe, _ := os.Executable()
	cmd := exec.Command(exe, append([]string{"acp"}, args...)...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	return out.String(), errb.String(), code
}

func pendingCount(name string) int {
	return len(loadACPTracker(name).st.Requests)
}

func TestACPPermissionPushedOnceWithNoClient(t *testing.T) {
	acpEnv(t)
	fr := newFakeRelay(t, 200)
	a, script := newScriptedAgent(t)
	startDetached(t, "p", script)
	a.emit(t, `{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"session_info_update","title":"Fix the bug"}}}`)
	a.emit(t, permReq)
	got := fr.waitPushes(t, 1)
	time.Sleep(300 * time.Millisecond)
	if got = fr.pushes(); len(got) != 1 {
		t.Fatalf("want one push, got %d", len(got))
	}
	c := got[0]
	if c.Category != acpPermissionCategory || c.Level != levelUrgent || c.Body != "Allow: Write out.txt?" ||
		c.Session != "Fix the bug" || c.ACPSession != "p" || c.RequestID != "7" || c.Title != "Fix the bug · needs you" {
		t.Fatalf("payload %+v", c)
	}
	if strings.Join(c.Options, ",") != "Allow,Always allow,Reject" || strings.Join(c.OptionIDs, ",") != "allow,always,reject" ||
		strings.Join(c.OptionKinds, ",") != "allow_once,allow_always,reject_once" {
		t.Fatalf("options %+v", c)
	}
	if want := threadKey("box", "Fix the bug"); fr.reqs[0].ThreadKey != want || fr.reqs[0].Level != levelUrgent {
		t.Fatalf("relay request %+v", fr.reqs[0])
	}
	if pendingCount("p") != 1 {
		t.Fatal("request should be pending")
	}
}

func TestACPNoPushWhenClientAttached(t *testing.T) {
	acpEnv(t)
	fr := newFakeRelay(t, 200)
	a, script := newScriptedAgent(t)
	cleanupSession(t, "c")
	p := startAttach(t, "c", "--spawn", script, "--cwd", t.TempDir())
	// The daemon only counts a client once its first line is in; emitting earlier races the attach process.
	waitFor(t, "client attached", func() bool { m, err := readACPMeta("c"); return err == nil && m.Attached })
	a.emit(t, permReq)
	if l := p.readLine(t); !strings.Contains(l, "request_permission") {
		t.Fatalf("got %q", l)
	}
	time.Sleep(400 * time.Millisecond)
	if n := len(fr.pushes()); n != 0 {
		t.Fatalf("pushed %d with a client attached", n)
	}
	if pendingCount("c") != 1 {
		t.Fatal("request should still be tracked")
	}
}

func TestACPNoDuplicatePushOnReplayOrRestart(t *testing.T) {
	acpEnv(t)
	fr := newFakeRelay(t, 200)
	var pushed []PushContent
	mk := func() *acpDaemonState {
		return &acpDaemonState{tr: loadACPTracker("d"), push: func(c PushContent, _ string) error { pushed = append(pushed, c); return nil }}
	}
	_ = os.MkdirAll(acpDir("d"), 0o700)
	s := mk()
	s.scanAgent([]byte(permReq + "\n"))
	s.pushes.Wait()
	s = mk()
	s.scanAgent([]byte(permReq + "\n"))
	s.scanAgent([]byte(permReq + "\n"))
	s.pushes.Wait()
	if len(pushed) != 1 {
		t.Fatalf("pushed %d times", len(pushed))
	}
	if n := len(fr.pushes()); n != 0 {
		t.Fatal("relay should be untouched")
	}
	// Answered ids are never re-announced either.
	tr := loadACPTracker("d")
	if err := tr.answer("7", func(*acpRequest) (string, error) { return "allow", nil }); err != nil {
		t.Fatal(err)
	}
	s = mk()
	s.scanAgent([]byte(permReq + "\n"))
	s.pushes.Wait()
	if len(pushed) != 1 || len(s.tr.st.Requests) != 0 {
		t.Fatalf("answered id re-announced: %d %v", len(pushed), s.tr.st.Requests)
	}
}

func TestACPScanToleratesGarbageAndSplitChunks(t *testing.T) {
	acpEnv(t)
	_ = os.MkdirAll(acpDir("g"), 0o700)
	var pushed []PushContent
	s := &acpDaemonState{tr: loadACPTracker("g"), push: func(c PushContent, _ string) error { pushed = append(pushed, c); return nil }}
	s.scanAgent([]byte("not json\n{\"id\":\n\n"))
	half := len(permReq) / 2
	s.scanAgent([]byte(permReq[:half]))
	s.scanAgent([]byte(permReq[half:] + "\n"))
	s.pushes.Wait()
	if len(pushed) != 1 {
		t.Fatalf("pushed %d", len(pushed))
	}
}

func TestACPAnswerWritesOneWholeLineAndSecondExits3(t *testing.T) {
	acpEnv(t)
	newFakeRelay(t, 200)
	a, script := newScriptedAgent(t)
	startDetached(t, "a", script)
	a.emit(t, permReq)
	waitFor(t, "pending", func() bool { return pendingCount("a") == 1 })

	out, errs, code := runAcp(t, "answer", "a", "--request", "7", "--option", "allow")
	if code != 0 {
		t.Fatalf("exit %d %q %q", code, out, errs)
	}
	want := `{"id":7,"jsonrpc":"2.0","result":{"outcome":{"optionId":"allow","outcome":"selected"}}}` + "\n"
	waitFor(t, "agent stdin", func() bool { return a.stdin() != "" })
	if got := a.stdin(); got != want {
		t.Fatalf("agent saw %q", got)
	}
	if pendingCount("a") != 0 {
		t.Fatal("pending not cleared")
	}
	_, errs, code = runAcp(t, "answer", "a", "--request", "7", "--option", "allow")
	if code != 3 || !strings.Contains(errs, "not outstanding") {
		t.Fatalf("second answer exit %d %q", code, errs)
	}
	if a.stdin() != want {
		t.Fatal("second answer reached the agent")
	}
	out, _, code = runAcp(t, "answers", "a")
	if code != 0 {
		t.Fatalf("answers exit %d", code)
	}
	var m map[string]string
	if err := json.Unmarshal([]byte(out), &m); err != nil || len(m) != 1 || m["7"] != "allow" {
		t.Fatalf("answers %q", out)
	}
}

func TestACPAnswerCancelAndStringID(t *testing.T) {
	acpEnv(t)
	newFakeRelay(t, 200)
	a, script := newScriptedAgent(t)
	startDetached(t, "x", script)
	a.emit(t, strings.Replace(permReq, `"id":7`, `"id":"abc 1"`, 1))
	waitFor(t, "pending", func() bool { return pendingCount("x") == 1 })
	if _, errs, code := runAcp(t, "answer", "x", "--request", `"abc 1"`, "--cancel"); code != 0 {
		t.Fatalf("exit %d %q", code, errs)
	}
	waitFor(t, "agent stdin", func() bool { return a.stdin() != "" })
	want := `{"id":"abc 1","jsonrpc":"2.0","result":{"outcome":{"outcome":"cancelled"}}}` + "\n"
	if got := a.stdin(); got != want {
		t.Fatalf("agent saw %q", got)
	}
	out, _, _ := runAcp(t, "answers", "x")
	if !strings.Contains(out, `"\"abc 1\"":"cancelled"`) {
		t.Fatalf("answers %q", out)
	}
}

func TestACPAnswersEmpty(t *testing.T) {
	acpEnv(t)
	_, script := newScriptedAgent(t)
	startDetached(t, "e2", script)
	out, _, code := runAcp(t, "answers", "e2")
	if code != 0 || strings.TrimSpace(out) != "{}" {
		t.Fatalf("exit %d %q", code, out)
	}
	if _, _, code := runAcp(t, "answers", "nope"); code != 3 {
		t.Fatalf("missing session exit %d", code)
	}
}

func TestACPAnswerNeverInterleavesWithClientStream(t *testing.T) {
	acpEnv(t)
	newFakeRelay(t, 200)
	a, script := newScriptedAgent(t)
	cleanupSession(t, "i")
	p := startAttach(t, "i", "--spawn", script, "--cwd", t.TempDir())
	a.emit(t, permReq)
	p.readLine(t)
	waitFor(t, "pending", func() bool { return pendingCount("i") == 1 })
	// The attached client is mid-line when the answer arrives.
	long := `{"jsonrpc":"2.0","id":1,"method":"x","params":"` + strings.Repeat("z", 400<<10) + `"}`
	half := len(long) / 2
	fmt.Fprint(p.stdin, long[:half])
	time.Sleep(200 * time.Millisecond)
	if _, errs, code := runAcp(t, "answer", "i", "--request", "7", "--option", "reject"); code != 0 {
		t.Fatalf("answer exit %d %q", code, errs)
	}
	fmt.Fprint(p.stdin, long[half:]+"\n")
	fmt.Fprint(p.stdin, `{"jsonrpc":"2.0","id":2,"method":"y"}`+"\n")
	waitFor(t, "all lines", func() bool { return strings.Count(a.stdin(), "\n") == 3 })
	lines := strings.Split(strings.TrimSuffix(a.stdin(), "\n"), "\n")
	for _, l := range lines {
		var v map[string]any
		if err := json.Unmarshal([]byte(l), &v); err != nil {
			t.Fatalf("partial or interleaved line (%d bytes): %v", len(l), err)
		}
	}
	if !strings.Contains(lines[0], `"selected"`) || lines[1] != long {
		t.Fatalf("order/content wrong: %.80q", lines[0])
	}
}

func TestACPPhoneResponseThroughAttachClearsPending(t *testing.T) {
	acpEnv(t)
	newFakeRelay(t, 200)
	a, script := newScriptedAgent(t)
	cleanupSession(t, "r2")
	p := startAttach(t, "r2", "--spawn", script, "--cwd", t.TempDir())
	a.emit(t, permReq)
	p.readLine(t)
	waitFor(t, "pending", func() bool { return pendingCount("r2") == 1 })
	fmt.Fprint(p.stdin, `{"jsonrpc":"2.0","id":7,"result":{"outcome":{"outcome":"selected","optionId":"allow"}}}`+"\n")
	waitFor(t, "cleared", func() bool { return pendingCount("r2") == 0 })
	_, _, code := runAcp(t, "answer", "r2", "--request", "7", "--option", "allow")
	if code != 3 {
		t.Fatalf("exit %d", code)
	}
	if n := strings.Count(a.stdin(), "\n"); n != 1 {
		t.Fatalf("agent saw %d lines", n)
	}
}

func TestACPDonePushOnTurnEndWithNoClient(t *testing.T) {
	acpEnv(t)
	fr := newFakeRelay(t, 200)
	a, script := newScriptedAgent(t)
	cleanupSession(t, "t")
	p := startAttach(t, "t", "--spawn", script, "--cwd", t.TempDir())
	fmt.Fprint(p.stdin, `{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"s","prompt":[]}}`+"\n")
	waitFor(t, "prompt seen", func() bool { return strings.Contains(a.stdin(), "session/prompt") })
	_ = p.stdin.Close()
	p.exitCode(t)
	a.emit(t, permReq)
	fr.waitPushes(t, 1)
	a.emit(t, `{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}`)
	got := fr.waitPushes(t, 2)
	d := got[1]
	if d.Category != acpDoneCategory || d.Level != levelQuiet || d.StopReason != "end_turn" || !strings.Contains(d.Body, "end_turn") || d.Title != "t" {
		t.Fatalf("done push %+v", d)
	}
	if pendingCount("t") != 0 {
		t.Fatal("turn end should clear outstanding requests")
	}
	if _, _, code := runAcp(t, "answer", "t", "--request", "7", "--option", "allow"); code != 3 {
		t.Fatalf("answer after turn end exit %d", code)
	}
}

func TestACPNoDonePushWhenClientAttached(t *testing.T) {
	acpEnv(t)
	fr := newFakeRelay(t, 200)
	a, script := newScriptedAgent(t)
	cleanupSession(t, "n")
	p := startAttach(t, "n", "--spawn", script, "--cwd", t.TempDir())
	fmt.Fprint(p.stdin, `{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{}}`+"\n")
	waitFor(t, "prompt seen", func() bool { return strings.Contains(a.stdin(), "session/prompt") })
	a.emit(t, `{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}`)
	p.readLine(t)
	time.Sleep(300 * time.Millisecond)
	if n := len(fr.pushes()); n != 0 {
		t.Fatalf("pushed %d", n)
	}
}

func TestACPPushFailureDoesNotBreakAgentOrAttach(t *testing.T) {
	acpEnv(t)
	newFakeRelay(t, 500)
	a, script := newScriptedAgent(t)
	startDetached(t, "f", script)
	a.emit(t, permReq)
	waitFor(t, "pending", func() bool { return pendingCount("f") == 1 })
	waitFor(t, "notified", func() bool { return loadACPTracker("f").st.Requests["7"].Notified })
	p := startAttach(t, "f")
	if l := p.readLine(t); !strings.Contains(l, "request_permission") {
		t.Fatalf("replay %q", l)
	}
	if _, errs, code := runAcp(t, "answer", "f", "--request", "7", "--option", "allow"); code != 0 {
		t.Fatalf("answer exit %d %q", code, errs)
	}
}

func TestACPPushRelayDownDoesNotBreakAgent(t *testing.T) {
	acpEnv(t)
	t.Setenv("TETHER_PUSH_RELAY_URL", "http://127.0.0.1:1")
	if err := saveDevices([]Device{{Token: "tok", SecretKey: generateSecretKeyBase64()}}); err != nil {
		t.Fatal(err)
	}
	a, script := newScriptedAgent(t)
	startDetached(t, "dn", script)
	a.emit(t, permReq)
	waitFor(t, "pending", func() bool { return pendingCount("dn") == 1 })
	if _, errs, code := runAcp(t, "answer", "dn", "--request", "7", "--option", "allow"); code != 0 {
		t.Fatalf("answer exit %d %q", code, errs)
	}
}

func dialUnhandshaken(t *testing.T, name string) net.Conn {
	t.Helper()
	m, err := readACPMeta(name)
	if err != nil {
		t.Fatal(err)
	}
	c, err := net.Dial("unix", m.Sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func TestACPNoPushWhenClientFinishesHandshakeWithinGrace(t *testing.T) {
	acpEnv(t)
	fr := newFakeRelay(t, 200)
	a, script := newScriptedAgent(t)
	startDetached(t, "g", script)
	c := dialUnhandshaken(t, "g")
	a.emit(t, permReq)
	waitFor(t, "request tracked", func() bool { return pendingCount("g") == 1 })
	if _, err := fmt.Fprint(c, "0 0\n"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(acpHandshakeGrace + 500*time.Millisecond)
	if n := len(fr.pushes()); n != 0 {
		t.Fatalf("pushed %d over a client that was mid-handshake", n)
	}
}

func TestACPPushesWhenHandshakingClientNeverArrives(t *testing.T) {
	acpEnv(t)
	fr := newFakeRelay(t, 200)
	a, script := newScriptedAgent(t)
	startDetached(t, "h", script)
	c := dialUnhandshaken(t, "h")
	a.emit(t, permReq)
	waitFor(t, "request tracked", func() bool { return pendingCount("h") == 1 })
	c.Close()
	fr.waitPushes(t, 1)
}

const elicitReq = `{"jsonrpc":"2.0","id":0,"method":"elicitation/create","params":{"mode":"form","sessionId":"sess-3","toolCallId":"toolu_x","message":"Which colour do you prefer?","requestedSchema":{"type":"object","properties":{"question_0":{"type":"string","title":"Colour","oneOf":[{"const":"red","title":"red","description":"Red"},{"const":"green","title":"green","description":"Green"},{"const":"blue","title":"blue","description":"Blue"}]},"question_0_custom":{"type":"string","title":"Other","description":"Type your own answer, or add a note to the option you chose above (optional)."}}}}}`

const elicitTwoQuestions = `{"jsonrpc":"2.0","id":4,"method":"elicitation/create","params":{"mode":"form","message":"Two things","requestedSchema":{"type":"object","properties":{"question_0":{"type":"string","oneOf":[{"const":"a","title":"A"},{"const":"b","title":"B"}]},"question_1":{"type":"string","oneOf":[{"const":"c","title":"C"},{"const":"d","title":"D"}]}}}}}`

func TestACPElicitationPushedOnceWithNoClient(t *testing.T) {
	acpEnv(t)
	fr := newFakeRelay(t, 200)
	a, script := newScriptedAgent(t)
	startDetached(t, "e1", script)
	a.emit(t, elicitReq)
	fr.waitPushes(t, 1)
	time.Sleep(300 * time.Millisecond)
	got := fr.pushes()
	if len(got) != 1 {
		t.Fatalf("want one push, got %d", len(got))
	}
	c := got[0]
	if c.Category != acpPermissionCategory || c.Level != levelUrgent || c.Body != "Which colour do you prefer?" ||
		c.ACPSession != "e1" || c.RequestID != "0" || !c.Elicitation || c.Title != "e1 · needs you" || c.State != "waiting" {
		t.Fatalf("payload %+v", c)
	}
	if strings.Join(c.Options, ",") != "red,green,blue" || strings.Join(c.OptionIDs, ",") != "red,green,blue" ||
		strings.Join(c.OptionKinds, ",") != "choice,choice,choice" {
		t.Fatalf("options %+v", c)
	}
	if want := threadKey("box", "e1"); fr.reqs[0].ThreadKey != want || fr.reqs[0].Level != levelUrgent {
		t.Fatalf("relay request %+v", fr.reqs[0])
	}
	if pendingCount("e1") != 1 {
		t.Fatal("request should be pending")
	}
}

func TestACPElicitationNoPushWhenClientAttached(t *testing.T) {
	acpEnv(t)
	fr := newFakeRelay(t, 200)
	a, script := newScriptedAgent(t)
	cleanupSession(t, "e2")
	p := startAttach(t, "e2", "--spawn", script, "--cwd", t.TempDir())
	waitFor(t, "client attached", func() bool { m, err := readACPMeta("e2"); return err == nil && m.Attached })
	a.emit(t, elicitReq)
	if l := p.readLine(t); !strings.Contains(l, "elicitation/create") {
		t.Fatalf("got %q", l)
	}
	time.Sleep(400 * time.Millisecond)
	if n := len(fr.pushes()); n != 0 {
		t.Fatalf("pushed %d with a client attached", n)
	}
	fmt.Fprint(p.stdin, `{"jsonrpc":"2.0","id":0,"result":{"action":"accept","content":{}}}`+"\n")
	waitFor(t, "cleared", func() bool { return pendingCount("e2") == 0 })
}

func TestACPElicitationAnswerWritesOneWholeLine(t *testing.T) {
	acpEnv(t)
	newFakeRelay(t, 200)
	a, script := newScriptedAgent(t)
	startDetached(t, "e3", script)
	a.emit(t, elicitReq)
	waitFor(t, "pending", func() bool { return pendingCount("e3") == 1 })
	if _, errs, code := runAcp(t, "answer", "e3", "--request", "0", "--option", "green"); code != 0 {
		t.Fatalf("exit %d %q", code, errs)
	}
	want := `{"id":0,"jsonrpc":"2.0","result":{"action":"accept","content":{"question_0":"green"}}}` + "\n"
	waitFor(t, "agent stdin", func() bool { return a.stdin() != "" })
	if got := a.stdin(); got != want {
		t.Fatalf("agent saw %q", got)
	}
	if pendingCount("e3") != 0 {
		t.Fatal("pending not cleared")
	}
	if _, errs, code := runAcp(t, "answer", "e3", "--request", "0", "--option", "green"); code != 3 || !strings.Contains(errs, "not outstanding") {
		t.Fatalf("second answer exit %d %q", code, errs)
	}
	out, _, _ := runAcp(t, "answers", "e3")
	if strings.TrimSpace(out) != `{"0":"green"}` {
		t.Fatalf("answers %q", out)
	}
}

func TestACPElicitationRefusesUnofferedOption(t *testing.T) {
	acpEnv(t)
	newFakeRelay(t, 200)
	a, script := newScriptedAgent(t)
	startDetached(t, "e4", script)
	a.emit(t, elicitReq)
	waitFor(t, "pending", func() bool { return pendingCount("e4") == 1 })
	_, errs, code := runAcp(t, "answer", "e4", "--request", "0", "--option", "purple")
	if code != 3 || !strings.Contains(errs, "not one of the choices") {
		t.Fatalf("exit %d %q", code, errs)
	}
	time.Sleep(100 * time.Millisecond)
	if a.stdin() != "" || pendingCount("e4") != 1 {
		t.Fatalf("refused option reached the agent or cleared the request: %q", a.stdin())
	}
}

func TestACPElicitationCancelAndDecline(t *testing.T) {
	acpEnv(t)
	newFakeRelay(t, 200)
	a, script := newScriptedAgent(t)
	startDetached(t, "e5", script)
	a.emit(t, elicitReq)
	a.emit(t, strings.Replace(elicitReq, `"id":0`, `"id":1`, 1))
	waitFor(t, "pending", func() bool { return pendingCount("e5") == 2 })
	if _, errs, code := runAcp(t, "answer", "e5", "--request", "0", "--cancel"); code != 0 {
		t.Fatalf("cancel exit %d %q", code, errs)
	}
	if _, errs, code := runAcp(t, "answer", "e5", "--request", "1", "--decline"); code != 0 {
		t.Fatalf("decline exit %d %q", code, errs)
	}
	want := `{"id":0,"jsonrpc":"2.0","result":{"action":"cancel"}}` + "\n" + `{"id":1,"jsonrpc":"2.0","result":{"action":"decline"}}` + "\n"
	waitFor(t, "agent stdin", func() bool { return strings.Count(a.stdin(), "\n") == 2 })
	if got := a.stdin(); got != want {
		t.Fatalf("agent saw %q", got)
	}
	out, _, _ := runAcp(t, "answers", "e5")
	if strings.TrimSpace(out) != `{"0":"cancelled","1":"declined"}` {
		t.Fatalf("answers %q", out)
	}
}

func TestACPDeclineIsRefusedForPermissions(t *testing.T) {
	acpEnv(t)
	newFakeRelay(t, 200)
	a, script := newScriptedAgent(t)
	startDetached(t, "e6", script)
	a.emit(t, permReq)
	waitFor(t, "pending", func() bool { return pendingCount("e6") == 1 })
	if _, _, code := runAcp(t, "answer", "e6", "--request", "7", "--decline"); code == 0 {
		t.Fatal("decline accepted for a permission request")
	}
	if pendingCount("e6") != 1 {
		t.Fatal("request should still be outstanding")
	}
}

func TestACPElicitationMultiQuestionPushesWithoutOptions(t *testing.T) {
	acpEnv(t)
	fr := newFakeRelay(t, 200)
	a, script := newScriptedAgent(t)
	startDetached(t, "e7", script)
	a.emit(t, elicitTwoQuestions)
	c := fr.waitPushes(t, 1)[0]
	if c.Options != nil || c.OptionIDs != nil || c.OptionKinds != nil || !c.Elicitation || c.Body != "Two things" || c.RequestID != "4" {
		t.Fatalf("payload %+v", c)
	}
	if _, _, code := runAcp(t, "answer", "e7", "--request", "4", "--option", "c"); code != 3 {
		t.Fatalf("option on a multi-question form: exit %d", code)
	}
	if _, errs, code := runAcp(t, "answer", "e7", "--request", "4", "--cancel"); code != 0 {
		t.Fatalf("cancel exit %d %q", code, errs)
	}
}

func TestACPElicitationShapesWithoutPushOptions(t *testing.T) {
	acpEnv(t)
	_ = os.MkdirAll(acpDir("sh"), 0o700)
	mk := func(props string) PushContent {
		line := `{"jsonrpc":"2.0","id":9,"method":"elicitation/create","params":{"message":"m","requestedSchema":{"properties":` + props + `}}}`
		s := &acpDaemonState{tr: loadACPTracker("sh")}
		ev := s.tr.agentLine([]byte(line))
		_ = os.Remove(filepath.Join(acpDir("sh"), "pending.json"))
		return s.permissionPush(ev.permission)
	}
	one := `{"const":"a","title":"A"}`
	cases := map[string]string{
		"free text only": `{"q":{"type":"string","title":"Name"}}`,
		"multi select":   `{"q":{"type":"array","items":{"anyOf":[` + one + `,{"const":"b","title":"B"}]}}}`,
		"five choices":   `{"q":{"type":"string","oneOf":[` + strings.Repeat(one+",", 4) + one + `]}}`,
		"one choice":     `{"q":{"type":"string","oneOf":[` + one + `]}}`,
	}
	for name, props := range cases {
		if c := mk(props); c.Options != nil || !c.Elicitation || c.Category != acpPermissionCategory {
			t.Errorf("%s: %+v", name, c)
		}
	}
	if c := mk(`{"q":{"type":"string","oneOf":[` + one + `,{"const":"b"}]}}`); strings.Join(c.Options, ",") != "A,b" {
		t.Errorf("fallback title: %+v", c)
	}
}

func TestPickPushOptionsKeepsARejection(t *testing.T) {
	opts := []acpOption{
		{OptionID: "a", Name: "Yes, manually approve edits", Kind: "allow_once"},
		{OptionID: "b", Name: "Yes, clear context", Kind: "allow_always"},
		{OptionID: "c", Name: "Yes, and use auto mode", Kind: "allow_always"},
		{OptionID: "d", Name: "Yes, and bypass", Kind: "allow_always"},
		{OptionID: "e", Name: "No, keep planning", Kind: "reject_once"},
	}
	got := pickPushOptions(opts)
	if len(got) != maxPushOptions {
		t.Fatalf("got %d options", len(got))
	}
	ids := ""
	for _, o := range got {
		ids += o.OptionID
	}
	if ids != "abce" {
		t.Fatalf("kept %q, want abce (agent order, rejection kept)", ids)
	}
	if two := opts[:2]; len(pickPushOptions(two)) != 2 {
		t.Fatal("short lists pass through")
	}
	noReject := opts[:4:4]
	if len(pickPushOptions(append(noReject, acpOption{OptionID: "f", Kind: "allow_once"}))) != maxPushOptions {
		t.Fatal("a list with no rejection is still capped")
	}
}
