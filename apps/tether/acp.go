package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// errNoSession maps to exit 3: no live holder and nothing to replay.
var errNoSession = errors.New("no such acp session")

// errReplaced maps to exit 5: the connection ended without the session ending (a daemon from
// before several clients could attach closes the older one when another arrives).
var errReplaced = errors.New("replaced by another client")

// Unix socket paths top out near 104 bytes on macOS and 108 on Linux.
const maxSockPath = 100

type acpMeta struct {
	Name     string `json:"name"`
	Spawn    string `json:"spawn"`
	Cwd      string `json:"cwd"`
	Created  int64  `json:"created"`
	State    string `json:"state"`
	ExitCode *int   `json:"exitCode,omitempty"`
	Sock     string `json:"sock"`
	Pid      int    `json:"pid,omitempty"`
	AgentPid int    `json:"agentPid,omitempty"`
	// Attached is true while a client has completed the first-line handshake and is the current client.
	Attached bool `json:"attached,omitempty"`
	// Ended is the unix time the agent ended; EndedReason is idle, log-limit, exited or killed.
	Ended       int64  `json:"ended,omitempty"`
	EndedReason string `json:"endedReason,omitempty"`
	// Title and Turn mirror the stream tracker so `acp status` can answer without the daemon.
	Title string `json:"title,omitempty"`
	Turn  string `json:"turn,omitempty"`
	Tasks int    `json:"tasks,omitempty"`
	// MultiClient is set by a daemon that lets several clients attach and echoes named ones.
	MultiClient bool `json:"multiClient,omitempty"`
}

func acpDir(name string) string { return filepath.Join(home(), "acp", name) }

func acpMetaPath(name string) string { return filepath.Join(acpDir(name), "meta.json") }

func readACPMeta(name string) (*acpMeta, error) {
	data, err := os.ReadFile(acpMetaPath(name))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, errNoSession
		}
		return nil, err
	}
	var m acpMeta
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

func writeACPMeta(m *acpMeta) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	path := acpMetaPath(m.Name)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// acpSockPath keeps the socket inside the state dir unless that path would not fit.
func acpSockPath(name string) string {
	p := filepath.Join(acpDir(name), "sock")
	if len(p) <= maxSockPath {
		return p
	}
	sum := sha256.Sum256([]byte(acpDir(name)))
	return filepath.Join(os.TempDir(), "tn-acp-"+hex.EncodeToString(sum[:6]), "sock")
}

func procUp(pid int) bool {
	return pid > 0 && syscall.Kill(pid, 0) == nil
}

func metaRunning(m *acpMeta) bool {
	return m.State == "running" && procUp(m.Pid)
}

func runACP(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("usage: acp attach|answer|answers|ls|status|sessions|kill")
	}
	switch args[0] {
	case "attach":
		return acpAttach(args[1:])
	case "daemon":
		if len(args) < 2 {
			return fmt.Errorf("usage: acp daemon <name>")
		}
		return acpDaemon(args[1])
	case "answer":
		return acpAnswer(args[1:])
	case "answers":
		if len(args) < 2 {
			return fmt.Errorf("usage: acp answers <name>")
		}
		return acpAnswers(args[1], os.Stdout)
	case "ls":
		return acpLs(os.Stdout)
	case "status":
		return acpStatus(args[1:], os.Stdout)
	case "sessions":
		return acpSessions(args[1:], os.Stdout)
	case "kill":
		if len(args) < 2 {
			return fmt.Errorf("usage: acp kill <name>")
		}
		return acpKill(args[1])
	}
	return fmt.Errorf("unknown acp command %q", args[0])
}

