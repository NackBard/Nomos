# Nomos

Nomos shows statistics and observations about your code: metrics per function, type and module, a dependency graph, a class diagram, paradigm evidence, and heuristic findings.

Nothing here is a verdict. There are no scores to pass and no thresholds to fail. Every finding states its confidence and why it was raised.

## Features

Open the Nomos icon in the activity bar and press **Analyze** on its title. Nothing runs before that. The extension looks at the folder, starts the analyzers for the languages whose files it finds, and shows:

- **Findings** in the side bar, grouped by module, and as faint hints in the editor. `nomos.diagnostics` turns them into underlines in the Problems panel or hides them.
- **Metrics** above declarations (CodeLens).
- **Dependency graph** next to the code, from its button on the side bar: modules by dependency depth, types of the selected module.
- **Class diagram** of the selected module, exportable.
- **Paradigms and skipped rules** for each module, with the reason a rule was skipped.

The gear on the side bar (`Nomos: Settings`) turns the metrics above the code on and off, sets how findings look in the editor and whether a save runs the analysis, and leads to the practices and to all Nomos settings.

`Nomos: Analyze Workspace` runs the analysis too. After the first analysis it runs again by itself only when you change the practices or the language packs; `nomos.analyzeOnSave` (off by default) runs it after each save.

## Languages

Analyzers for each language come in their own language pack, so you install only what your project uses:

| Pack | Language | Needs on your machine |
|---|---|---|
| `nomos-csharp` | C# | .NET runtime |
| `nomos-go` | Go | nothing (a binary for your platform) |
| `nomos-typescript` | TypeScript, JavaScript | nothing beyond VS Code |
| `nomos-python` | Python | Python 3.10 or newer |
| `nomos-java` | Java | JDK 17 or newer |
| `nomos-kotlin` | Kotlin | JDK 17 or newer |
| `nomos-ruby` | Ruby | Ruby |

If the folder has files of a language whose pack is not installed, Nomos offers to install the pack. The status bar says when there is nothing to analyze.

## Configuration

Without a `nomos.json` in the folder root, every installed analyzer runs with its default settings.

A `nomos.json` in the folder root replaces the defaults: which analyzers run and how, rule overrides, layers, paradigms.

Settings without `nomos.json` are in the VS Code settings under `nomos.*`.

## Requirements and limits

- The interface is Russian or English, following VS Code's language.
- Findings are heuristics. They are a starting point for your own reading of the code, not a quality gate.

## Links

- Source and documentation: https://github.com/NackBard/Nomos
- License: MIT
