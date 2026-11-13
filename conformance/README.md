# Conformance

**English** · [Русский](README.ru.md)

The analyzers are written independently, in different languages. For the same metrics to stay the same, every analyzer must pass these tests. Without them, the formulas repeated across languages would drift apart unnoticed.

## Layout

```
conformance/
  README.md
  runner/                          # the harness: runs the analyzers, compares, checks schemas
  cases/
    <case-id>/
      case.json                    # contracts/conformance-case.schema.json
      <language>/
        src/                       # sources in this language
        expected.facts.json        # the expected facts, checked against contracts/facts.schema.json
        expected.sarif.json        # only with case.json: expectSarif = true
        nomos.json                 # only with case.json: config = true, passed as --config
```

One case is one scenario, written in every language with the same shape: the same modules, the same dependencies, the same branches. The sources are written so that the expected numbers match between languages; where a language makes a difference (for example, `object` as the root), it is described in `case.json` and in that language's `expected.facts.json`.

## What the harness checks

1. `<analyzer> manifest` matches `manifest.schema.json`; the set of `rules[].id` equals `capabilities.supportedRules`; every id exists in `spec/rules` or has the language's prefix.
2. `<analyzer> analyze --root cases/<id>/<language>/src` gives a document valid against `facts.schema.json`.
3. The actual facts match `expected.facts.json`: entities are matched by `id`, metrics within the tolerances of `case.json` (`spec/metrics.md`, "Tolerances"). Extra entities are an error, missing ones are an error. The order of arrays is not compared, but the output must be deterministic (two runs are byte for byte equal).
4. For each `parity` item, the metric's value is the same in all the listed languages.
5. SARIF is checked against the profile (`contracts/sarif-profile.md`) for each case; the official SARIF 2.1.0 schema is checked if it was downloaded by `npm run fetch-sarif-schema` (there is no copy in the repository, D-029). With `expectSarif`, the set of `(ruleId, file, startLine)` of the rules in `covers` equals the reference `expected.sarif.json` of the form `{ "results": [{ "ruleId": "CC001", "file": "A.cs", "startLine": 12 }] }`; results of other rules are not compared. An entry may hold `measured`, and then `{ metric, value, threshold }` is compared exactly.
   The manifest is checked against the spec: the paradigms and the category of each shared rule equal its entry in `spec/rules`.
6. Applicability: `activeParadigms` follow from the evidence marked "yes" in the tables of `spec/paradigms.md`; a rule without an active paradigm has a `paradigm-not-detected` entry, and a rule with one does not.
7. External inputs: a rule with `requires` in `spec/rules` whose input is missing from the case's `nomos.json` has a `missing-input` entry, and a rule with the input does not.

## Running

```powershell
cd conformance/runner
npm install
npm run validate     # contracts, spec/rules, the cases and their references
npm test             # self-test of the comparison
npm run selftest     # an echo analyzer: the harness's success path
npm run rules-doc    # rebuild docs/ANALYZERS.md and docs/ANALYZERS.ru.md from spec/rules
npm run spec-json    # rebuild rules.json and practices.json of the analyzers that read JSON
npm run csharp       # the built C# analyzer: dotnet build analyzers/csharp/Nomos.slnx, then every case
npm run go           # build and every case for Go
npm run typescript   # every case for TypeScript and JavaScript (one analyzer, two languages)
npm run python       # every case for Python; analyzers/python/run.mjs finds 3.10+ (NOMOS_PYTHON, python3, python, py)
npm run java         # every case for Java; analyzers/java/run.mjs finds JDK 17+ (NOMOS_JAVA, JAVA_HOME, java)
npm run kotlin       # every case for Kotlin; first node analyzers/kotlin/run.mjs --fetch (the compiler jars), Java 17+ as for Java
npm run ruby         # every case for Ruby; analyzers/ruby/run.mjs finds Ruby 3.3+ (NOMOS_RUBY, ruby)
npm run all          # every analyzer and the parity between them
node src/cli.ts run --analyzer "csharp=<command>" [--case cycles]
```

The comparison rules and the accepted limits of the cases are in D-026. The harness's exit code (0/1) is about the harness itself; it does not affect the analyzers' exit codes.

## The cases

Every case below is ready; the references were computed by hand.

The analyzer's exit code in `run` is not set in `case.json`: it follows from the reference. If `expected.facts.json` has a file with `parsed: false`, code 4 (partial result) is expected, otherwise 0.

| Case | What it covers |
|---|---|
| `metrics-basic` | `lines`, `loc`, `parameterCount`, `cyclomatic`, `maxNesting` on functions of known structure |
| `coupling-martin` | `ca`, `ce`, `instability`, `abstractness`, `distance` on three modules |
| `cycles` | `cycles` at the type and module levels on a simple graph |
| `cycles-complex` | components on complex graphs: shared vertices, a chord, a one-way bridge, a module cycle without a type cycle; DSN002 |
| `oop-cohesion` | `dit`, `cbo`, `lcom4`, `wmc`, `atfd`, `tcc` |
| `blast-radius` | `blastRadius` on a chain, a diamond and a ring with a tail; a function inherits its type's value; DSN006, the `missing-input` entry of DSN003 |
| `layers` | DSN003 through `nomos.json` |
| `design-smells` | DSN004, DSN005, `foreignMembers`, `ownMembers` |
| `complexity-estimates` | `timeDegree`, `timeLogFactor`, `timeExponential`, `spaceDegree`, `allocationDepth`; ALG001, ALG003, ALG004 and their `measured` |
| `paradigm-evidence` | the `oop.*`, `fp.*`, `str.*` evidence; a `paradigm-not-detected` entry for a module without classes |
| `paradigm-activation` | exact `activeParadigms`: lambdas and global state alone activate nothing; `disabled-by-config`; `hofOrder`, `lambdaNesting`, `typeTests`, `measured` of OOP003 |
| `health` | the health score: normalized by `loc`, not physical lines; module weighting |
| `patterns` | PAT001–PAT007, PAT101–PAT103, `settableProperties`, `forwardingMethods` |
| `security-heuristics` | SEC001–SEC003 and harmless look-alikes of their patterns |
| `suppressions` | the directives of `spec/suppressions.md`; suppressed results do not reach SARIF, metrics stay |
| `maintainability` | `halsteadVolume`, `maintainabilityIndex`, `coverage`; MNT002–MNT004 |
| `partial-failure` | a file with a syntax error: exit code 4, `parsed: false`, `diagnostics` |

## Adding a case

1. Create `cases/<id>/case.json` and list the languages.
2. Write the sources for **every** language that already exists. A case only one language passes is not a conformance case.
3. Compute `expected.facts.json` by hand from `spec/metrics.md` and check it by eye. A reference must not be generated from the output of the analyzer under test: the test would then confirm itself.
4. Run the harness for every analyzer.

## A new language

An analyzer for a new language is ready to join when it passes every existing case. If a case cannot be expressed by the nature of the language, `exceptions` in `case.json` records the language and the reason; a case without sources and without such an entry fails.
