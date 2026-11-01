package analyzer

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"go/ast"
	"go/token"
	"math"
	"regexp"
	"sort"
	"strings"
)

// Measured is the value and threshold behind a finding.
type Measured struct {
	Metric    string  `json:"metric"`
	Value     float64 `json:"value"`
	Threshold float64 `json:"threshold"`
}

// Finding is one heuristic result.
type Finding struct {
	Rule, Severity, Confidence string
	Category                   string
	Place                      Place
	Message, Explanation       string
	Module, Entity             string
	Measured                   *Measured
}

// Fingerprint does not depend on the line (contracts/sarif-profile.md).
func (f *Finding) Fingerprint() string {
	sum := sha256.Sum256([]byte(f.Rule + "|" + f.Place.File + "|" + f.Entity + "|" + f.Message))
	return hex.EncodeToString(sum[:])[:16]
}

// Supported lists the rules implemented for Go. The others are recorded as not-supported: they rest on
// inheritance, constructors or properties, which the language does not have, or on detectors not written yet (D-038).
var Supported = []string{
	"ALG001", "ALG002", "ALG003", "ALG004", "CC001", "CC002", "CC003", "CC004", "DSN001", "DSN002", "DSN003", "DSN004", "DSN005", "DSN006",
	"FUN005", "MNT001", "MNT002", "MNT003", "MNT004", "OOP002", "OOP003", "OOP004", "OOP005", "SEC001", "SEC003", "STR001", "STR002", "STR003",
}

type run struct {
	p        *Project
	config   *Config
	graphs   *Graphs
	edges    []Edge
	active   map[string]map[string]bool // module to enabled and active paradigms
	findings []Finding
	estimate map[string]Growth
	coverage *Coverage
	rule     SpecRule
	ran      map[string]SpecRule
}

func (r *run) applies(m *Module) bool {
	if len(r.rule.Paradigms) == 0 {
		return true
	}
	for _, paradigm := range r.rule.Paradigms {
		if r.active[m.ID][paradigm] {
			return true
		}
	}
	return false
}

func (r *run) report(confidence string, place Place, module, entity, message, explanation string, measured *Measured, severity ...string) {
	level := r.rule.Severity
	if len(severity) > 0 {
		level = severity[0]
	}
	if own := r.config.Rules[r.rule.ID].Severity; own != "" {
		level = own
	}
	r.findings = append(r.findings, Finding{r.rule.ID, level, confidence, r.rule.Category, place, message, explanation, module, entity, measured})
}

func (r *run) functions(visit func(*Function)) {
	for _, m := range r.p.Modules {
		if !r.applies(m) {
			continue
		}
		for _, f := range moduleFunctions(m) {
			visit(f)
		}
	}
}

func (r *run) types(visit func(*Type)) {
	for _, m := range r.p.Modules {
		if !r.applies(m) {
			continue
		}
		for _, t := range m.Types {
			visit(t)
		}
	}
}

func lineSpan(p Place) int { return p.EndLine - p.StartLine + 1 }

var detectors = map[string]func(*run){
	"ALG001": alg001, "ALG002": alg002, "ALG003": alg003, "ALG004": alg004, "CC001": cc001, "CC002": cc002, "CC003": cc003, "CC004": cc004,
	"DSN001": dsn001, "DSN002": dsn002, "DSN003": dsn003, "DSN004": dsn004, "DSN005": dsn005, "DSN006": dsn006, "FUN005": fun005,
	"MNT001": mnt001, "MNT002": mnt002, "MNT003": mnt003, "MNT004": mnt004, "OOP002": oop002, "OOP003": oop003, "OOP004": oop004, "OOP005": oop005,
	"SEC001": sec001, "SEC003": sec003, "STR001": str001, "STR002": str002, "STR003": str003,
}

