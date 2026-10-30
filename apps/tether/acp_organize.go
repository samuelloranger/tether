package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// Organization is kept outside the holder's meta.json: its writer must never race
// the daemon's live state, and a branch can be named before its holder starts.
type acpOrganization struct {
	Pinned   bool       `json:"pinned"`
	Archived bool       `json:"archived"`
	Title    string     `json:"title"`
	Parent   *acpParent `json:"parent,omitempty"`
}

type acpParent struct {
	Name   string `json:"name"`
	Title  string `json:"title"`
	Method string `json:"method"`
}

type acpOrganizationPatch struct {
	Pinned   *bool      `json:"pinned"`
	Archived *bool      `json:"archived"`
	Title    *string    `json:"title"`
	Parent   *acpParent `json:"parent"`
}

func acpOrganizationPath(name string) string {
	return filepath.Join(home(), "acp-organization", name+".json")
}

func readACPOrganization(name string) (acpOrganization, error) {
	var out acpOrganization
	data, err := os.ReadFile(acpOrganizationPath(name))
	if os.IsNotExist(err) {
		return out, nil
	}
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(data, &out)
	return out, err
}

func acpOrganize(args []string, w io.Writer) error {
	if len(args) == 0 || !validSessionName(args[0]) {
		return fmt.Errorf("usage: acp organize <name> --json <patch>")
	}
	name := args[0]
	fs := flag.NewFlagSet("acp organize", flag.ContinueOnError)
	patchJSON := fs.String("json", "", "partial chat organization as JSON")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if fs.NArg() != 0 || len(*patchJSON) > 8192 || !strings.HasPrefix(strings.TrimSpace(*patchJSON), "{") {
		return fmt.Errorf("--json requires a chat organization object (at most 8 KiB)")
	}
	var patch acpOrganizationPatch
	dec := json.NewDecoder(strings.NewReader(*patchJSON))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&patch); err != nil {
		return fmt.Errorf("invalid organization patch: %w", err)
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("invalid organization patch suffix")
	}
	if patch.Title != nil {
		title := strings.TrimSpace(*patch.Title)
		if !utf8.ValidString(title) || utf8.RuneCountInString(title) > 200 || strings.ContainsAny(title, "\r\n\x00") {
			return fmt.Errorf("chat title must be a single line of at most 200 characters")
		}
		patch.Title = &title
	}
	if p := patch.Parent; p != nil {
		if !validSessionName(p.Name) || p.Name == name || p.Method != "copy" || utf8.RuneCountInString(p.Title) > 200 || strings.ContainsAny(p.Title, "\r\n\x00") {
			return fmt.Errorf("invalid branch parent")
		}
	}
	return withSessionLock("acp-organization", func() error {
		if patch.Pinned != nil || patch.Archived != nil {
			if _, err := readACPMeta(name); err != nil {
				return err
			}
		}
		out, err := readACPOrganization(name)
		if err != nil {
			return err
		}
		if patch.Pinned != nil {
			out.Pinned = *patch.Pinned
		}
		if patch.Archived != nil {
			out.Archived = *patch.Archived
		}
		if patch.Title != nil {
			out.Title = *patch.Title
		}
		if patch.Parent != nil {
			out.Parent = patch.Parent
		}
		if err := writePrivateJSON(acpOrganizationPath(name), out); err != nil {
			return err
		}
		return json.NewEncoder(w).Encode(out)
	})
}

func writePrivateJSON(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".write-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := io.Copy(f, bytes.NewReader(data)); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

// Walking .git markers handles ordinary repositories, subdirectories and Git
// worktrees without starting a git process on every status poll.
func acpProjectRoot(cwd string) string {
	if !filepath.IsAbs(cwd) {
		return cwd
	}
	for dir := filepath.Clean(cwd); ; dir = filepath.Dir(dir) {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return dir
		}
		if filepath.Dir(dir) == dir {
			return cwd
		}
	}
}