func acpAttach(args []string) error {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		return fmt.Errorf("usage: acp attach <name> [--spawn CMD] [--cwd DIR] [--from N] [--linger D] [--client ID]")
	}
	name := args[0]
	fs := flag.NewFlagSet("acp attach", flag.ContinueOnError)
	spawn := fs.String("spawn", "", "shell command to start if no session is live")
	cwd := fs.String("cwd", "", "working directory for --spawn (default $HOME)")
	from := fs.Int64("from", 0, "byte offset in out.log to resume from")
	linger := fs.Duration("linger", 0, "after stdin EOF, keep following output until idle this long")
	client := fs.String("client", "", "names this client in the log so the other attached clients see what it sends")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if *client != "" && !validSessionName(*client) {
		return fmt.Errorf("invalid client id")
	}
	if !validSessionName(name) {
		return fmt.Errorf("invalid session name")
	}
	if *from < 0 {
		return fmt.Errorf("--from must not be negative")
	}

	pruneEnded(name)
	m, err := readACPMeta(name)
	if err != nil && !errors.Is(err, errNoSession) {
		return err
	}
	if m != nil && m.State == "ended" {
		return replayEnded(name, *from, os.Stdout, os.Stderr)
	}
	if m == nil || !metaRunning(m) {
		if *spawn == "" {
			return errNoSession
		}
		if m, err = spawnACPDaemon(name, *spawn, *cwd); err != nil {
			return err
		}
	}
	return attachConn(m.Sock, *from, *linger, name, *client)
}

// replayEnded serves a session whose agent has exited: the log from `from`, then, when the agent
// produced nothing and failed, one line of why on stderr so the chat is not silently dead.
func replayEnded(name string, from int64, w, errw io.Writer) error {
	if err := replayLog(name, from, w); err != nil {
		return err
	}
	reportSilentFailure(name, errw)
	return nil
}

func reportSilentFailure(name string, errw io.Writer) {
	m, err := readACPMeta(name)
	if err != nil || m.State != "ended" || m.ExitCode == nil || *m.ExitCode == 0 {
		return
	}
	if st, err := os.Stat(filepath.Join(acpDir(name), "out.log")); err != nil || st.Size() > 0 {
		return
	}
	msg := fmt.Sprintf("agent exited with status %d", *m.ExitCode)
	data, err := os.ReadFile(filepath.Join(acpDir(name), "err.log"))
	if err == nil {
		lines := strings.Split(strings.TrimSpace(string(data)), "\n")
		if last := strings.TrimSpace(lines[len(lines)-1]); last != "" {
			msg += ": " + clip(last, 300)
		}
	}
	if nf := notFoundMessage(*m.ExitCode, string(data)); nf != "" {
		msg = nf
	}
	fmt.Fprintln(errw, msg)
}

func replayLog(name string, from int64, w io.Writer) error {
	f, err := os.Open(filepath.Join(acpDir(name), "out.log"))
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Seek(from, io.SeekStart); err != nil {
		return err
	}
	_, err = io.Copy(w, f)
	return err
}

func attachConn(sock string, from int64, linger time.Duration, name, client string) error {
	conn, err := net.Dial("unix", sock)
	if err != nil {
		// The daemon may have finished and closed its socket since we last looked.
		if m, merr := readACPMeta(name); merr == nil && m.State == "ended" {
			return replayEnded(name, from, os.Stdout, os.Stderr)
		}
		return err
	}
	defer conn.Close()
	if _, err := fmt.Fprintln(conn, strings.TrimSpace(fmt.Sprintf("%d %d %s", from, linger.Milliseconds(), client))); err != nil {
		return err
	}
	var stdinDone sync.WaitGroup
	stdinEOF := make(chan struct{})
	stdinDone.Add(1)
	go func() {
		defer stdinDone.Done()
		_, _ = io.Copy(conn, os.Stdin)
		close(stdinEOF)
		conn.(*net.UnixConn).CloseWrite()
	}()
	n, copyErr := io.Copy(os.Stdout, conn)
	// A connection that was accepted just before the daemon shut down can be cut short; the log is
	// complete once the meta says ended, so serve whatever the socket did not deliver.
	if m, err := readACPMeta(name); err == nil && m.State == "ended" {
		return replayEnded(name, from+n, os.Stdout, os.Stderr)
	}
	if copyErr != nil {
		return nil
	}
	select {
	case <-stdinEOF:
		return nil
	default:
	}
	return errReplaced
}