func cc001(r *run) {
	limit := r.config.number(r.rule, "maxLines")
	r.functions(func(f *Function) {
		lines := float64(lineSpan(f.Place))
		if f.Body() == nil || lines <= limit {
			return
		}
		var severity []string
		if lines > limit*2 {
			severity = []string{"major"}
		}
		r.report("high", f.Place, f.Module.ID, f.ID, fmt.Sprintf("%s spans %.0f lines", f.Name, lines), fmt.Sprintf("The line count is exact; the limit of %.0f is a readability convention.", limit), &Measured{"lines", lines, limit}, severity...)
	})
}

func cc002(r *run) {
	maxLines, maxMembers := r.config.number(r.rule, "maxLines"), r.config.number(r.rule, "maxMembers")
	r.types(func(t *Type) {
		lines, members := float64(lineSpan(t.Place)), float64(t.FieldCount+len(t.Methods))
		if t.Kind == "defined" || (lines <= maxLines && members <= maxMembers) {
			return
		}
		var measured *Measured
		if lines > maxLines {
			measured = &Measured{"lines", lines, maxLines}
		}
		r.report("high", t.Place, t.Module.ID, t.ID, fmt.Sprintf("%s has %.0f lines and %.0f members", t.Name, lines, members), fmt.Sprintf("The counts are exact; the limits (%.0f lines, %.0f members) are conventions.", maxLines, maxMembers), measured)
	})
}

func cc003(r *run) {
	limit := r.config.number(r.rule, "maxParameters")
	r.functions(func(f *Function) {
		count := float64(ParameterCount(f.Sig))
		if count > limit {
			r.report("high", f.Place, f.Module.ID, f.ID, fmt.Sprintf("%s takes %.0f parameters", f.Name, count), fmt.Sprintf("The limit is %.0f. Long lists are easy to misorder; a parameter struct groups what belongs together.", limit), &Measured{"parameterCount", count, limit})
		}
	})
}

func cc004(r *run) {
	limit := r.config.number(r.rule, "maxDepth")
	r.functions(func(f *Function) {
		depth := float64(MaxNesting(f))
		if depth > limit {
			r.report("high", f.Place, f.Module.ID, f.ID, fmt.Sprintf("%s nests %.0f levels deep", f.Name, depth), fmt.Sprintf("The limit is %.0f. Guard clauses or extracted functions flatten the flow.", limit), &Measured{"maxNesting", depth, limit})
		}
	})
}

func alg001(r *run) {
	reportFrom := r.config.number(r.rule, "reportFromDegree")
	r.functions(func(f *Function) {
		growth, ok := r.estimate[f.ID]
		if !ok || (!growth.Exponential && float64(growth.Degree) < reportFrom) {
			return
		}
		confidence, explanation := "medium", "Estimated from nested loops over inputs of unknown size. Small inputs may make this irrelevant."
		if growth.Uncertain {
			confidence, explanation = "low", "Estimated from recursion, a condition-only loop or a callee; loop bounds and call counts are not known exactly."
		}
		measured, severity := &Measured{"timeDegree", float64(growth.Degree), reportFrom}, []string{}
		if growth.Exponential {
			measured, severity = &Measured{"timeExponential", 1, 1}, []string{"major"}
		}
		r.report(confidence, f.Place, f.Module.ID, f.ID, fmt.Sprintf("%s is likely %s", f.Name, growth), explanation, measured, severity...)
	})
}

