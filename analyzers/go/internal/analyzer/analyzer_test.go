package analyzer

import (
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
