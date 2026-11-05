package analyzer

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"reflect"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
)

func TestTextFormatsArgumentsByVerb(t *testing.T) {
	text := tx("%s has %.0f%% coverage, D = %.2f, %d items", "a.go", 41.6, 0.5, 3)
	if text.Template != "{0} has {1}% coverage, D = {2}, {3} items" || !reflect.DeepEqual(text.Args, []string{"a.go", "42", "0.50", "3"}) {
		t.Fatalf("got %q %q", text.Template, text.Args)
	}
	if got := text.String(); got != "a.go has 42% coverage, D = 0.50, 3 items" {
		t.Fatalf("got %q", got)
	}
}

type sourceTemplate struct {
	Rule, Template, Where, Problem string
}

// sourceTemplates reads every tx call of the package: the format must be a literal inside a detector.
func sourceTemplates(t *testing.T) []sourceTemplate {
	rules := map[string]string{}
	for id, detect := range detectors {
		name := runtime.FuncForPC(reflect.ValueOf(detect).Pointer()).Name()
		rules[name[strings.LastIndex(name, ".")+1:]] = id
	}
	// Helpers that report for one detector.
	rules["checkSecret"] = "SEC001"
	files, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	set := token.NewFileSet()
	var found []sourceTemplate
	for _, entry := range files {
		if !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") || entry.Name() == "text.go" {
			continue
		}
		file, err := parser.ParseFile(set, entry.Name(), nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, decl := range file.Decls {
			function, ok := decl.(*ast.FuncDecl)
			if !ok || function.Body == nil {
				continue
			}
			ast.Inspect(function.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				if name, ok := call.Fun.(*ast.Ident); !ok || name.Name != "tx" {
					return true
				}
				where := set.Position(call.Pos()).String()
				item := sourceTemplate{Rule: rules[function.Name.Name], Where: where}
				literal, ok := call.Args[0].(*ast.BasicLit)
				if !ok || literal.Kind != token.STRING {
					item.Problem = "the format is not a literal"
				} else {
					format, _ := strconv.Unquote(literal.Value)
					item.Template = templateOf(format)
				}
				if item.Rule == "" {
					item.Problem = "tx outside a detector"
				}
				found = append(found, item)
				return true
			})
		}
	}
	return found
}

// TestTemplatesAreInSpec: every text of a finding is a template of its rule in spec/rules (spec/l10n.md).
func TestTemplatesAreInSpec(t *testing.T) {
	spec := map[string]map[string]bool{}
	for _, rule := range SpecRules() {
		spec[rule.ID] = map[string]bool{}
		for _, message := range rule.Messages {
			spec[rule.ID][message.Text] = true
		}
	}
	found := sourceTemplates(t)
	if dump := os.Getenv("NOMOS_DUMP_TEMPLATES"); dump != "" {
		data, _ := json.MarshalIndent(found, "", "  ")
		_ = os.WriteFile(dump, data, 0o644)
	}
	var missing []string
	for _, item := range found {
		if item.Problem != "" {
			missing = append(missing, item.Where+": "+item.Problem)
		} else if !spec[item.Rule][item.Template] {
			missing = append(missing, item.Where+" "+item.Rule+": not in spec: "+item.Template)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Fatalf("%d texts are not templates of spec/rules:\n%s", len(missing), strings.Join(missing, "\n"))
	}
}