func spawnACPDaemon(name, spawn, cwd string) (*acpMeta, error) {
	dir := acpDir(name)
	if err := os.RemoveAll(dir); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if cwd == "" {
		cwd, _ = os.UserHomeDir()
	}
	m := &acpMeta{Name: name, Spawn: spawn, Cwd: cwd, Created: time.Now().Unix(), State: "running", Sock: acpSockPath(name)}
	if err := writeACPMeta(m); err != nil {
		return nil, err
	}
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	defer null.Close()
	cmd := exec.Command(exe, "acp", "daemon", name)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = null, null, null
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	go cmd.Wait()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if c, err := net.Dial("unix", m.Sock); err == nil {
			c.Close()
			return m, nil
		}
		// An agent that dies at once can finish the daemon before this loop ever sees the socket.
		if cur, err := readACPMeta(name); err == nil {
			if cur.State == "ended" {
				return cur, nil
			}
			if cur.Pid > 0 && !procUp(cur.Pid) {
				return nil, fmt.Errorf("acp daemon exited before it was ready")
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	return nil, fmt.Errorf("acp daemon did not start")
}

type acpClient struct {
	conn net.Conn
	// id is the client's --client, empty for a client that predates echoes.
	id string
}

type acpDaemonState struct {
	mu      sync.Mutex
	size    int64
	ended   bool
	notify  chan struct{}
	live    map[*acpClient]struct{}
	clients int
	stdin   io.WriteCloser
	log     *os.File
	tr      *acpTracker
	errf    io.Writer
	push    func(PushContent, string) error
	pushes  sync.WaitGroup
	partial []byte
	skip    bool
	// tail is agent output after its last newline, held back so the log only ever grows by
	// whole lines and an echo never lands inside a line the agent is still writing.
	tail []byte

	agentPid  int       // guarded by mu
	endReason string    // why the daemon ended the agent itself, guarded by mu
	activity  time.Time // last agent output or busy moment, guarded by mu

	handshaking int // connections accepted whose first line is not read yet, guarded by mu
	// copilot asks the agent for assistant.idle; dropAnswers are prompts the holder answered for it.
	copilot     bool
	dropAnswers map[string]bool // guarded by mu
	metaMu      sync.Mutex
	meta        *acpMeta
}

// setMeta applies fn to the daemon's meta and writes it; the one writer once the daemon runs.
func (s *acpDaemonState) setMeta(fn func(m *acpMeta)) {
	if s.meta == nil {
		return
	}
	s.metaMu.Lock()
	defer s.metaMu.Unlock()
	fn(s.meta)
	_ = writeACPMeta(s.meta)
}

// syncAttached publishes whether a client is attached: one that has completed the handshake.
func (s *acpDaemonState) syncAttached() {
	s.setMeta(func(m *acpMeta) { m.Attached = s.attached() })
}

func (s *acpDaemonState) broadcast() {
	close(s.notify)
	s.notify = make(chan struct{})
}

// acpShell is the login shell agent commands run under, so they see the user's PATH.
func acpShell() string {
	shell := os.Getenv("SHELL")
	if shell == "" {
		return "sh"
	}
	if _, err := exec.LookPath(shell); err != nil {
		return "sh"
	}
	return shell
}

// syncStream publishes the tracker's title, turn and task count into meta.json when either changed.
func (s *acpDaemonState) syncStream() {
	if s.meta == nil {
		return
	}
	title, turn, tasks := s.tr.snapshot()
	s.metaMu.Lock()
	defer s.metaMu.Unlock()
	if s.meta.State == "ended" {
		return
	}
	if s.meta.Title == title && s.meta.Turn == turn && s.meta.Tasks == tasks {
		return
	}
	s.meta.Title, s.meta.Turn, s.meta.Tasks = title, turn, tasks
	_ = writeACPMeta(s.meta)
}

// acpAgentEnv tells the agent's hooks they run in a chat: the holder pushes for it, and a zmx
// session it was started from is not where the agent lives.
func acpAgentEnv(environ []string, name string) []string {
	env := make([]string, 0, len(environ)+1)
	for _, kv := range environ {
		if strings.HasPrefix(kv, "ZMX_SESSION=") || strings.HasPrefix(kv, "TETHER_ACP=") {
			continue
		}
		env = append(env, kv)
	}
	return append(env, "TETHER_ACP="+name)
}

func acpDaemon(name string) error {
	signal.Ignore(syscall.SIGHUP)
	m, err := readACPMeta(name)
	if err != nil {
		return err
	}
	dir := acpDir(name)
	if err := os.MkdirAll(filepath.Dir(m.Sock), 0o700); err != nil {
		return err
	}
	_ = os.Remove(m.Sock)
	ln, err := net.Listen("unix", m.Sock)
	if err != nil {
		return err
	}
	if err := os.Chmod(m.Sock, 0o600); err != nil {
		return err
	}
	defer os.Remove(m.Sock)

	logf, err := os.OpenFile(filepath.Join(dir, "out.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	errf, err := os.OpenFile(filepath.Join(dir, "err.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}

	cmd := exec.Command(acpShell(), "-lc", m.Spawn)
	cmd.Dir = m.Cwd
	cmd.Env = acpAgentEnv(os.Environ(), name)
	cmd.Stderr = errf
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	pr, pw, err := os.Pipe()
	if err != nil {
		return err
	}
	cmd.Stdout = pw

	s := &acpDaemonState{
		notify: make(chan struct{}), live: map[*acpClient]struct{}{}, stdin: stdin, log: logf, errf: errf,
		tr: loadACPTracker(name), meta: m, activity: time.Now(), copilot: isCopilotSpawn(m.Spawn),
		push: func(c PushContent, collapse string) error { return sendPush(c, collapse, false) },
	}
	startErr := cmd.Start()
	pw.Close()
	m.Pid = os.Getpid()
	m.MultiClient = true
	if startErr == nil {
		m.AgentPid = cmd.Process.Pid
		s.agentPid = m.AgentPid
	}
	if err := writeACPMeta(m); err != nil {
		return err
	}
	_ = os.WriteFile(filepath.Join(dir, "pid"), []byte(strconv.Itoa(m.Pid)), 0o600)
	s.syncStream()

	logMax := acpLogMax()
	idleStop := make(chan struct{})
	if idle := acpDuration("TETHER_ACP_IDLE", defaultACPIdle); idle > 0 && startErr == nil {
		go s.idleLoop(idle, idleStop)
	}
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		buf := make([]byte, 32*1024)
		for {
			n, err := pr.Read(buf)
			if n > 0 {
				s.mu.Lock()
				s.activity = time.Now()
				over := s.agentOutputLocked(buf[:n], err != nil, logMax)
				s.mu.Unlock()
				if over {
					go s.endAgent("log-limit")
				}
				s.scanAgent(buf[:n])
			}
			if err != nil {
				s.mu.Lock()
				over := s.agentOutputLocked(nil, true, logMax)
				s.mu.Unlock()
				if over {
					go s.endAgent("log-limit")
				}
				return
			}
		}
	}()

	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go s.serve(conn)
		}
	}()

	code, signaled := 127, false
	if startErr == nil {
		_ = cmd.Wait()
		code = cmd.ProcessState.ExitCode()
		if ws, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok {
			signaled = ws.Signaled()
		}
	}
	close(idleStop)
	// A grandchild can keep the pipe open past the agent's exit; give the reader a moment, then cut it.
	_ = pr.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	<-readDone

	s.mu.Lock()
	reason := s.endReason
	s.mu.Unlock()
	if reason == "" {
		reason = "exited"
		if signaled {
			reason = "killed"
		}
	}
	s.setMeta(func(m *acpMeta) {
		m.State, m.ExitCode, m.Attached, m.Turn = "ended", &code, false, "idle"
		m.Ended, m.EndedReason = time.Now().Unix(), reason
	})
	s.mu.Lock()
	s.ended = true
	s.broadcast()
	s.mu.Unlock()
	ln.Close()
	waitTimeout(&s.pushes, 15*time.Second)

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		n := s.clients
		s.mu.Unlock()
		if n == 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	return nil
}

