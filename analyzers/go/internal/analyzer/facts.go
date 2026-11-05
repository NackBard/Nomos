package analyzer

import (
	"bufio"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Protocol identity.
const (
	Name            = "nomos-go"
	Language        = "go"
	Version         = "0.1.0"
	factsVersion    = "1.2.0"
	manifestVersion = "1.2.0"
)

// Coverage is line coverage from a Cobertura or LCOV report (spec/metrics.md).
type Coverage struct{ files map[string]map[int]int }

// LoadCoverage reads a report; the extension .xml means Cobertura.
func LoadCoverage(path string) (*Coverage, error) {
	text, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	c := &Coverage{map[string]map[int]int{}}
	if strings.EqualFold(filepath.Ext(path), ".xml") {
		var report struct {
			Classes []struct {
				File  string `xml:"filename,attr"`
				Lines []struct {
					Number int `xml:"number,attr"`
					Hits   int `xml:"hits,attr"`
				} `xml:"lines>line"`
			} `xml:"packages>package>classes>class"`
		}
		if err := xml.Unmarshal(text, &report); err != nil {
			return nil, err
		}
		for _, class := range report.Classes {
			if c.files[class.File] == nil {
				c.files[class.File] = map[int]int{}
			}
			for _, line := range class.Lines {
				c.files[class.File][line.Number] = max(c.files[class.File][line.Number], line.Hits)
			}
		}
		return c, nil
	}
	var current map[int]int
	scanner := bufio.NewScanner(bytes.NewReader(text))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if rest, ok := strings.CutPrefix(line, "SF:"); ok {
			current = map[int]int{}
			c.files[rest] = current
		} else if rest, ok := strings.CutPrefix(line, "DA:"); ok && current != nil {
			parts := strings.Split(rest, ",")
			if len(parts) >= 2 {
				number, _ := strconv.Atoi(parts[0])
				hits, _ := strconv.Atoi(parts[1])
				current[number] = hits
			}
		}
	}
	return c, nil
}

