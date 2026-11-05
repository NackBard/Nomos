package analyzer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func graph(edges ...[2]string) *Graph {
	g := newGraph()
	for _, e := range edges {
		g.edge(e[0], e[1])
	}
	return g
}

func TestComponentsSeparateOverlappingAndBridgedCycles(t *testing.T) {
	g := graph([2]string{"a", "b"}, [2]string{"b", "c"}, [2]string{"c", "a"}, [2]string{"c", "d"}, [2]string{"d", "e"}, [2]string{"e", "d"})
	want := [][]string{{"a", "b", "c"}, {"d", "e"}}
	if got := Components(g); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestComponentsSurviveDeepChains(t *testing.T) {
	g := newGraph()
	for i := 0; i < 100000; i++ {
		g.edge(itoa(i), itoa(i+1))
	}
	if got := Components(g); len(got) != 0 {
		t.Fatalf("a chain has no cycle, got %d", len(got))
	}
}

func TestReachCountsTransitiveDependentsOnce(t *testing.T) {
	g := graph([2]string{"left", "bottom"}, [2]string{"right", "bottom"}, [2]string{"top", "left"}, [2]string{"top", "right"})
	if got := reach(g, "bottom"); got != 3 {
		t.Fatalf("got %d, want 3", got)
	}
}

func TestGlobs(t *testing.T) {
	cases := []struct {
		pattern, value string
		want           bool
	}{
		{"conformance/**", "conformance/cases/a.go", true},
		{"**/node_modules/**", "x/node_modules/y/a.go", true},
		{"*.go", "a.go", true},
		{"*.go", "x/a.go", false},
	}
	for _, c := range cases {
		if got := globMatches(c.pattern, c.value); got != c.want {
			t.Errorf("%s on %s: got %v", c.pattern, c.value, got)
		}
	}
}

func TestCoberturaAndSimilarPaths(t *testing.T) {
	path := filepath.Join(t.TempDir(), "c.xml")
	text := `<coverage><packages><package><classes><class filename="src/a.go"><lines><line number="1" hits="2"/><line number="2" hits="0"/></lines></class></classes></package></packages></coverage>`
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	report, err := LoadCoverage(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := report.Percent("a.go"); got == nil || *got != 50 {
		t.Fatalf("got %v, want 50", got)
	}
	if got := report.Percent("c/a.go"); got != nil {
		t.Fatalf("a similar path must not match, got %v", *got)
	}
}

func TestNestedModulesKeepTheirImportPaths(t *testing.T) {
	root := t.TempDir()
	write := func(name, text string) {
		full := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("tools/app/go.mod", "module example.com/app\n")
	write("tools/app/core/core.go", "package core\n\ntype T struct{}\n")
	write("tools/app/main.go", "package main\n\nimport \"example.com/app/core\"\n\nvar V core.T\n")
	p, err := Load(root, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if p.Types["example.com/app/core.T"] == nil {
		t.Fatalf("modules: %v", p.Modules[0].ID)
	}
}

func TestManifestDeclaresTheFilesItReads(t *testing.T) {
	text, err := Manifest()
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		SchemaVersion string   `json:"schemaVersion"`
		Files         []string `json:"files"`
	}
	if err := json.Unmarshal(text, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.SchemaVersion != "1.2.0" || !reflect.DeepEqual(manifest.Files, []string{"**/*.go"}) {
		t.Errorf("manifest: schemaVersion %q, files %v", manifest.SchemaVersion, manifest.Files)
	}
}

func writeConfig(t *testing.T, text string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "nomos.json")
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestPracticesTurnOffTheRulesOutsideThem(t *testing.T) {
	config, err := LoadConfig(writeConfig(t, `{"schemaVersion":"1.1.0","analyzers":[],"practices":["security","oop"]}`))
	if err != nil {
		t.Fatal(err)
	}
	outside := config.OutsidePractices()
	if _, off := outside["SEC001"]; off {
		t.Error("SEC001 is in the selected practice security")
	}
	if _, off := outside["DSN004"]; off {
		t.Error("DSN004 is in oop as well as in architecture; one selected practice is enough")
	}
	if outside["CC001"] != "Rule belongs to practice clean-code, which is not selected; 'practices' in nomos.json selects them" {
		t.Errorf("CC001: %q", outside["CC001"])
	}
	if outside["DSN001"] == "" {
		t.Error("DSN001 belongs only to architecture, which is not selected")
	}
}

func TestWithoutPracticesEveryRuleRuns(t *testing.T) {
	config, err := LoadConfig(writeConfig(t, `{"schemaVersion":"1.0.0","analyzers":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if config.OutsidePractices() != nil {
		t.Error("no practices in the file means no rule is outside them")
	}
}

func TestAnUnknownPracticeIsAConfigError(t *testing.T) {
	_, err := LoadConfig(writeConfig(t, `{"schemaVersion":"1.1.0","analyzers":[],"practices":["tidy"]}`))
	if _, ok := err.(ConfigError); !ok {
		t.Fatalf("expected ConfigError, got %v", err)
	}
}

func TestEveryRuleBelongsToAPractice(t *testing.T) {
	owned := map[string]bool{}
	for _, practice := range SpecPractices() {
		for _, rule := range practice.Rules {
			owned[rule] = true
		}
	}
	for _, rule := range SpecRules() {
		if !owned[rule.ID] {
			t.Errorf("%s belongs to no practice", rule.ID)
		}
	}
}