func alg002(r *run) {
	r.functions(func(f *Function) {
		r.p.walkLoops(f, func(n ast.Node, depth int) {
			if depth == 0 {
				return
			}
			switch node := n.(type) {
			case *ast.CallExpr:
				if pkg, name := externalCall(f.Module, node); pkg == "slices" && linearCalls[pkg][name] && (name == "Contains" || name == "Index" || name == "IndexFunc" || name == "ContainsFunc") {
					r.report("medium", r.p.place(node.Pos(), node.End()), f.Module.ID, f.ID, fmt.Sprintf("Likely quadratic: slices.%s inside a loop", name), "Each iteration scans the sequence. A map built once makes the lookup constant-time.", nil)
				}
				if id, ok := node.Fun.(*ast.Ident); ok && id.Name == "append" && len(node.Args) == 2 && node.Ellipsis.IsValid() {
					if _, front := node.Args[0].(*ast.CompositeLit); front {
						r.report("medium", r.p.place(node.Pos(), node.End()), f.Module.ID, f.ID, "Likely quadratic: front insertion inside a loop", "Every element shifts on each call. Appending and reversing once avoids this.", nil)
					}
				}
			case *ast.AssignStmt:
				if node.Tok == token.ADD_ASSIGN && len(node.Lhs) == 1 && f.Module.Info.TypeOf(node.Lhs[0]) != nil && f.Module.Info.TypeOf(node.Lhs[0]).Underlying().String() == "string" {
					r.report("medium", r.p.place(node.Pos(), node.End()), f.Module.ID, f.ID, "Likely quadratic: String concatenation inside a loop", "Each step copies the whole string so far. strings.Builder grows in amortized constant time.", nil)
				}
			}
		})
	})
}

func alg003(r *run) {
	limit := r.config.number(r.rule, "minDepthForObjects")
	r.functions(func(f *Function) {
		measured := &Measured{"allocationDepth", float64(r.p.AllocationDepth(f)), limit}
		var skip []ast.Node
		r.p.walkLoops(f, func(n ast.Node, depth int) {
			if float64(depth) < limit || !r.p.allocates(f, n) {
				return
			}
			for _, inner := range skip {
				if inner == n {
					return
				}
			}
			if unary, ok := n.(*ast.UnaryExpr); ok {
				skip = append(skip, unary.X)
			}
			message, explanation := "Allocation in a nested loop", "Runs once per inner iteration. Whether it matters depends on how hot the loop really is, which static analysis cannot tell."
			if _, ok := n.(*ast.FuncLit); ok {
				message, explanation = "Function literal in a nested loop", "A capturing literal allocates a closure per iteration."
			}
			r.report("low", r.p.place(n.Pos(), n.End()), f.Module.ID, f.ID, message, explanation, measured)
		})
	})
}

func alg004(r *run) {
	reportFrom := r.config.number(r.rule, "reportFromDegree")
	r.functions(func(f *Function) {
		if f.Body() == nil {
			return
		}
		degree := float64(r.p.SpaceDegree(f))
		if degree >= reportFrom {
			r.report("low", f.Place, f.Module.ID, f.ID, fmt.Sprintf("%s likely uses %s extra memory", f.Name, Growth{Degree: int(degree)}), "Estimated from slice growth under nested loops or sized allocations.", &Measured{"spaceDegree", degree, reportFrom})
		}
	})
}

func (r *run) martin(m *Module) (ca, ce int, instability, abstractness, distance *float64) {
	inside := map[string]bool{}
	abstract := 0
	for _, t := range m.Types {
		inside[t.ID] = true
		if t.IsAbstract() {
			abstract++
		}
	}
	for _, f := range m.Functions {
		inside[f.ID] = true
	}
	in, out := map[string]bool{}, map[string]bool{}
	for unit := range inside {
		for other := range r.graphs.Units.Prev[unit] {
			if !inside[other] {
				in[other] = true
			}
		}
		for other := range r.graphs.Units.Next[unit] {
			if !inside[other] {
				out[other] = true
			}
		}
	}
	ca, ce = len(in), len(out)
	if ca+ce > 0 {
		instability = number(round(float64(ce)/float64(ca+ce), 4))
	}
	if len(m.Types) > 0 {
		abstractness = number(round(float64(abstract)/float64(len(m.Types)), 4))
	}
	if instability != nil && abstractness != nil {
		distance = number(round(math.Abs(*abstractness+*instability-1), 4))
	}
	return ca, ce, instability, abstractness, distance
}

