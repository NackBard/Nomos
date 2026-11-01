package analyzer

import (
	"regexp"
	"strings"
)

// directives holds the suppressions of one file (spec/suppressions.md).
type directives struct {
	file  []string
	lines map[int][]string
}

var directive = regexp.MustCompile("nomos-disable(-next-line|-line)?([ \\t,\\w.*]*)")

func (d *directives) add(comment string, start, end int) {
	match := directive.FindStringSubmatch(comment)
	if match == nil {
		return
	}
	ids := strings.FieldsFunc(match[2], func(r rune) bool { return r == ' ' || r == '\t' || r == ',' })
	if len(ids) == 0 {
		ids = []string{"*"}
	}
	switch match[1] {
	case "-line":
		d.lines[start] = append(d.lines[start], ids...)
	case "-next-line":
		d.lines[end+1] = append(d.lines[end+1], ids...)
	default:
		d.file = append(d.file, ids...)
	}
}

func (d *directives) covers(rule string, line int) bool {
	for _, list := range [][]string{d.file, d.lines[line]} {
		for _, id := range list {
			if id == "*" || strings.EqualFold(id, rule) {
				return true
			}
		}
	}
	return false
}

// suppress removes the findings under a directive and returns the rest with the number removed.
func (p *Project) suppress(findings []Finding) ([]Finding, int) {
	byPath := map[string]*File{}
	for _, f := range p.Files {
		byPath[f.Path] = f
	}
	kept := []Finding{}
	for _, f := range findings {
		if file := byPath[f.Place.File]; file == nil || !file.Directives.covers(f.Rule, f.Place.StartLine) {
			kept = append(kept, f)
		}
	}
	return kept, len(findings) - len(kept)
}
