// Command nomos-go is the Go analyzer of Nomos. It speaks the protocol of docs/ARCHITECTURE.md:
// facts go to stdout, SARIF to the file named by --sarif, messages for people to stderr.
package main

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"nomos/analyzers/go/internal/analyzer"
)

const (
	success    = 0
	unexpected = 1
	usageError = 2
	badInput   = 3
	partial    = 4
)

func usage(message string) int {
	fmt.Fprintf(os.Stderr, "%s\nUsage: %s manifest | analyze --root <path> [--sarif <file>] [--config <nomos.json>] [--rules <ids>]\n", message, analyzer.Name)
	return usageError
}

func analyze(args []string) int {
	var root, sarif, config, rules string
	for i := 0; i < len(args); i += 2 {
		if i+1 >= len(args) {
			return usage("Missing value for " + args[i])
		}
		value := args[i+1]
		switch args[i] {
		case "--root":
			root = value
		case "--sarif":
			sarif = value
		case "--config":
			config = value
		case "--rules":
			rules = value
		case "--files": // this analyzer always reads the whole root (partialAnalysis = false)
		default:
			return usage("Unknown option: " + args[i])
		}
	}
	if root == "" {
		return usage("--root is required")
	}
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		fmt.Fprintln(os.Stderr, "error: root does not exist:", root)
		return badInput
	}
	settings, err := analyzer.LoadConfig(config)
	var input analyzer.ConfigError
	if errors.As(err, &input) {
		fmt.Fprintln(os.Stderr, "error:", err)
		return badInput
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return unexpected
	}
	var selected map[string]bool
	if rules != "" {
		selected = map[string]bool{}
		known := map[string]bool{}
		for _, id := range analyzer.Supported {
			known[id] = true
		}
		for _, id := range strings.Split(rules, ",") {
			id = strings.TrimSpace(id)
			if !known[id] {
				return usage("Unknown rule: " + id)
			}
			selected[id] = true
		}
	}
	include, exclude := settings.Scope()
	project, err := analyzer.Load(root, include, exclude)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return unexpected
	}
	if len(project.Files) == 0 {
		fmt.Fprintln(os.Stderr, "error: no Go files under", root)
		return badInput
	}
	result, err := analyzer.Analyze(project, analyzer.Options{Root: root, Sarif: sarif, Selected: selected, Config: settings})
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		return unexpected
	}
	os.Stdout.Write(result.Facts)
	if result.Partial {
		return partial // findings never change the exit code, only an incomplete result does
	}
	return success
}

func main() {
	args := os.Args[1:]
	switch {
	case len(args) == 1 && args[0] == "manifest":
		text, err := analyzer.Manifest()
		if err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(unexpected)
		}
		os.Stdout.Write(text)
	case len(args) >= 1 && args[0] == "analyze":
		os.Exit(analyze(args[1:]))
	default:
		os.Exit(usage("Unknown command or option: " + strings.Join(args, " ")))
	}
}