func dsn001(r *run) {
	limit, coupling := r.config.number(r.rule, "maxDistance"), r.config.number(r.rule, "minCoupling")
	for _, m := range r.p.Modules {
		ca, ce, instability, abstractness, distance := r.martin(m)
		if distance == nil || *distance <= limit || float64(ca+ce) < coupling || len(m.Types) == 0 {
			continue
		}
		zone := "the zone of uselessness: abstract and unused"
		if *instability < 0.5 {
			zone = "the zone of pain: concrete and heavily depended upon"
		}
		r.report("medium", m.Types[0].Place, m.ID, "", fmt.Sprintf("Module %s is far from the main sequence (D = %.2f)", m.ID, *distance), fmt.Sprintf("A = %.2f, I = %.2f, so it sits near %s.", *abstractness, *instability, zone), &Measured{"distance", *distance, limit})
	}
}

func dsn002(r *run) {
	for _, cycle := range Components(r.graphs.Modules) {
		for _, m := range r.p.Modules {
			if m.ID == cycle[0] && len(m.Types) > 0 {
				r.report("high", m.Types[0].Place, m.ID, "", "Module cycle: "+strings.Join(cycle, " <-> "), "These modules depend on each other, directly or transitively, so none can be built, tested or released alone.", nil)
			}
		}
	}
	for _, cycle := range Components(r.graphs.Units) {
		names := make([]string, len(cycle))
		for i, id := range cycle {
			names[i] = simpleName(id)
		}
		place, module := Place{}, ""
		if t := r.p.Types[cycle[0]]; t != nil {
			place, module = t.Place, t.Module.ID
		} else if f := r.p.Functions[cycle[0]]; f != nil {
			place, module = f.Place, f.Module.ID
		}
		r.report("high", place, module, cycle[0], fmt.Sprintf("Type cycle of %d: %s", len(cycle), strings.Join(names, " <-> ")), "These units reference each other, so a change to one can ripple through all of them.", nil, "minor")
	}
}

func dsn003(r *run) {
	if len(r.config.Layers) == 0 {
		return
	}
	for _, e := range r.edges {
		if e.External || e.Kind == "import" {
			continue
		}
		from, to := r.graphs.ModuleOf[e.From], r.graphs.ModuleOf[e.To]
		if from == nil || to == nil || from == to {
			continue
		}
		source, target := r.config.layerOf(from.ID), r.config.layerOf(to.ID)
		if source == nil || target == nil || source.Name == target.Name {
			continue
		}
		allowed := false
		for _, name := range source.MayDependOn {
			allowed = allowed || name == target.Name
		}
		if !allowed {
			r.report("high", e.Place, from.ID, e.From, fmt.Sprintf("%s must not depend on %s", source.Name, target.Name), fmt.Sprintf("%s (%s) uses %s (%s); allowed: %s.", simpleName(e.From), from.ID, simpleName(e.To), to.ID, strings.Join(source.MayDependOn, ", ")), nil)
		}
	}
}

func dsn004(r *run) {
	minWmc, minAtfd, maxTcc := r.config.number(r.rule, "minWmc"), r.config.number(r.rule, "minAtfd"), r.config.number(r.rule, "maxTcc")
	r.types(func(t *Type) {
		if t.Kind != "struct" {
			return
		}
		wmc, atfd, tcc := float64(WMC(t)), float64(r.p.ATFD(t)), r.p.TCC(t)
		if wmc >= minWmc && atfd >= minAtfd && tcc != nil && *tcc < maxTcc {
			r.report("medium", t.Place, t.Module.ID, t.ID, t.Name+" looks like a god class", fmt.Sprintf("WMC = %.0f (>= %.0f), ATFD = %.0f (>= %.0f), TCC = %.2f (< %.2f): it does much, uses others' data, and its methods share little.", wmc, minWmc, atfd, minAtfd, *tcc, maxTcc), &Measured{"wmc", wmc, minWmc})
		}
	})
}