func (s *acpDaemonState) serve(conn net.Conn) {
	r := bufio.NewReader(conn)
	s.mu.Lock()
	s.handshaking++
	s.mu.Unlock()
	line, err := r.ReadString('\n')
	s.mu.Lock()
	s.handshaking--
	s.mu.Unlock()
	if err != nil {
		conn.Close()
		return
	}
	if rest, ok := strings.CutPrefix(line, "answer "); ok {
		s.control(conn, rest)
		return
	}
	var from, lingerMs int64
	fields := strings.Fields(line)
	if len(fields) < 2 || len(fields) > 3 {
		conn.Close()
		return
	}
	if _, err := fmt.Sscanf(fields[0]+" "+fields[1], "%d %d", &from, &lingerMs); err != nil || from < 0 {
		conn.Close()
		return
	}
	me := &acpClient{conn: conn}
	if len(fields) == 3 {
		me.id = fields[2]
	}
	s.mu.Lock()
	if from > s.size {
		s.mu.Unlock()
		conn.Close()
		return
	}
	// The same client attaching again (a redial after a drop the host never saw) replaces its
	// old connection, which would otherwise count as attached and hold back every push.
	for c := range s.live {
		if c.id == me.id {
			c.conn.Close()
			delete(s.live, c)
		}
	}
	s.live[me] = struct{}{}
	s.clients++
	s.mu.Unlock()
	s.syncAttached()
	defer func() {
		conn.Close()
		s.mu.Lock()
		s.clients--
		delete(s.live, me)
		s.mu.Unlock()
		s.syncAttached()
	}()

	var stdinClosed bool // guarded by s.mu
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 32*1024)
		var pend []byte
		for {
			n, err := r.Read(buf)
			if n > 0 {
				var lines [][]byte
				lines, pend = splitLines(pend, buf[:n])
				for _, l := range lines {
					s.mu.Lock()
					s.clientLineLocked(me, l)
					s.mu.Unlock()
					s.syncStream()
				}
				if len(pend) > maxACPLine {
					return
				}
			}
			if err != nil {
				s.mu.Lock()
				stdinClosed = true
				s.broadcast()
				s.mu.Unlock()
				return
			}
		}
	}()

	f, err := os.Open(s.log.Name())
	if err != nil {
		return
	}
	defer f.Close()
	buf := make([]byte, 32*1024)
	offset := from
	linger := time.Duration(lingerMs) * time.Millisecond
	for {
		s.mu.Lock()
		size, ended, wake, closed := s.size, s.ended, s.notify, stdinClosed
		s.mu.Unlock()
		if offset < size {
			n := int64(len(buf))
			if size-offset < n {
				n = size - offset
			}
			rn, err := f.ReadAt(buf[:n], offset)
			if rn > 0 {
				if _, werr := conn.Write(buf[:rn]); werr != nil {
					return
				}
				offset += int64(rn)
			}
			if err != nil && err != io.EOF {
				return
			}
			continue
		}
		if ended {
			return
		}
		if closed {
			select {
			case <-wake:
			case <-time.After(linger):
				return
			}
			continue
		}
		select {
		case <-wake:
		case <-done:
			// Peer hung up; stdinClosed (clean EOF) was recorded or the conn is dead.
			s.mu.Lock()
			dead := !stdinClosed
			s.mu.Unlock()
			if dead {
				return
			}
		}
	}
}

