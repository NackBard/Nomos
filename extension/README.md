# Nomos

Statistics and observations about your code: metrics per function, type and module, a dependency graph, paradigm evidence, and heuristic findings. Nothing here is a verdict: there are no scores to pass and no thresholds to fail. Every finding states its confidence and why it was raised.

## Use

Open the Nomos icon in the activity bar. The extension looks at the folder, starts the bundled analyzers whose files it finds, and shows:

- findings in the Problems panel and in the side bar, grouped by module;
- metrics above declarations (CodeLens);
- the dependency graph next to the code: modules by dependency depth, types of the selected module;
- which paradigms each module shows and which rules were skipped, with the reason.

`Nomos: Analyze Workspace` runs the analysis again. `nomos.analyzeOnSave` runs it after each save.

## Languages

C# and Go analyzers ship inside the extension. The C# analyzer needs the .NET runtime; the extension offers to install the .NET Install Tool, which downloads it once.

## Configuration

A `nomos.json` in the folder root replaces the defaults: which analyzers run and how, rule overrides, layers, paradigms. Without it every bundled analyzer runs with its default settings.
