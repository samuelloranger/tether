package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
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
	collapse := fs.String("collapse", "tether-notify", "APNs collapse id")
	dryRun := fs.Bool("dry-run", false, "print requests instead of sending")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *title == "" || *body == "" {
		return fmt.Errorf("notify requires --title and --body")
	}
	return sendPush(PushContent{Title: *title, Body: *body, Link: *link, Category: *category}, *collapse, *dryRun)
}

func sendPush(content PushContent, collapse string, dryRun bool) error {
	devices, err := loadDevices()
	if err != nil {
		return err
	}
	if len(devices) == 0 {
		return fmt.Errorf("no registered devices")
	}
	url := strings.TrimRight(relayURL(), "/") + "/push"
	client := &http.Client{Timeout: 5 * time.Second}

	var sent int
	for _, device := range devices {
		ciphertext, err := encryptPushContent(device.SecretKey, content)
		if err != nil {
			fmt.Fprintf(os.Stderr, "encrypt for %s failed: %v\n", shortToken(device.Token), err)
			continue
		}
		req := relayRequest{Token: device.Token, Ciphertext: ciphertext, CollapseID: collapse}
		if dryRun {
			out, _ := json.Marshal(req)
			fmt.Println(string(out))
			sent++
			continue
		}
		switch deliver(client, url, req) {
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

func deliver(client *http.Client, url string, req relayRequest) deliveryResult {
	body, _ := json.Marshal(req)
	resp, err := client.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		fmt.Fprintf(os.Stderr, "relay post failed: %v\n", err)
		return failed
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusGone:
		return gone
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return delivered
	default:
		fmt.Fprintf(os.Stderr, "relay returned %d\n", resp.StatusCode)
		return failed
	}
}

func shortToken(token string) string {
	if len(token) <= 12 {
		return token
	}
	return token[:12] + "…"
}