func dsn005(r *run) {
	limit := r.config.number(r.rule, "minForeignMembers")
	r.functions(func(f *Function) {
		if !isMethod(f) {
			return
		}
		owner, members := r.p.MostUsedForeign(f)
		own, _ := r.p.memberUse(f)
		count := float64(len(members))
		if count >= limit && len(members) > len(own) {
			r.report("medium", f.Place, f.Module.ID, f.ID, fmt.Sprintf("%s is more interested in %s than in %s", f.Name, simpleName(owner), f.Owner.Name), fmt.Sprintf("It uses %.0f members of %s (%s) and %d of its own.", count, owner, strings.Join(members, ", "), len(own)), &Measured{"foreignMembers", count, limit})
		}
	})
}

func dsn006(r *run) {
	limit := r.config.number(r.rule, "maxDependents")
	for _, t := range r.p.AllTypes() {
		radius := float64(r.graphs.Radius[t.ID])
		if radius > limit {
			r.report("medium", t.Place, t.Module.ID, t.ID, fmt.Sprintf("Changing %s can reach %.0f units", t.Name, radius), "Stable abstractions at such points limit the spread. Static dependencies overstate real impact when a change keeps the contract.", &Measured{"blastRadius", radius, limit})
		}
	}
}

func fun005(r *run) {
	maxOrder, maxNesting := r.config.number(r.rule, "maxOrder"), r.config.number(r.rule, "maxLambdaNesting")
	r.functions(func(f *Function) {
		if order := float64(HofOrder(f)); order > maxOrder {
			r.report("medium", f.Place, f.Module.ID, f.ID, fmt.Sprintf("%s has order %.0f", f.Name, order), fmt.Sprintf("The signature nests function types beyond order %.0f.", maxOrder), &Measured{"hofOrder", order, maxOrder})
		}
		if nesting := float64(LambdaNesting(f)); nesting > maxNesting {
			r.report("medium", f.Place, f.Module.ID, f.ID, fmt.Sprintf("%s nests function literals %.0f deep", f.Name, nesting), fmt.Sprintf("Beyond %.0f levels, captured variables are hard to trace.", maxNesting), &Measured{"lambdaNesting", nesting, maxNesting})
		}
	})
}

func mnt001(r *run) {
	limit := r.config.number(r.rule, "maxComplexity")
	r.functions(func(f *Function) {
		complexity := float64(Cyclomatic(f))
		if f.Body() == nil || complexity <= limit {
			return
		}
		var severity []string
		if complexity > limit*2 {
			severity = []string{"major"}
		}
		r.report("high", f.Place, f.Module.ID, f.ID, fmt.Sprintf("%s has cyclomatic complexity %.0f", f.Name, complexity), fmt.Sprintf("The count is exact; above %.0f, the number of paths to test and to understand grows quickly.", limit), &Measured{"cyclomatic", complexity, limit}, severity...)
	})
}

func mnt002(r *run) {
	limit := r.config.number(r.rule, "minIndex")
	r.functions(func(f *Function) {
		index := MaintainabilityIndex(f)
		if f.Body() == nil || index == nil || *index >= limit {
			return
		}
		r.report("medium", f.Place, f.Module.ID, f.ID, fmt.Sprintf("%s has a maintainability index of %.0f", f.Name, *index), fmt.Sprintf("Below %.0f. The formula is an empirical blend of size and complexity, useful for ranking rather than as a measure of quality.", limit), &Measured{"maintainabilityIndex", round(*index, 4), limit})
	})
}

type cloneToken struct {
	hash uint64
	line int
}

func normalized(f *File) []cloneToken {
	var list []cloneToken
	for _, t := range f.Tokens {
		if f.ImportLines[t.Line] {
			continue
		}
		text := t.Text
		switch {
		case t.Tok == token.IDENT:
			text = "$id"
		case t.Tok.IsLiteral():
			text = "$lit"
		}
		hash := uint64(14695981039346656037)
		for _, c := range []byte(text) {
			hash = (hash ^ uint64(c)) * 1099511628211
		}
		list = append(list, cloneToken{hash, t.Line})
	}
	return list
}

