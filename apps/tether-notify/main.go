package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

func relayURL() string {
	if url := os.Getenv("TETHER_PUSH_RELAY_URL"); url != "" {
		return url
	}
	return "https://tether-relay.samlo.cloud"
}

type relayRequest struct {
	Token      string `json:"token"`
	Ciphertext string `json:"ciphertext"`
	CollapseID string `json:"collapseId"`
	// Level and ThreadKey are the only new cleartext: an urgency tier and an opaque
	// hash, never the session name.
	Level     string `json:"level,omitempty"`
	ThreadKey string `json:"threadKey,omitempty"`
}

const (
	levelUrgent = "urgent"
	levelNormal = "normal"
	levelQuiet  = "quiet"
)

// pushLevel tiers a push by what the user must do: a question or permission wants an
// answer, a finished turn can wait, anything else keeps the default.
func pushLevel(category string) string {
	switch category {
	case "tether.agent.waiting", questionCategory:
		return levelUrgent
	case "tether.agent.done":
		return levelQuiet
	}
	return levelNormal
}

// threadKey groups one session's pushes on the phone without telling the relay which
// session it is: a truncated hash of the host label and session name.
func threadKey(host, session string) string {
	if session == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(host + "\x00" + session))
	return hex.EncodeToString(sum[:8])
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "register":
		err = cmdRegister(os.Args[2:])
	case "notify":
		err = cmdNotify(os.Args[2:])
	case "list":
		err = cmdList()
	case "remove":
		err = cmdRemove(os.Args[2:])
	case "state":
		err = runState(os.Args[2:], defaultStateDeps(false))
	case "status":
		err = runStatus(os.Stdout, defaultStatusDeps())
	case "answer":
		err = runAnswer(os.Args[2:], defaultAnswerDeps())
		if errors.Is(err, errStale) {
			fmt.Fprintln(os.Stderr, "tether-notify: the agent has moved on; nothing was sent")
			os.Exit(3)
		}
		if errors.Is(err, errNotSubmitted) {
			fmt.Fprintln(os.Stderr, "tether-notify: typed, but the agent moved on before Return")
			os.Exit(4)
		}
	case "hold":
		err = runHold(os.Args[2:], defaultHoldDeps())
		if errors.Is(err, errNotHeld) {
			os.Exit(3)
		}
	case "wait":
		err = runWait(os.Args[2:], defaultWaitDeps())
	case "pending":
		err = runPending(os.Args[2:], defaultPendingDeps())
		if errors.Is(err, errStale) {
			fmt.Fprintln(os.Stderr, "tether-notify: nothing is waiting for an answer")
			os.Exit(3)
		}
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "tether-notify:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `tether-notify — encrypted push for the SSH host

  register <token> <secretKeyB64> [label]   register/replace a phone
  notify --title T --body B [--link L] [--category C] [--collapse ID] [--dry-run]
  state --session S --agent A --state working|waiting|done|clear
        [--title T --body B --link L] [--collapse ID] [--dry-run]
                                             record a session's agent state; pushes waiting/done
                                             unless the session has an attached zmx client
  status                                     print every session's agent state as JSON
  answer --session S --state ST --version V (--input B64 [--submit] | --option N | --answers B64)
                                             type a notification action's input, only while the
                                             agent is still in state ST version V (exit 3 if not;
                                             exit 4 if it moved on before Return)
  hold --session S --kind permission|question --tool T --body B [--questions-stdin]
                                             hold a permission request (or, with --kind question and the
                                             questions as JSON on stdin, a question) for the phone: record it and
                                             push it, printing its version (exit 3 if not held: a
                                             client is attached, no host label, or the push failed)
  wait --session S --version V               block until the phone answers held request V; prints one
                                             JSON line: {"action":"approve|deny|reply","text":…} or
                                             {"release":"attached|stale"}
  pending --session S                        print the held question for the phone's answer sheet
                                             (exit 3 if none)
  list                                       list registered phones
  remove <token>                             forget a phone
