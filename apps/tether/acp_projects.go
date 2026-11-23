package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Saved projects outlive their chats, so a client can list a folder with no chat in it
// and start a new one there.
const acpProjectsMax = 200

type acpProject struct {
	Path string `json:"path"`
}

func acpProjectsPath() string {
	return filepath.Join(home(), "acp-projects.json")
}

func acpProjects(args []string, w io.Writer) error {
	verb := ""
	if len(args) > 0 {
		verb = args[0]
	}
	switch {
	case verb == "" && len(args) == 0:
		return withSessionLock("acp-projects", func() error {
			paths, err := readACPProjects()
			if err != nil {
				return err
			}
			return printACPProjects(paths, w)
		})
	case (verb == "add" || verb == "remove") && len(args) == 2:
		path, err := cleanProjectPath(args[1])
		if err != nil {
			return err
		}
		return withSessionLock("acp-projects", func() error {
			paths, err := readACPProjects()
			if err != nil {
				return err
			}
			if verb == "add" {
				paths, err = addProjectPath(paths, path)
				if err != nil {
					return err
				}
			} else {
				paths = removeProjectPath(paths, path)
			}
			if err := writePrivateJSON(acpProjectsPath(), paths); err != nil {
				return err
			}
			return printACPProjects(paths, w)
		})
	}
	return fmt.Errorf("usage: acp projects [add|remove <path>]")
}

func cleanProjectPath(path string) (string, error) {
	if !filepath.IsAbs(path) || len(path) > 4096 || strings.ContainsAny(path, "\r\n\x00") {
		return "", fmt.Errorf("project path must be absolute and a single line")
	}
	return filepath.Clean(path), nil
}

// readACPProjects seeds a missing file from the chats already on the host, so projects
// that predate the list keep showing once their chats are gone.
func readACPProjects() ([]string, error) {
	data, err := os.ReadFile(acpProjectsPath())
	if os.IsNotExist(err) {
		paths := seedACPProjects()
		if err := writePrivateJSON(acpProjectsPath(), paths); err != nil {
			return nil, err
		}
		return paths, nil
	}
	if err != nil {
		return nil, err
	}
	var paths []string
	if err := json.Unmarshal(data, &paths); err != nil {
		return nil, err
	}
	return paths, nil
}

func seedACPProjects() []string {
	paths := []string{}
	entries, _ := os.ReadDir(filepath.Join(home(), "acp"))
	for _, e := range entries {
		m, err := readACPMeta(e.Name())
		if err != nil || !filepath.IsAbs(m.Cwd) {
			continue
		}
		if org, err := readACPOrganization(e.Name()); err == nil && org.Archived {
			continue
		}
		paths, _ = addProjectPath(paths, filepath.Clean(acpProjectRoot(m.Cwd)))
	}
	return paths
}

func addProjectPath(paths []string, path string) ([]string, error) {
	for _, p := range paths {
		if p == path {
			return paths, nil
		}
	}
	if len(paths) >= acpProjectsMax {
		return paths, fmt.Errorf("at most %d projects", acpProjectsMax)
	}
	paths = append(paths, path)
	sort.Strings(paths)
	return paths, nil
}

func removeProjectPath(paths []string, path string) []string {
	out := paths[:0:0]
	for _, p := range paths {
		if p != path {
			out = append(out, p)
		}
	}
	return out
}

func printACPProjects(paths []string, w io.Writer) error {
	enc := json.NewEncoder(w)
	for _, p := range paths {
		if err := enc.Encode(acpProject{Path: p}); err != nil {
			return err
		}
	}
	return nil
}

// rememberACPProject saves a new chat's project; a failure must never stop the chat.
func rememberACPProject(cwd string) {
	if !filepath.IsAbs(cwd) {
		return
	}
	path := filepath.Clean(acpProjectRoot(cwd))
	_ = withSessionLock("acp-projects", func() error {
		paths, err := readACPProjects()
		if err != nil {
			return err
		}
		next, err := addProjectPath(paths, path)
		if err != nil || len(next) == len(paths) {
			return err
		}
		return writePrivateJSON(acpProjectsPath(), next)
	})
}