// Percent gives the covered share of a file, nil when the report does not mention it.
func (c *Coverage) Percent(file string) *float64 {
	for _, name := range sortedKeys(c.files) {
		reported := strings.ReplaceAll(name, `\`, "/")
		if strings.EqualFold(reported, file) || strings.HasSuffix(strings.ToLower(reported), "/"+strings.ToLower(file)) {
			lines := c.files[name]
			if len(lines) == 0 {
				return number(100)
			}
			covered := 0
			for _, hits := range lines {
				if hits > 0 {
					covered++
				}
			}
			return number(round(100*float64(covered)/float64(len(lines)), 4))
		}
	}
	return nil
}

// Manifest renders the manifest document.
func Manifest() ([]byte, error) {
	type ruleEntry struct {
		ID        string   `json:"id"`
		Category  string   `json:"category"`
		Paradigms []string `json:"paradigms"`
		Title     string   `json:"title"`
	}
	byID := map[string]SpecRule{}
	for _, rule := range SpecRules() {
		byID[rule.ID] = rule
	}
	rules := []ruleEntry{}
	for _, id := range Supported {
		rule := byID[id]
		rules = append(rules, ruleEntry{id, rule.Category, sortedStrings(rule.Paradigms), rule.Title})
	}
	return encode(map[string]any{
		"name": Name, "language": Language, "version": Version, "schemaVersion": manifestVersion,
		"paradigms":    []string{"functional", "oop", "structural"},
		"files":        []string{"**/*.go"},
		"capabilities": map[string]any{"semantic": true, "supportedRules": Supported, "partialAnalysis": false, "sarif": true},
		"rules":        rules,
	})
}

func sortedStrings(list []string) []string {
	result := append([]string{}, list...)
	sort.Strings(result)
	return result
}

func encode(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	err := encoder.Encode(value)
	return buffer.Bytes(), err
}

type location struct {
	File        string `json:"file"`
	StartLine   int    `json:"startLine"`
	StartColumn int    `json:"startColumn,omitempty"`
	EndLine     int    `json:"endLine,omitempty"`
	EndColumn   int    `json:"endColumn,omitempty"`
}

func toLocation(p Place) location {
	return location{p.File, p.StartLine, p.StartColumn, p.EndLine, p.EndColumn}
}

type metrics map[string]*float64

func count(v int) *float64 { return number(float64(v)) }

type categoryScore struct {
	Category     string  `json:"category"`
	Score        float64 `json:"score"`
	Weight       float64 `json:"weight"`
	Penalty      float64 `json:"penalty"`
	FindingCount int     `json:"findingCount"`
}

type health struct {
	Score       float64         `json:"score"`
	Categories  []categoryScore `json:"categories"`
	Explanation []string        `json:"explanation"`
}

type skipped struct {
	RuleID  string `json:"ruleId"`
	Module  string `json:"module,omitempty"`
	Reason  string `json:"reason"`
	Message string `json:"message"`
}

type factsFile struct {
	Path     string   `json:"path"`
	Lines    int      `json:"lines"`
	Loc      int      `json:"loc"`
	Coverage *float64 `json:"coverage,omitempty"`
	Module   string   `json:"module,omitempty"`
	Parsed   bool     `json:"parsed"`
}

type factsModule struct {
	ID               string     `json:"id"`
	Name             string     `json:"name"`
	Files            []string   `json:"files"`
	Loc              int        `json:"loc"`
	Metrics          metrics    `json:"metrics"`
	ParadigmEvidence []Evidence `json:"paradigmEvidence"`
	ActiveParadigms  []string   `json:"activeParadigms"`
	Health           *health    `json:"health,omitempty"`
}

type factsType struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Module     string   `json:"module"`
	Kind       string   `json:"kind"`
	IsAbstract bool     `json:"isAbstract"`
	Location   location `json:"location"`
	Metrics    metrics  `json:"metrics"`
}

type factsFunction struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Module     string   `json:"module"`
	Type       string   `json:"type,omitempty"`
	Kind       string   `json:"kind"`
	Visibility string   `json:"visibility"`
	Location   location `json:"location"`
	Metrics    metrics  `json:"metrics"`
}

type factsDependency struct {
	From     string    `json:"from"`
	To       string    `json:"to"`
	Kind     string    `json:"kind"`
	Phase    string    `json:"phase"`
	External bool      `json:"external"`
	Stdlib   bool      `json:"stdlib"`
	Count    int       `json:"count"`
	Location *location `json:"location,omitempty"`
}

type factsCycle struct {
	Level   string   `json:"level"`
	Members []string `json:"members"`
}

type diagnostic struct {
	Level   string `json:"level"`
	Message string `json:"message"`
	File    string `json:"file,omitempty"`
	Code    string `json:"code,omitempty"`
}

// Result is what the protocol commands write.
type Result struct {
	Facts    []byte
	Findings []Finding
	Partial  bool
}

// Options are the arguments of analyze.
type Options struct {
	Root, Sarif string
	Selected    map[string]bool
	Config      *Config
}

func (r *run) score(loc int, findings []Finding, categories []string) health {
	config := r.config.Scoring
	totalWeight := 0.0
	weight := func(category string) float64 {
		if value, ok := config.CategoryWeights[category]; ok {
			return value
		}
		return 1
	}
	for _, category := range categories {
		totalWeight += weight(category)
	}
	kloc := math.Max(float64(loc)/1000, config.MinKloc)
	result := health{Categories: []categoryScore{}, Explanation: []string{}}
	for _, category := range categories {
		penalty, own := 0.0, 0
		for _, f := range findings {
			if f.Category == category {
				own++
				penalty += config.SeverityPenalties[f.Severity] * config.ConfidenceFactors[f.Confidence]
			}
		}
		score := 100 * math.Exp(-penalty/kloc/config.DecayPerKloc)
		share := 0.0
		if totalWeight > 0 {
			share = weight(category) / totalWeight
		}
		result.Score += score * share
		result.Categories = append(result.Categories, categoryScore{category, round(score, 1), round(share, 3), round(penalty, 2), own})
	}
	result.Explanation = append(result.Explanation, fmt.Sprintf("Weighted mean over %d categories, normalized by %.3f KLOC.", len(categories), kloc))
	return result
}

// Analyze runs the detectors and builds facts; SARIF goes to the file named in the options.
func Analyze(p *Project, options Options) (*Result, error) {
	config := options.Config
	r := &run{p: p, config: config, ran: map[string]SpecRule{}, active: map[string]map[string]bool{}}
	r.edges = p.Edges()
	r.graphs = p.Build(r.edges)
	r.estimate = p.TimeEstimates()
	pure := p.PureFunctions()
	enabled := config.EnabledParadigms()
	if report, ok := config.Rules["MNT004"].Threshold["report"].(string); ok && report != "" {
		if coverage, err := LoadCoverage(filepath.Join(options.Root, report)); err == nil {
			r.coverage = coverage
		}
	}
	evidence := map[string][]Evidence{}
	shown := map[string][]string{}
	for _, m := range p.Modules {
		evidence[m.ID] = p.CollectEvidence(m, pure)
		shown[m.ID] = ActiveParadigms(evidence[m.ID])
		r.active[m.ID] = map[string]bool{}
		for _, paradigm := range shown[m.ID] {
			r.active[m.ID][paradigm] = enabled[paradigm]
		}
	}

	rules := SpecRules()
	supported := set(Supported...)
	outsidePractices := config.OutsidePractices()
	skips := []skipped{}
	categories := map[string]bool{}
	inputs := map[string]bool{"layer-config": len(config.Layers) > 0, "coverage-report": r.coverage != nil}
	for _, rule := range rules {
		if !supported[rule.ID] {
			if !strings.Contains(rule.ID, ".") {
				skips = append(skips, skipped{rule.ID, "", "not-supported", "Rule is not implemented for Go"})
			}
			continue
		}
		explicit := config.Rules[rule.ID].Enabled
		byConfig := explicit != nil && !*explicit || (options.Selected != nil && !options.Selected[rule.ID])
		// An explicit rules.<id>.enabled wins over the practices (D-051).
		practiceMessage, outside := outsidePractices[rule.ID]
		outside = outside && explicit == nil
		off := byConfig || outside
		anyEnabled := len(rule.Paradigms) == 0
		for _, paradigm := range rule.Paradigms {
			anyEnabled = anyEnabled || enabled[paradigm]
		}
		if !anyEnabled {
			skips = append(skips, skipped{rule.ID, "", "disabled-by-config", "Rule needs paradigm " + strings.Join(sortedStrings(rule.Paradigms), " or ") + ", which is off for this language; 'paradigms' in nomos.json selects them"})
		} else if byConfig {
			skips = append(skips, skipped{rule.ID, "", "disabled-by-config", "Rule is off by nomos.json or by --rules"})
		} else if outside {
			skips = append(skips, skipped{rule.ID, "", "disabled-by-config", practiceMessage})
		}
		if off || !anyEnabled {
			continue
		}
		r.rule = rule
		r.ran[rule.ID] = rule
		categories[rule.Category] = true
		detectors[rule.ID](r)
		for _, input := range rule.Requires {
			if !inputs[input] {
				skips = append(skips, skipped{rule.ID, "", "missing-input", "Rule not applied: no " + input + " in the configuration"})
			}
		}
	}
	for _, rule := range rules {
		if !supported[rule.ID] || len(rule.Paradigms) == 0 {
			continue
		}
		_, ran := r.ran[rule.ID]
		for _, m := range p.Modules {
			applies, isActive := false, false
			for _, paradigm := range rule.Paradigms {
				for _, own := range shown[m.ID] {
					if own == paradigm {
						applies = true
						isActive = isActive || enabled[paradigm]
					}
				}
			}
			if !applies {
				skips = append(skips, skipped{rule.ID, m.ID, "paradigm-not-detected", notApplicable(rule.Paradigms[0])})
			} else if ran && !isActive {
				skips = append(skips, skipped{rule.ID, m.ID, "disabled-by-config", "Rule not applied: every paradigm the module shows for it is off for this language"})
			}
		}
	}
	sort.SliceStable(skips, func(i, j int) bool {
		a, b := skips[i], skips[j]
		if a.RuleID != b.RuleID {
			return a.RuleID < b.RuleID
		}
		if a.Module != b.Module {
			return a.Module < b.Module
		}
		return a.Reason < b.Reason
	})

	byFile := map[string]*Module{}
	for _, f := range p.Files {
		byFile[f.Path] = f.Module
	}
	findings, suppressed := p.suppress(sortFindings(r.findings))
	for i := range findings {
		if findings[i].Module == "" && byFile[findings[i].Place.File] != nil {
			findings[i].Module = byFile[findings[i].Place.File].ID
		}
	}
	categoryList := sortedKeys(categories)

	files := []factsFile{}
	diagnostics := []diagnostic{}
	partial := false
	for _, f := range p.Files {
		entry := factsFile{Path: f.Path, Lines: f.Lines, Loc: f.Loc, Parsed: !f.Broken}
		if f.Module != nil {
			entry.Module = f.Module.ID
		}
		if r.coverage != nil {
			entry.Coverage = r.coverage.Percent(f.Path)
		}
		files = append(files, entry)
		if f.Broken {
			partial = true
			diagnostics = append(diagnostics, diagnostic{"warning", "Syntax errors: declarations in this file may be missing from the facts.", f.Path, "syntax-error"})
		}
	}
	if suppressed > 0 {
		diagnostics = append(diagnostics, diagnostic{"info", fmt.Sprintf("%d finding(s) suppressed by directives.", suppressed), "", "suppressed"})
	}
	if !p.Semantic {
		diagnostics = append(diagnostics, diagnostic{"warning", "The standard library could not be loaded: symbols are partly unresolved.", "", "no-stdlib"})
	}

	modules := []factsModule{}
	total, totalLoc := 0.0, 0
	for _, m := range p.Modules {
		loc := 0
		names := []string{}
		for _, f := range m.Files {
			loc += f.Loc
			names = append(names, f.Path)
		}
		sort.Strings(names)
		own := []Finding{}
		for _, f := range findings {
			if f.Module == m.ID {
				own = append(own, f)
			}
		}
		score := r.score(loc, own, categoryList)
		total += score.Score * float64(loc)
		totalLoc += loc
		shownScore := score
		shownScore.Score = round(score.Score, 1)
		ca, ce, instability, abstractness, distance := r.martin(m)
		modules = append(modules, factsModule{m.ID, m.Name, names, loc,
			metrics{"ca": count(ca), "ce": count(ce), "instability": instability, "abstractness": abstractness, "distance": distance},
			nonNil(evidence[m.ID]), nonNilStrings(shown[m.ID]), &shownScore})
	}
	projectScore := 100.0
	if totalLoc > 0 {
		projectScore = total / float64(totalLoc)
	}
	projectCategories := []categoryScore{}
	for _, category := range categoryList {
		projectCategories = append(projectCategories, r.score(max(totalLoc, 1), findingsIn(findings, category), []string{category}).Categories[0])
	}
	project := health{round(projectScore, 1), projectCategories, []string{fmt.Sprintf("Mean of %d module score(s), weighted by lines of code (%d total).", len(modules), totalLoc)}}

	document := map[string]any{
		"schemaVersion": factsVersion,
		"analyzer":      map[string]any{"name": Name, "version": Version, "language": Language, "semantic": p.Semantic},
		"files":         files, "modules": modules,
		"types": r.factsTypes(), "functions": r.factsFunctions(),
		"dependencies": r.factsDependencies(), "cycles": r.factsCycles(),
		"health": project, "skippedRules": skips, "diagnostics": diagnostics,
	}
	if options.Sarif != "" {
		text, err := r.sarif(findings)
		if err != nil {
			return nil, err
		}
		if err := os.WriteFile(options.Sarif, text, 0o644); err != nil {
			return nil, err
		}
		document["checks"] = map[string]any{"sarifFile": options.Sarif, "resultCount": len(findings)}
	}
	text, err := encode(document)
	return &Result{text, findings, partial}, err
}

func findingsIn(list []Finding, category string) []Finding {
	own := []Finding{}
	for _, f := range list {
		if f.Category == category {
			own = append(own, f)
		}
	}
	return own
}

func nonNil(list []Evidence) []Evidence {
	if list == nil {
		return []Evidence{}
	}
	return list
}

func nonNilStrings(list []string) []string {
	if list == nil {
		return []string{}
	}
	return list
}

func notApplicable(paradigm string) string {
	switch paradigm {
	case "oop":
		return "OOP rule not applicable: module has no classes"
	case "functional":
		return "Functional rule not applicable: module shows no functional style"
	case "structural":
		return "Structural rule not applicable: module has no free functions or branching"
	}
	return "Rule for paradigm '" + paradigm + "' not applicable: no evidence of it in the module"
}

func (r *run) factsTypes() []factsType {
	list := []factsType{}
	for _, t := range r.p.AllTypes() {
		values := metrics{
			"lines": count(lineSpan(t.Place)), "memberCount": count(t.FieldCount + len(t.Methods)), "methodCount": count(len(t.Methods)),
			"blastRadius": count(r.graphs.Radius[t.ID]),
		}
		if t.Kind == "struct" {
			values["dit"] = count(r.p.DIT(t, nil))
			values["cbo"] = count(r.cbo(t))
			values["lcom4"] = r.p.LCOM4(t)
			values["wmc"] = count(WMC(t))
			values["atfd"] = count(r.p.ATFD(t))
			values["tcc"] = r.p.TCC(t)
		}
		list = append(list, factsType{t.ID, t.Name, t.Module.ID, t.Kind, t.IsAbstract(), toLocation(t.Place), values})
	}
	return list
}

func (r *run) factsFunctions() []factsFunction {
	list := []factsFunction{}
	for _, f := range r.p.AllFunctions() {
		values := metrics{
			"cyclomatic": count(Cyclomatic(f)), "maxNesting": count(MaxNesting(f)), "parameterCount": count(ParameterCount(f.Sig)), "lines": count(lineSpan(f.Place)),
			"hofOrder": count(HofOrder(f)), "lambdaNesting": count(LambdaNesting(f)), "typeTests": count(len(r.p.TestedTypes(f))),
			"blastRadius": count(r.graphs.Radius[f.Unit()]),
			"timeDegree":  nil, "timeLogFactor": nil, "timeExponential": nil, "spaceDegree": nil, "allocationDepth": nil, "foreignMembers": nil, "ownMembers": nil,
		}
		if volume := HalsteadVolume(f); volume != nil {
			values["halsteadVolume"] = number(round(*volume, 4))
			values["maintainabilityIndex"] = number(round(*MaintainabilityIndex(f), 4))
		} else {
			values["halsteadVolume"], values["maintainabilityIndex"] = nil, nil
		}
		if growth, ok := r.estimate[f.ID]; ok {
			values["timeExponential"] = count(0)
			if growth.Exponential {
				values["timeExponential"] = count(1)
			} else {
				values["timeDegree"], values["timeLogFactor"] = count(growth.Degree), count(growth.Log)
			}
			values["spaceDegree"] = count(r.p.SpaceDegree(f))
			values["allocationDepth"] = count(r.p.AllocationDepth(f))
		}
		if isMethod(f) {
			own, _ := r.p.memberUse(f)
			_, members := r.p.MostUsedForeign(f)
			values["foreignMembers"], values["ownMembers"] = count(len(members)), count(len(own))
		}
		kind, owner, visibility := "function", "", "internal"
		if f.Owner != nil {
			kind, owner = "method", f.Owner.ID
		}
		if exported(f.Name) {
			visibility = "public"
		}
		list = append(list, factsFunction{f.ID, f.Name, f.Module.ID, owner, kind, visibility, toLocation(f.Place), values})
	}
	return list
}

func (r *run) factsDependencies() []factsDependency {
	merged := map[string]*factsDependency{}
	for _, e := range r.edges {
		key := e.From + "\x00" + e.To + "\x00" + e.Kind
		if seen := merged[key]; seen != nil {
			seen.Count++
			continue
		}
		place := toLocation(e.Place)
		merged[key] = &factsDependency{e.From, e.To, e.Kind, "runtime", e.External, e.Stdlib, 1, &place}
	}
	list := []factsDependency{}
	for _, key := range sortedKeys(merged) {
		list = append(list, *merged[key])
	}
	return list
}

func (r *run) factsCycles() []factsCycle {
	list := []factsCycle{}
	for _, members := range Components(r.graphs.Units) {
		list = append(list, factsCycle{"type", members})
	}
	for _, members := range Components(r.graphs.Modules) {
		list = append(list, factsCycle{"module", members})
	}
	return list
}

func level(severity string) string {
	switch severity {
	case "critical":
		return "error"
	case "info":
		return "note"
	}
	return "warning"
}

func (r *run) sarif(findings []Finding) ([]byte, error) {
	byID := map[string]SpecRule{}
	for _, rule := range SpecRules() {
		byID[rule.ID] = rule
	}
	ids := sortedStrings(Supported)
	index := map[string]int{}
	rules := []map[string]any{}
	for i, id := range ids {
		index[id] = i
		rule := byID[id]
		entry := map[string]any{
			"id": id, "name": rule.Title, "shortDescription": map[string]string{"text": rule.Description}, "fullDescription": map[string]string{"text": rule.Rationale},
			"defaultConfiguration": map[string]string{"level": level(rule.Severity)},
			"properties":           map[string]any{"category": rule.Category, "paradigms": sortedStrings(rule.Paradigms)},
		}
		if len(rule.Messages) > 0 {
			templates := map[string]map[string]string{}
			for key, message := range rule.Messages {
				templates[key] = map[string]string{"text": message.Text}
			}
			entry["messageStrings"] = templates
		}
		rules = append(rules, entry)
	}
	// key finds the spec template a text was made from (spec/l10n.md); the first key in order wins.
	key := func(rule string, text Text) string {
		keys := []string{}
		for k, message := range byID[rule].Messages {
			if message.Text == text.Template {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		if len(keys) == 0 {
			return ""
		}
		return keys[0]
	}
	results := []map[string]any{}
	for _, f := range findings {
		properties := map[string]any{"severity": f.Severity, "confidence": f.Confidence, "explanation": f.Explanation}
		if f.Module != "" {
			properties["module"] = f.Module
		}
		if f.Entity != "" {
			properties["entity"] = f.Entity
		}
		if f.Measured != nil {
			properties["measured"] = f.Measured
		}
		if id := key(f.Rule, f.ExplanationText); id != "" {
			properties["explanationMessage"] = map[string]any{"id": id, "arguments": f.ExplanationText.Args}
		}
		message := map[string]any{"text": f.Message}
		if id := key(f.Rule, f.MessageText); id != "" {
			message["id"], message["arguments"] = id, f.MessageText.Args
		}
		results = append(results, map[string]any{
			"ruleId": f.Rule, "ruleIndex": index[f.Rule], "level": level(f.Severity), "message": message,
			"locations": []map[string]any{{"physicalLocation": map[string]any{
				"artifactLocation": map[string]string{"uri": f.Place.File},
				"region":           map[string]int{"startLine": f.Place.StartLine, "startColumn": f.Place.StartColumn, "endLine": f.Place.EndLine, "endColumn": f.Place.EndColumn},
			}}},
			"partialFingerprints": map[string]string{"nomos/v1": f.Fingerprint()},
			"properties":          properties,
		})
	}
	return encode(map[string]any{
		"$schema": "https://json.schemastore.org/sarif-2.1.0.json", "version": "2.1.0",
		"runs": []map[string]any{{
			"tool":    map[string]any{"driver": map[string]any{"name": Name, "version": Version, "semanticVersion": Version, "rules": rules}},
			"results": results,
		}},
	})
}