// clientLineLocked hands one whole line from a client to the agent. A client that named itself
// gets its prompts, stops and answers echoed into the log first, so every other client, live or
// replaying later, sees them in order. An answer to a request someone already answered is dropped.
func (s *acpDaemonState) clientLineLocked(from *acpClient, line []byte) {
	forward, echo := s.tr.clientLine(line)
	if !forward {
		return
	}
	if s.copilot {
		line = withCopilotEvents(line)
	}
	if echo && from.id != "" {
		s.echoLocked(from.id, line)
	}
	_, _ = s.stdin.Write(line)
}

// echoLocked appends `_tether/client` (an ACP extension notification) carrying a client's line.
func (s *acpDaemonState) echoLocked(client string, line []byte) {
	msg := bytes.TrimSpace(line)
	if !json.Valid(msg) {
		return
	}
	out, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  "_tether/client",
		"params":  map[string]any{"client": client, "message": json.RawMessage(msg)},
	})
	if err != nil {
		return
	}
	s.appendLogLocked(append(out, '\n'))
}

func (s *acpDaemonState) appendLogLocked(b []byte) bool {
	if len(b) == 0 {
		return false
	}
	if _, err := s.log.Write(b); err != nil {
		return false
	}
	s.size += int64(len(b))
	s.broadcast()
	return true
}

