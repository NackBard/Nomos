# Adding an analyzer for a new language

**English** · [Русский](EXTENDING.ru.md)

Adding a language does not change `extension/`, the existing contracts or other analyzers. All it takes is a standalone program that speaks the protocol and passes conformance.

An earlier version of this document described extending the .NET core through `[Analyzer]` and `ILanguageAdapter`; it is obsolete (D-020).

## Steps

1. **Choose the language's own tools.** Python — `ast` and `tokenize`, TypeScript — the TS compiler, Go — `go/parser` and `go/types`, Kotlin — PSI from the Kotlin compiler, Ruby — Prism from the standard library, and so on. The analyzer is written in the language itself or in the one whose parsing tools are native to it; accuracy follows from this choice.

2. **Create `analyzers/<language>/`** with an executable entry point that supports:
   - `manifest` — prints the manifest (`contracts/manifest.schema.json`);
   - `analyze --root <path> [--files <list>] [--sarif <file>] [--config <nomos.json>] [--rules <ids>]` — prints facts (`contracts/facts.schema.json`).
   The exit codes are in [ARCHITECTURE](ARCHITECTURE.md#exit-codes).

3. **Define the language's module.** For C# it is a namespace, for Python a package or a file, for TypeScript a file or a folder. The choice is recorded as a decision: Ca, Ce and cycles depend on it.

4. **Declare paradigms and evidence.** `manifest.paradigms` is what the language supports; facts carry `paradigmEvidence` and `activeParadigms` for each module by `spec/paradigms.md`. If the language brings a new paradigm, add it to `spec/paradigms.md` first.

5. **Choose the rules.** Implement only the rules of `spec/rules/*.yaml` you can do reliably, and list them in `capabilities.supportedRules`. The rest get `skippedRules` with the reason `not-supported`. Rules specific to this language go to `spec/rules/<language>.yaml` with a prefix (`PY.`, `TS.`).

6. **Compute the metrics by `spec/metrics.md`.** Do not invent formulas to suit the language. If a formula does not fit the language, that is a proposal to change the spec, not a local deviation.

   The structure of types follows `spec/structure.md`: `members`, `typeParameters`, `parameters`, `returnTypeName`, `isStatic`, `isAbstract`, and `satisfies` for structural typing. The class diagram is built from them; the `type-structure` case checks them in every language.

   The rule texts are needed in the analyzer's build. If the language's tools cannot read YAML, generate JSON from `spec/rules`, as Go does (`npm run spec-json`); `npm run validate` checks that it is up to date.

   `nomos-disable` directives follow `spec/suppressions.md`.

   The `practices` field of `--config` (D-051): a rule outside the chosen practices of `spec/practices.yaml` does not run and gets `skippedRules` with the reason `disabled-by-config` and the same message as in C# and Go; an explicit `rules.<id>.enabled` is stronger than a practice, and an unknown practice is exit code 3. The catalog comes from the JSON of `npm run spec-json` if the language's tools cannot read YAML. A new language rule (`spec/rules/<language>.yaml`) goes into at least one practice, or `npm run validate` fails.

7. **Write results as SARIF** by `contracts/sarif-profile.md`: `confidence` and an explanation are required for every result. There are no acceptance thresholds and no "failure". Every finding text is a `messages` template of its rule in the spec, with arguments (`spec/l10n.md`): SARIF carries `message.id`, `message.arguments` and `properties.explanationMessage`. A new text goes into the spec first, together with its Russian translation; arguments hold no English words. The analyzer's test reads the texts from its sources and checks them against the spec, like `MessageTemplateTests` in C# and `TestTemplatesAreInSpec` in Go.

8. **Pass conformance.** Add sources in your language to every case in `conformance/cases/*`, with a reference computed by hand: `<case>/<language>/src`, `expected.facts.json`, and with `config` and `expectSarif` also `nomos.json` and `expected.sarif.json`. A language a case does not apply to is listed in `exceptions` of `case.json` with a reason; without the entry the case fails. Add the analyzer to `npm run all` and add `parity` to the cases where the numbers must match between languages.

9. **Register the analyzer** in `nomos.json`. The command runs from the folder of `nomos.json`, and the `--sarif` path is relative to it too, so it is better not to set `cwd`:

```json
{ "language": "go", "command": ["go", "run", "nomos/analyzers/go/cmd/nomos-go"], "exclude": ["conformance/**"] }
```

For the analyzer to reach the published extension and work in folders without `nomos.json` (D-046), declare `files` in the manifest — the patterns of the files it reads (`["**/*.go"]`) — and add its build to `extension/scripts/package.mjs`: a binary for the target platform in `bundle/<language>/` and an entry in `analyzers.json` with `files` from the manifest. The analyzer must work without `--config`.

- An analyzer in JavaScript runs on `${node}`, the Node of VS Code itself (as `analyzers/typescript` does, D-055).
- If it needs a runtime that another VS Code extension installs, describe it in the `runtime` field of the entry.
- A runtime that may also be in `PATH` (an interpreter) uses the `path`, `check` and `installUrl` fields, as `analyzers/python` (D-057) and `analyzers/ruby` (D-061) do.
- A runtime whose folder is named by VS Code settings or environment variables (a JDK) uses the `settings`, `environment` and `home` fields, as `analyzers/java` (D-058) and `analyzers/kotlin` (D-059) do.
- A large native dependency that is not in the repository (the Kotlin compiler) is pinned by version and checksums in a file of the analyzer and fetched by a separate command, like `analyzers/kotlin/deps.json` and `run.mjs --fetch`.

10. **Record the decisions** in a new file `docs/decisions/D-0xx.md` and a line in `docs/DECISIONS.md`: the choice of module, the limits of support, the differences.

## Readiness checklist

- [ ] `manifest` and `analyze` are valid against the schemas, the manifest has `files`;
- [ ] the output is deterministic (two runs are byte for byte equal);
- [ ] no absolute paths, no time, no random identifiers;
- [ ] the exit code does not depend on the number of findings;
- [ ] every finding text is a spec template with a Russian translation, and every result has `message.id` and `explanationMessage` (the harness checks this);
- [ ] `practices` from `--config` turns off the rules outside the chosen practices (the `practices` case);
- [ ] every conformance case passes or has a recorded exception;
- [ ] `extension/` has not changed.

## Adding a rule

1. Add an entry to the right `spec/rules/*.yaml` (fields in `contracts/rule.schema.json`): id, category, description, rationale, paradigms, severity, default threshold.
2. Implement the detector in the analyzers that can do it; add the id to their `supportedRules`.
3. Add a conformance case if the rule relies on a metric that facts do not have yet.
4. If the rule needs a new field in facts, that is a change of a contract (see "Contracts" in [ARCHITECTURE](ARCHITECTURE.md#contracts)).

## Adding a metric

1. Describe the formula in `spec/metrics.md`: definition, edge cases (`null`), tolerance.
2. An entity metric is any numeric field of `metrics`; the schema does not change. A new field outside `metrics` is a minor version of the contract and a decision.
3. Implement it in every analyzer and add a conformance case and `parity`.
