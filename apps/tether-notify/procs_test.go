package main

import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

func TestParseZmxClients(t *testing.T) {
	out := "  name=App terminal ssh\tpid=10\tclients=0\tcreated=1\tcwd=file://h/x\n" +
		"name=work\tpid=11\tclients=2\tcreated=2\tcwd=file://h/y\n" +
		"pid=12\tclients=1\n\n"
	got := parseZmxClients(out)
	if len(got) != 2 || got["App terminal ssh"] != 0 || got["work"] != 2 {
		t.Fatalf("got %v", got)
	}
}

func TestZmxPathPrefersEnv(t *testing.T) {
	t.Setenv("TETHER_ZMX", "/opt/fake/zmx")
	if zmxPath() != "/opt/fake/zmx" {
		t.Fatalf("got %s", zmxPath())
	}
}

func TestZmxClientsRunsLs(t *testing.T) {
	t.Setenv("TETHER_ZMX", "/fake/zmx")
	var called []string
	run := func(name string, args ...string) (string, error) {
		called = append(called, name+" "+strings.Join(args, " "))
		return "name=s\tclients=1\n", nil
	}
	got, err := zmxClients(run)
	if err != nil || got["s"] != 1 || len(called) != 1 || called[0] != "/fake/zmx ls" {
		t.Fatalf("got %v err %v called %v", got, err, called)
	}
}

// ps answers keyed by pid: "<ppid> <comm>".
func psRunner(table map[string]string) runner {
	return func(name string, args ...string) (string, error) {
		pid := args[len(args)-1]
		if row, ok := table[pid]; ok {
			return "  " + row + "\n", nil
		}
		return "", errors.New("no such process")
	}
}

func TestAgentPidSkipsShellsAndWrapper(t *testing.T) {
	run := psRunner(map[string]string{
		"300": "200 sh",
		"200": "150 tether-notify-h", // Linux truncates comm to 15 chars
		"150": "100 /bin/bash",
		"100": "1 claude",
	})
	if got := agentPid(run, 300); got != 100 {
		t.Fatalf("got %d", got)
	}
}

func TestAgentPidCommWithSpaces(t *testing.T) {
	run := psRunner(map[string]string{"50": "1 /Applications/Some App/bin/agent"})
	if got := agentPid(run, 50); got != 50 {
		t.Fatalf("got %d", got)
	}
}

func TestAgentPidUnknownOnPsFailure(t *testing.T) {
	if got := agentPid(psRunner(nil), 300); got != 0 {
		t.Fatalf("got %d", got)
	}
}

func TestPidAlive(t *testing.T) {
	if !pidAlive(os.Getpid()) {
		t.Fatal("own pid must be alive")
	}
	if !pidAlive(0) {
		t.Fatal("unknown pid must count as alive")
	}
	if pidAlive(1 << 22) {
		t.Fatal("pid beyond pid_max must be dead")
	}
}

func TestExecRunnerTimesOut(t *testing.T) {
	old := commandTimeout
	commandTimeout = 100 * time.Millisecond
	defer func() { commandTimeout = old }()
	start := time.Now()
	if _, err := execRunner("sleep", "5"); err == nil {
		t.Fatal("a hung command must fail, not block the hook")
	}
	if time.Since(start) > 2*time.Second {
		t.Fatalf("took %v", time.Since(start))
	}
}
