package analyzer

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
)

// SpecRule is one rule of spec/rules; rules.json is generated from them (npm run go-rules in conformance/runner).
type SpecRule struct {
	ID          string         `json:"id"`
	Category    string         `json:"category"`
	Title       string         `json:"title"`
	Description string         `json:"description"`
	Rationale   string         `json:"rationale"`
	Paradigms   []string       `json:"paradigms"`
	Severity    string         `json:"severity"`
	Confidence  string         `json:"confidence"`
	Threshold   map[string]any `json:"threshold"`
	Requires    []string       `json:"requires"`
}

//go:embed rules.json
var rulesFile []byte

// SpecRules reads the embedded rules.
func SpecRules() []SpecRule {
	var rules []SpecRule
	if err := json.Unmarshal(rulesFile, &rules); err != nil {
		panic(err)
	}
	return rules
}

// RuleConfig is an entry of rules in the workspace file.
type RuleConfig struct {
	Enabled   *bool          `json:"enabled"`
	Severity  string         `json:"severity"`
	Threshold map[string]any `json:"threshold"`
}

// Layer is an entry of layers in the workspace file.
type Layer struct {
	Name        string   `json:"name"`
	Patterns    []string `json:"patterns"`
	MayDependOn []string `json:"mayDependOn"`
}

// Scoring holds the parameters of the health score with the defaults of spec/metrics.md.
type Scoring struct {
	CategoryWeights   map[string]float64 `json:"categoryWeights"`
	SeverityPenalties map[string]float64 `json:"severityPenalties"`
	ConfidenceFactors map[string]float64 `json:"confidenceFactors"`
	DecayPerKloc      float64            `json:"decayPerKloc"`
	MinKloc           float64            `json:"minKloc"`
}

// Config is the part of the workspace file this analyzer reads.
type Config struct {
	Analyzers []struct {
		Language string   `json:"language"`
		Include  []string `json:"include"`
		Exclude  []string `json:"exclude"`
	} `json:"analyzers"`
	SchemaVersion string                `json:"schemaVersion"`
	Rules         map[string]RuleConfig `json:"rules"`
	Paradigms     map[string][]string   `json:"paradigms"`
	Layers        []Layer               `json:"layers"`
	Scoring       Scoring               `json:"scoring"`
}

// ConfigError means the input is unusable: exit code 3.
type ConfigError struct{ Message string }

func (e ConfigError) Error() string { return e.Message }

// LoadConfig reads the file named by --config; an empty path gives the defaults.
func LoadConfig(path string) (*Config, error) {
	config := &Config{}
	if path != "" {
		text, err := os.ReadFile(path)
		if err != nil {
			return nil, ConfigError{fmt.Sprintf("config file not found: %s", path)}
		}
		if err := json.Unmarshal(text, config); err != nil {
			return nil, ConfigError{fmt.Sprintf("%s: %v", path, err)}
		}
		if !strings.HasPrefix(config.SchemaVersion, "1.") {
			return nil, ConfigError{fmt.Sprintf("%s: expected schemaVersion 1.x, found '%s'", path, config.SchemaVersion)}
		}
	}
	fill := func(target *map[string]float64, defaults map[string]float64) {
		if *target == nil {
			*target = map[string]float64{}
		}
		for key, value := range defaults {
			if _, set := (*target)[key]; !set {
				(*target)[key] = value
			}
		}
	}
	fill(&config.Scoring.SeverityPenalties, map[string]float64{"info": 0, "minor": 1, "major": 3, "critical": 8})
	fill(&config.Scoring.ConfidenceFactors, map[string]float64{"low": 0.25, "medium": 0.6, "high": 1})
	if config.Scoring.DecayPerKloc == 0 {
		config.Scoring.DecayPerKloc = 20
	}
	if config.Scoring.MinKloc == 0 {
		config.Scoring.MinKloc = 0.2
	}
	return config, nil
}

// EnabledParadigms follows D-011: the functional style is opt-in, like in the C# analyzer.
func (c *Config) EnabledParadigms() map[string]bool {
	if own, ok := c.Paradigms[Language]; ok {
		return set(own...)
	}
	return set("oop", "structural")
}

// Scope returns the include and exclude globs of this language.
func (c *Config) Scope() (include, exclude []string) {
	for _, a := range c.Analyzers {
		if a.Language == Language {
			return a.Include, a.Exclude
		}
	}
	return nil, nil
}

func (c *Config) threshold(rule SpecRule, name string) any {
	if value, ok := c.Rules[rule.ID].Threshold[name]; ok {
		return value
	}
	return rule.Threshold[name]
}

func (c *Config) number(rule SpecRule, name string) float64 {
	value, _ := c.threshold(rule, name).(float64)
	return value
}

func (c *Config) layerOf(module string) *Layer {
	for i := range c.Layers {
		for _, pattern := range c.Layers[i].Patterns {
			parts := strings.Split(pattern, "*")
			for j := range parts {
				parts[j] = regexp.QuoteMeta(parts[j])
			}
			if matched, _ := regexp.MatchString("(?i)^"+strings.Join(parts, ".*")+"$", module); matched {
				return &c.Layers[i]
			}
		}
	}
	return nil
}