func mnt003(r *run) {
	const base = 1000003
	window := int(r.config.number(r.rule, "minTokens"))
	type position struct{ file, at int }
	type source struct {
		file   *File
		tokens []cloneToken
	}
	var files []source
	for _, f := range r.p.Files {
		if tokens := normalized(f); len(tokens) >= window {
			files = append(files, source{f, tokens})
		}
	}
	power := uint64(1)
	for i := 1; i < window; i++ {
		power *= base
	}
	seen := map[uint64][]position{}
	for index, f := range files {
		tokens := f.tokens
		hash := uint64(0)
		for i := 0; i < window; i++ {
			hash = hash*base + tokens[i].hash
		}
		skipUntil := 0
		for at := 0; at+window <= len(tokens); at++ {
			if at > 0 {
				hash = (hash-tokens[at-1].hash*power)*base + tokens[at+window-1].hash
			}
			if at >= skipUntil {
				for _, earlier := range seen[hash] {
					other := files[earlier.file].tokens
					length := 0
					for earlier.at+length < len(other) && at+length < len(tokens) && other[earlier.at+length].hash == tokens[at+length].hash {
						length++
					}
					if length < window || (earlier.file == index && earlier.at+length > at) {
						continue
					}
					skipUntil = at + length
					place := Place{f.file.Path, tokens[at].line, 1, tokens[at+length-1].line, 1}
					r.report("high", place, "", "", fmt.Sprintf("%d tokens duplicate %s:%d", length, files[earlier.file].file.Path, other[earlier.at].line), "The token sequences are identical after replacing identifiers and literals with placeholders.", &Measured{"cloneTokens", float64(length), float64(window)})
					break
				}
			}
			seen[hash] = append(seen[hash], position{index, at})
		}
	}
}

func mnt004(r *run) {
	if r.coverage == nil {
		return
	}
	limit := r.config.number(r.rule, "minCoverage")
	report, _ := r.config.threshold(r.rule, "report").(string)
	for _, f := range r.p.Files {
		percent := r.coverage.Percent(f.Path)
		if percent != nil && *percent < limit {
			r.report("high", Place{f.Path, 1, 1, 1, 1}, "", "", fmt.Sprintf("%s has %.0f%% line coverage", f.Path, *percent), fmt.Sprintf("Measured from %s; below the %.0f%% minimum. Coverage shows what ran, not what was verified.", report, limit), &Measured{"coverage", *percent, limit})
		}
	}
}

func oop002(r *run) {
	limit := r.config.number(r.rule, "maxDepth")
	r.types(func(t *Type) {
		if t.Kind != "struct" {
			return
		}
		if depth := float64(r.p.DIT(t, nil)); depth > limit {
			r.report("medium", t.Place, t.Module.ID, t.ID, fmt.Sprintf("%s embeds %.0f levels deep", t.Name, depth), fmt.Sprintf("The limit is %.0f; promoted members come from far away.", limit), &Measured{"dit", depth, limit})
		}
	})
}

func oop003(r *run) {
	limit := r.config.number(r.rule, "minTypeTests")
	r.functions(func(f *Function) {
		if tested := float64(len(r.p.TestedTypes(f))); tested >= limit {
			r.report("medium", f.Place, f.Module.ID, f.ID, fmt.Sprintf("%s tests %.0f project types at run time", f.Name, tested), "A type switch over project types is what an interface method can replace.", &Measured{"typeTests", tested, limit})
		}
	})
}

