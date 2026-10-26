package main

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestVersionText(t *testing.T) {
	old := version
	version = "v1.2.3"
	defer func() { version = old }()
	var b bytes.Buffer
	if err := runVersion(nil, &b); err != nil {
		t.Fatal(err)
	}
	if got, want := b.String(), "tether v1.2.3\nprotocol 2\n"; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestVersionJSON(t *testing.T) {
	var b bytes.Buffer
	if err := runVersion([]string{"--json"}, &b); err != nil {
		t.Fatal(err)
	}
	var v struct {
		Name     string `json:"name"`
		Version  string `json:"version"`
		Protocol int    `json:"protocol"`
	}
	if err := json.Unmarshal(b.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
	if v.Name != "tether" || v.Version != "dev" || v.Protocol != protocol {
		t.Fatalf("got %+v", v)
	}
	if bytes.Count(b.Bytes(), []byte("\n")) != 1 {
		t.Fatalf("want one line, got %q", b.String())
	}
}

func TestVersionRejectsUnknownFlag(t *testing.T) {
	if err := runVersion([]string{"--nope"}, &bytes.Buffer{}); err == nil {
		t.Fatal("want error")
	}
}
