package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
)

// protocol is bumped when a command or wire format the app depends on changes; the app
// refuses a host whose protocol is lower than it requires. 2: several clients can attach to
// one acp session at once (attach --client, `_tether/client` echoes).
const protocol = 2

// version is set by the installer with -ldflags "-X main.version=...".
var version = "dev"

func runVersion(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("version", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	asJSON := fs.Bool("json", false, "print one JSON object")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *asJSON {
		return json.NewEncoder(out).Encode(struct {
			Name     string `json:"name"`
			Version  string `json:"version"`
			Protocol int    `json:"protocol"`
		}{"tether", version, protocol})
	}
	_, err := fmt.Fprintf(out, "tether %s\nprotocol %d\n", version, protocol)
	return err
}
