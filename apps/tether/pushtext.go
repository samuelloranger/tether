package main

import (
	"regexp"
	"strings"
)

const (
	pushTitleLimit = 100
	pushBodyLimit  = 180
)

// pushText makes text safe to show: valid UTF-8 (a hook may cut a multi-byte rune in half),
// trimmed and clipped to n runes.
func pushText(s string, n int) string {
	return clip(strings.TrimSpace(strings.ToValidUTF8(s, "")), n)
}

var (
	mdHeading = regexp.MustCompile(`(?m)^[ \t]*(#{1,6}|>)[ \t]+`)
	mdLink    = regexp.MustCompile(`\[([^\]\n]+)\]\([^)\s]+\)`)
	mdMarks   = strings.NewReplacer("**", "", "`", "")
	spaces    = regexp.MustCompile(`\s+`)
)

// plainLine flattens an agent's markdown reply to one line of prose: headings, quotes,
// links, ** bold and code marks go; underscores (__init__) and #s inside text stay.
func plainLine(s string) string {
	s = mdHeading.ReplaceAllString(s, "")
	s = mdLink.ReplaceAllString(s, "$1")
	s = mdMarks.Replace(s)
	return strings.TrimSpace(spaces.ReplaceAllString(s, " "))
}

// titleNames reports whether the title already leads with the subtitle, which would then
// show the same name twice ("tether · done" over "tether").
func titleNames(title, subtitle string) bool {
	return subtitle != "" && (title == subtitle || strings.HasPrefix(title, subtitle+" · "))
}

// toolLabel turns an MCP tool id (mcp__server__tool) into "server: tool".
func toolLabel(name string) string {
	rest, ok := strings.CutPrefix(name, "mcp__")
	if !ok {
		return name
	}
	server, tool, ok := strings.Cut(rest, "__")
	if !ok || server == "" || tool == "" {
		return name
	}
	return server + ": " + tool
}