// agentOutputLocked logs the agent's output up to its last newline and holds the rest; at EOF,
// or when a line outgrows maxACPLine, what is held goes out as is. It reports passing logMax.
func (s *acpDaemonState) agentOutputLocked(chunk []byte, eof bool, logMax int64) bool {
	s.tail = append(s.tail, chunk...)
	cut := bytes.LastIndexByte(s.tail, '\n') + 1
	if eof || len(s.tail) > maxACPLine {
		cut = len(s.tail)
	}
	if cut > 0 {
		s.appendLogLocked(s.keepAgentLinesLocked(s.tail[:cut]))
		s.tail = append([]byte(nil), s.tail[cut:]...)
	}
	return logMax > 0 && s.size > logMax
}

func acpLs(w io.Writer) error {
	pruneEnded("")
	entries, err := os.ReadDir(filepath.Join(home(), "acp"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	for _, e := range entries {
		m, err := readACPMeta(e.Name())
		if err != nil {
			continue
		}
		state := "ended"
		if metaRunning(m) {
			state = "running"
		}
		var size int64
		if st, err := os.Stat(filepath.Join(acpDir(e.Name()), "out.log")); err == nil {
			size = st.Size()
		}
		spawn := strings.NewReplacer("\t", " ", "\n", " ").Replace(m.Spawn)
		fmt.Fprintf(w, "%s\t%s\t%d\t%s\t%d\t%s\n", m.Name, state, size, m.Cwd, m.Created, spawn)
	}
	return nil
}

func acpKill(name string) error {
	if !validSessionName(name) {
		return fmt.Errorf("invalid session name")
	}
	m, err := readACPMeta(name)
	if err != nil {
		return err
	}
	if m.State == "running" && m.AgentPid > 0 {
		_ = syscall.Kill(-m.AgentPid, syscall.SIGTERM)
	}
	deadline := time.Now().Add(3 * time.Second)
	for procUp(m.Pid) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if procUp(m.Pid) {
		if m.State == "running" && m.AgentPid > 0 {
			_ = syscall.Kill(-m.AgentPid, syscall.SIGKILL)
		}
		_ = syscall.Kill(m.Pid, syscall.SIGKILL)
	}
	_ = os.RemoveAll(filepath.Dir(m.Sock))
	return os.RemoveAll(acpDir(name))
}