func oop004(r *run) {
	maxLcom, minMethods := r.config.number(r.rule, "maxLcom"), r.config.number(r.rule, "minMethods")
	r.types(func(t *Type) {
		if t.Kind != "struct" {
			return
		}
		if lcom := r.p.LCOM4(t); lcom != nil && *lcom > maxLcom && float64(len(t.Methods)) >= minMethods {
			r.report("medium", t.Place, t.Module.ID, t.ID, fmt.Sprintf("%s has %.0f unrelated method groups", t.Name, *lcom), "Groups of methods that share no state may be separate responsibilities.", &Measured{"lcom4", *lcom, maxLcom})
		}
	})
}

func (r *run) cbo(t *Type) int {
	seen := map[string]bool{}
	for _, e := range r.edges {
		if e.From == t.ID && e.Kind != "import" && e.ToType && !e.Stdlib {
			seen[e.To] = true
		}
	}
	return len(seen)
}

func oop005(r *run) {
	limit := r.config.number(r.rule, "maxCoupling")
	r.types(func(t *Type) {
		if t.Kind != "struct" {
			return
		}
		if coupling := float64(r.cbo(t)); coupling > limit {
			r.report("medium", t.Place, t.Module.ID, t.ID, fmt.Sprintf("%s is coupled to %.0f types", t.Name, coupling), fmt.Sprintf("The limit is %.0f; each dependency is a reason to change.", limit), &Measured{"cbo", coupling, limit})
		}
	})
}

var (
	secretName      = regexp.MustCompile(`(?i)password|passwd|pwd|secret|api_?key|apikey|access_?token|auth_?token|private_?key`)
	knownCredential = regexp.MustCompile(`AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{32,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,}`)
	sqlText         = regexp.MustCompile(`(?is)\b(SELECT\s.+\sFROM|INSERT\s+INTO|UPDATE\s.+\sSET|DELETE\s+FROM|DROP\s+TABLE)\b`)
)

func (r *run) checkSecret(m *Module, name string, value ast.Expr, entity string) {
	text, ok := constantString(m, value)
	if _, literal := value.(*ast.BasicLit); !ok || !literal || len(text) < 6 {
		return
	}
	place := r.p.place(value.Pos(), value.End())
	if knownCredential.MatchString(text) {
		r.report("high", place, m.ID, entity, name+" holds what looks like a real credential", "Heuristic: the literal matches the format of a known key or token. Rotate it if it is real, and load it from a secret store.", nil, "critical")
	} else if secretName.MatchString(name) && !strings.ContainsAny(text, " {") {
		r.report("medium", place, m.ID, entity, name+" looks like a hardcoded secret", "Heuristic: the name suggests a secret and the value is a literal. It may be a placeholder or a non-secret value.", nil)
	}
}

func sec001(r *run) {
	for _, m := range r.p.Modules {
		for _, tree := range m.Syntax {
			for _, decl := range tree.Decls {
				generic, ok := decl.(*ast.GenDecl)
				if !ok {
					continue
				}
				for _, spec := range generic.Specs {
					if value, ok := spec.(*ast.ValueSpec); ok {
						for i, name := range value.Names {
							if i < len(value.Values) {
								r.checkSecret(m, name.Name, value.Values[i], "")
							}
						}
					}
				}
			}
		}
		for _, f := range moduleFunctions(m) {
			inspectBody(f, func(n ast.Node) bool {
				if assign, ok := n.(*ast.AssignStmt); ok && len(assign.Lhs) == len(assign.Rhs) {
					for i, target := range assign.Lhs {
						switch t := target.(type) {
						case *ast.Ident:
							r.checkSecret(m, t.Name, assign.Rhs[i], f.ID)
						case *ast.SelectorExpr:
							r.checkSecret(m, t.Sel.Name, assign.Rhs[i], f.ID)
						}
					}
				}
				return true
			})
		}
	}
}