`)
}

func cmdRegister(args []string) error {
	if len(args) < 2 {
		return fmt.Errorf("usage: register <token> <secretKeyB64> [label]")
	}
	label := ""
	if len(args) >= 3 {
		label = args[2]
	}
	devices, err := loadDevices()
	if err != nil {
		return err
	}
	devices = registerDevice(devices, Device{Token: args[0], SecretKey: args[1], Label: label})
	return saveDevices(devices)
}

func cmdList() error {
	devices, err := loadDevices()
	if err != nil {
		return err
	}
	for _, d := range devices {
		label := d.Label
		if label == "" {
			label = "-"
		}
		fmt.Printf("%s\t%s\n", label, d.Token)
	}
	return nil
}

func cmdRemove(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("usage: remove <token>")
	}
	devices, err := loadDevices()
	if err != nil {
		return err
	}
	return saveDevices(removeDevice(devices, args[0]))
}

func cmdNotify(args []string) error {
	fs := flag.NewFlagSet("notify", flag.ContinueOnError)
	title := fs.String("title", "", "notification title")
	body := fs.String("body", "", "notification body")
	link := fs.String("link", "", "tether:// deep link (optional)")
	category := fs.String("category", "", "iOS notification category (optional)")
	session := fs.String("session", "", "zmx session name, shown as the subtitle and used to group pushes (optional)")
	collapse := fs.String("collapse", "tether-notify", "APNs collapse id")
	dryRun := fs.Bool("dry-run", false, "print requests instead of sending")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *title == "" || *body == "" {
		return fmt.Errorf("notify requires --title and --body")
	}
	return sendPush(PushContent{Title: *title, Body: *body, Link: *link, Category: *category, Session: *session}, *collapse, *dryRun)
}

func sendPush(content PushContent, collapse string, dryRun bool) error {
	devices, err := loadDevices()
	if err != nil {
		return err
	}
	if len(devices) == 0 {
		return fmt.Errorf("no registered devices")
	}
	if content.Level == "" {
		content.Level = pushLevel(content.Category)
	}
	thread := threadKey(hostLabel(), content.Session)
	url := strings.TrimRight(relayURL(), "/") + "/push"
	client := &http.Client{Timeout: 5 * time.Second}

	var retry *retrier
	if content.Level == levelUrgent && !dryRun {
		retry = &retrier{sleep: time.Sleep}
	}

	var sent int
	for _, device := range devices {
		ciphertext, err := encryptPushContent(device.SecretKey, content)
		if err != nil {
			fmt.Fprintf(os.Stderr, "encrypt for %s failed: %v\n", shortToken(device.Token), err)
			continue
		}
		req := relayRequest{Token: device.Token, Ciphertext: ciphertext, CollapseID: collapse, Level: content.Level, ThreadKey: thread}
		if dryRun {
			out, _ := json.Marshal(req)
			fmt.Println(string(out))
			sent++
			continue
		}
		switch deliver(client, url, req, retry) {
		case delivered:
			sent++
		case gone:
			devices = removeDevice(devices, device.Token)
			_ = saveDevices(devices)
		case failed:
			// advisory: logged, never fatal
		}
	}
	if sent == 0 && !dryRun {
		return fmt.Errorf("no device accepted the push")
	}
	return nil
}

type deliveryResult int

const (
	delivered deliveryResult = iota
	gone
	failed
)

const (
	maxRetries     = 3
	maxRetryWait   = 5 * time.Second
	retryBudget    = 12 * time.Second
	defaultBackoff = time.Second
)

// retrier bounds how long urgent pushes may stall the calling hook. waited is
// shared across devices so the budget covers one sendPush call.
type retrier struct {
	sleep  func(time.Duration)
	waited time.Duration
}

// next reports how long to wait before retry attempt (0-based), or false once
// the retry count or the time budget is spent.
func (r *retrier) next(attempt int, retryAfter time.Duration) (time.Duration, bool) {
	if attempt >= maxRetries {
		return 0, false
	}
	wait := retryAfter
	if wait <= 0 {
		wait = defaultBackoff << attempt
	}
	if wait > maxRetryWait {
		wait = maxRetryWait
	}
	if r.waited+wait > retryBudget {
		return 0, false
	}
	r.waited += wait
	return wait, true
}

func parseRetryAfter(v string) time.Duration {
	secs, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || secs <= 0 {
		return 0
	}
	return time.Duration(secs) * time.Second
}

// deliver posts one request. A nil retry means a single attempt; otherwise
// 429, 503 and transport errors are retried within the retrier's bounds.
func deliver(client *http.Client, url string, req relayRequest, retry *retrier) deliveryResult {
	body, _ := json.Marshal(req)
	for attempt := 0; ; attempt++ {
		result, transient, retryAfter := post(client, url, body)
		if !transient || retry == nil {
			return result
		}
		wait, ok := retry.next(attempt, retryAfter)
		if !ok {
			return result
		}
		retry.sleep(wait)
	}
}

func post(client *http.Client, url string, body []byte) (result deliveryResult, transient bool, retryAfter time.Duration) {
	resp, err := client.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		fmt.Fprintf(os.Stderr, "relay post failed: %v\n", err)
		return failed, true, 0
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusGone:
		return gone, false, 0
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return delivered, false, 0
	default:
		fmt.Fprintf(os.Stderr, "relay returned %d\n", resp.StatusCode)
		busy := resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable
		return failed, busy, parseRetryAfter(resp.Header.Get("Retry-After"))
	}
}

func shortToken(token string) string {
	if len(token) <= 12 {
		return token
	}
	return token[:12] + "…"
}
