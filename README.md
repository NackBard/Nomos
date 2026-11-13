# Nomos

**English** · [Русский](README.ru.md)

**Static inspection of code: statistics and observations, without verdicts.**

Dependencies, metrics, algorithmic complexity, paradigms, patterns, clean code and basic security for **C#, Go, TypeScript, JavaScript, Python, Java, Kotlin and Ruby**.

Every result is a heuristic. Each finding states how confident it is and why it was raised. Nomos gives statistics for a developer to read: there are no acceptance thresholds, no grades and no exit codes that depend on the number of findings.

![The dependency graph of the Nomos Score modules, drawn by Nomos](docs/images/graph-modules.png)

## VS Code extensions

| Extension | What it does |
|---|---|
| [**Nomos**](https://marketplace.visualstudio.com/items?itemName=honestarchitector.nomos) | The core: findings, metrics above the code, the dependency graph, class diagrams, paradigms; English and Russian interface |
| **Nomos: C#**, **Go**, **TypeScript and JavaScript**, **Python**, **Java**, **Kotlin**, **Ruby** | Language packs, one analyzer per language. The core offers the pack your project needs |
| [**Nomos Score**](https://marketplace.visualstudio.com/items?itemName=honestarchitector.nomos-score) | Scores from 0 to 100 with what each is made of, and dashboards of the system and of each module |
| [**Nomos Agents**](https://marketplace.visualstudio.com/items?itemName=honestarchitector.nomos-agents) (preview) | AI agents that review paradigms, practices and the speed of functions; an MCP server over the analysis |

<table>
<tr>
<td width="50%"><img src="docs/images/class-diagram.png" alt="A class diagram of one module"><br><sub>A class diagram of one module</sub></td>
<td width="50%"><img src="docs/images/score-system.png" alt="The system dashboard of Nomos Score"><br><sub>Nomos Score: scores and key problems</sub></td>
</tr>
</table>

## Parts

Nomos ships in three parts (D-056, D-062):

- **The core**, the VS Code extension in `extension/`: the tree, the graph, the class diagram, findings, settings, localization. It knows no language.
- **The rule catalog**, `rules.json` and `practices.json`, built from `spec/`. It ships inside the core.
- **Language analyzers**, `analyzers/<language>/`, each built on the language's own tools. They ship as separate packs: `nomos-csharp`, `nomos-go`, `nomos-typescript` (TypeScript and JavaScript), `nomos-python`, `nomos-java`, `nomos-kotlin`, `nomos-ruby`.

The shared `contracts/` (data formats), `spec/` (formulas, rules, paradigms) and `conformance/` (reference cases every analyzer passes) are one law for all languages.

Next to them are `score/` (Nomos Score, D-065), `agents/` (Nomos Agents and the MCP server, D-063) and `ci/` (`nomos-ci` for pipelines).

### Documentation

Each of these documents has a Russian copy next to it (`.ru.md`). The working documents (the specifications in `spec/`, the decisions and the roadmap) are in Russian only.

| | |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | how the core, the analyzers and the contracts fit together |
| [Adding a language](docs/EXTENDING.md) | a new analyzer from the manifest to the pack |
| [Rule catalog](docs/ANALYZERS.md) | every rule and practice, generated from `spec/` |
| [Conformance](conformance/README.md) | the reference cases every analyzer passes |
| [Translating](docs/TRANSLATING.md) | how to add an interface language |
| [Decision log](docs/DECISIONS.md) | the list of decisions; the decisions themselves are in [docs/decisions](docs/decisions/) |
| [Roadmap](docs/ROADMAP.md) | stages; what is done is in [roadmap-done](docs/roadmap-done.md) |

## Build and check

The extension and the packs are built from `extension/`:

```powershell
cd extension
npm install
npm test                                # the core without VS Code
npm run check-boundary                  # no language-specific code in the core
npm run package -- --target win32-x64   # dist/: the core and the language packs
```

The C# analyzer (needs the .NET 10 SDK):

```powershell
cd analyzers/csharp
dotnet build Nomos.slnx
dotnet test Nomos.slnx
dotnet run --project src/Nomos.Analyzer.CSharp -- manifest
dotnet run --project src/Nomos.Analyzer.CSharp -- analyze --root tests/fixtures/golden/sample-project --sarif nomos.sarif > facts.json
```

Facts go to stdout, findings to the SARIF file.

Conformance runs every analyzer on the same cases:

```powershell
cd conformance/runner
npm install
npm run all
```

More on the harness and its commands is in [conformance/README.md](conformance/README.md).

## Analyzer protocol

```
nomos-<language> manifest
nomos-<language> analyze --root <path> [--sarif <file>] [--config <nomos.json>] [--rules <id,id>]
```

| Exit code | Meaning |
|---|---|
| 0 | success |
| 1 | unexpected error |
| 2 | usage error |
| 3 | the input is not usable |
| 4 | partial result |

The number of findings and the scores do not affect the exit code.

## License

[MIT](LICENSE). The Marketplace publisher is `honestarchitector`.