func sec003(r *run) {
	for _, m := range r.p.Modules {
		for _, f := range moduleFunctions(m) {
			inner := map[ast.Node]bool{}
			inspectBody(f, func(n ast.Node) bool {
				if inner[n] {
					return true
				}
				text, dynamic := "", false
				switch node := n.(type) {
				case *ast.BinaryExpr:
					if node.Op != token.ADD {
						return true
					}
					var parts func(x ast.Expr)
					parts = func(x ast.Expr) {
						if b, ok := x.(*ast.BinaryExpr); ok && b.Op == token.ADD {
							inner[b] = true
							parts(b.X)
							parts(b.Y)
						} else if value, ok := constantString(m, x); ok {
							text += value
						} else {
							dynamic = true
						}
					}
					parts(node)
				case *ast.CallExpr:
					pkg, name := externalCall(m, node)
					if pkg != "fmt" || name != "Sprintf" || len(node.Args) < 2 {
						return true
					}
					text, _ = constantString(m, node.Args[0])
					dynamic = true
				default:
					return true
				}
				if dynamic && sqlText.MatchString(text) {
					r.report("medium", r.p.place(n.Pos(), n.End()), m.ID, f.ID, "SQL built from non-constant values", "Heuristic: if any value comes from a user, this allows injection. Parameterized queries keep data out of the statement.", nil)
				}
				return true
			})
		}
	}
}

func str001(r *run) {
	r.functions(func(f *Function) {
		inspectBody(f, func(n ast.Node) bool {
			if branch, ok := n.(*ast.BranchStmt); ok && branch.Tok == token.GOTO {
				r.report("high", r.p.place(n.Pos(), n.End()), f.Module.ID, f.ID, fmt.Sprintf("goto %s in %s", branch.Label.Name, f.Name), "The flow no longer follows the block structure; a loop, a helper or an early return usually replaces it.", nil)
			}
			return true
		})
	})
}

func str002(r *run) {
	for _, m := range r.p.Modules {
		if r.applies(m) {
			for _, g := range m.Globals {
				r.report("high", g.Place, m.ID, "", "Global variable "+g.Name, "Any function can change it, so its value depends on the call history.", nil)
			}
		}
	}
}

func str003(r *run) {
	maxModule, maxFile := r.config.number(r.rule, "maxModuleLines"), r.config.number(r.rule, "maxFileLines")
	for _, m := range r.p.Modules {
		loc := 0
		for _, f := range m.Files {
			loc += f.Loc
		}
		if r.applies(m) && float64(loc) > maxModule && len(m.Files) > 0 {
			r.report("high", Place{m.Files[0].Path, 1, 1, 1, 1}, m.ID, "", fmt.Sprintf("Module %s has %d lines of code", m.ID, loc), fmt.Sprintf("The limit is %.0f; a smaller module is easier to understand as a unit.", maxModule), &Measured{"loc", float64(loc), maxModule})
		}
	}
	for _, f := range r.p.Files {
		if f.Module != nil && r.applies(f.Module) && float64(f.Lines) > maxFile {
			r.report("high", Place{f.Path, 1, 1, 1, 1}, "", "", fmt.Sprintf("%s has %d lines", f.Path, f.Lines), fmt.Sprintf("The limit is %.0f.", maxFile), &Measured{"lines", float64(f.Lines), maxFile})
		}
	}
}

func sortFindings(list []Finding) []Finding {
	seen := map[string]bool{}
	unique := list[:0]
	for _, f := range list {
		key := fmt.Sprint(f.Rule, f.Place, f.Message)
		if !seen[key] {
			seen[key] = true
			unique = append(unique, f)
		}
	}
	sort.SliceStable(unique, func(i, j int) bool {
		a, b := unique[i], unique[j]
		switch {
		case a.Place.File != b.Place.File:
			return a.Place.File < b.Place.File
		case a.Place.StartLine != b.Place.StartLine:
			return a.Place.StartLine < b.Place.StartLine
		case a.Place.StartColumn != b.Place.StartColumn:
			return a.Place.StartColumn < b.Place.StartColumn
		case a.Rule != b.Rule:
			return a.Rule < b.Rule
		}
		return a.Message < b.Message
	})
	return unique
}
