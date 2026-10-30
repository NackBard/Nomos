using Nomos.Abstractions;
using Nomos.Abstractions.Ir;
using Nomos.Graph;

namespace Nomos.Facts;

/// <summary>
/// Builds the facts document from the IR. Every metric follows spec/metrics.md; where an IR helper uses a different
/// definition (instability of an isolated module, DIT through external bases, LCOM4 without methods) it is not used.
/// </summary>
internal sealed class FactsBuilder
{
    private const string SchemaVersion = "1.0.0";

    private readonly ProjectModel _model;
    private readonly AnalysisResult _result;
    private readonly FactsOptions _options;
    private readonly IReadOnlyList<TypeDecl> _types;
    private readonly HashSet<string> _typeIds;
    private readonly Dictionary<string, string> _moduleOfType;
    private readonly EntityIndex _index;
    private readonly IReadOnlyDictionary<string, string> _functionIds;
    private readonly Dictionary<string, (int Lines, int Loc)> _fileSizes;

    public FactsBuilder(ProjectModel model, AnalysisResult result, FactsOptions options)
    {
        _model = model;
        _result = result;
        _options = options;
        _index = new EntityIndex(model);
        _types = _index.Types;
        _typeIds = _index.TypeIds;
        _functionIds = _index.FunctionIds;
        _moduleOfType = _types.ToDictionary(t => t.Id, t => t.ModuleName, StringComparer.Ordinal);
        _fileSizes = model.Files.ToDictionary(f => f.Path, f => (PhysicalLines(f.Text), f.Tokens.Select(t => t.Line).Distinct().Count()), StringComparer.Ordinal);
    }

    public FactsDocument Build()
    {
        var dependencies = BuildDependencies();
        var graphs = DependencyGraphs.Build(_model);
        var unitGraph = graphs.Types;
        var moduleGraph = graphs.Modules;

        var evidence = _model.Modules.ToDictionary(m => m.Name, Evidence, StringComparer.Ordinal);
        var moduleHealth = _result.Modules.ToDictionary(m => m.Module, m => m.Health, StringComparer.Ordinal);
        var health = _result.Health;

        return new FactsDocument(
            SchemaVersion,
            new FactsAnalyzer(_options.AnalyzerName, _options.AnalyzerVersion, Languages.CSharp, Semantic: true),
            BuildFiles(),
            [.. _model.Modules.OrderBy(m => m.Name, StringComparer.Ordinal).Select(m => BuildModule(m, graphs.Packages[m.Name], evidence[m.Name], moduleHealth.GetValueOrDefault(m.Name)))],
            [.. _types.Select(t => BuildType(t, unitGraph))],
            BuildFunctions(unitGraph),
            dependencies,
            [.. Cycles("type", unitGraph), .. Cycles("module", moduleGraph)],
            ToHealth(health),
            BuildSkippedRules(evidence),
            _options.SarifFile is null ? null : new FactsChecks(_options.SarifFile, _options.ResultCount),
            [.. _result.Diagnostics
                .Select(d => new FactsDiagnostic(d.Level.ToString().ToLowerInvariant(), d.Message, null, d.Source))
                .Concat(_model.Files.Where(f => f.HasSyntaxErrors).Select(f =>
                    new FactsDiagnostic("warning", "Syntax errors: declarations in this file may be missing from the facts.", f.Path, "syntax-error")))
                .OrderBy(d => d.Level, StringComparer.Ordinal).ThenBy(d => d.Code, StringComparer.Ordinal).ThenBy(d => d.Message, StringComparer.Ordinal)]);
    }

    // ---- files and modules ------------------------------------------------------------------------------------

    private static int PhysicalLines(string text)
    {
        if (text.Length == 0) return 0;
        var breaks = text.Count(c => c == '\n');
        return text[^1] == '\n' ? breaks : breaks + 1;
    }

    private IEnumerable<string> FilesOf(ModuleDecl module) =>
        module.AllTypes.Select(t => t.Location.FilePath).Concat(module.Functions.Select(f => f.Location.FilePath)).Where(p => p.Length > 0).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal);

    private IReadOnlyList<FactsFile> BuildFiles()
    {
        var moduleOfFile = _model.Modules
            .SelectMany(m => FilesOf(m).Select(f => (File: f, Module: m.Name)))
            .GroupBy(p => p.File, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.Select(p => p.Module).Distinct().ToList(), StringComparer.Ordinal);
        return [.. _model.Files.OrderBy(f => f.Path, StringComparer.Ordinal).Select(f =>
        {
            var size = _fileSizes[f.Path];
            var modules = moduleOfFile.GetValueOrDefault(f.Path);
            return new FactsFile(f.Path, size.Lines, size.Loc, modules is [var only] ? only : null, Parsed: !f.HasSyntaxErrors);
        })];
    }

    private FactsModule BuildModule(ModuleDecl module, PackageMetrics martin, IReadOnlyList<FactsEvidence> evidence, HealthScore? health)
    {
        var files = FilesOf(module).ToList();
        return new FactsModule(
            module.Name,
            module.Name,
            files,
            files.Sum(f => _fileSizes.TryGetValue(f, out var size) ? size.Loc : 0),
            new SortedDictionary<string, double?>(StringComparer.Ordinal)
            {
                ["ca"] = martin.AfferentCoupling,
                ["ce"] = martin.EfferentCoupling,
                ["instability"] = Round(martin.Instability),
                ["abstractness"] = Round(martin.Abstractness),
                ["distance"] = Round(martin.Distance),
            },
            evidence,
            health is null ? null : ToHealth(health));
    }

    // ---- types ------------------------------------------------------------------------------------------------

    private FactsType BuildType(TypeDecl type, DirectedGraph unitGraph)
    {
        var methods = type.Callables.Where(IsMethodLike).ToList();
        var metrics = new SortedDictionary<string, double?>(StringComparer.Ordinal)
        {
            ["lines"] = type.Location.LineSpan,
            ["memberCount"] = type.Fields.Count + type.Properties.Count + type.Events.Count + methods.Count + type.NestedTypes.Count,
            ["methodCount"] = methods.Count,
            ["blastRadius"] = BlastRadiusOf(type.Id, unitGraph),
        };
        if (type.Kind is TypeKind.Class or TypeKind.Struct or TypeKind.Record)
        {
            metrics["dit"] = TypeMetrics.Dit(type, _model);
            metrics["cbo"] = TypeMetrics.Cbo(type, _model);
            metrics["lcom4"] = TypeMetrics.Lcom4OrNull(type);
            metrics["wmc"] = TypeMetrics.Wmc(type);
            metrics["atfd"] = TypeMetrics.Atfd(type, _model);
            metrics["tcc"] = Round(TypeMetrics.TccOrNull(type));
        }
        return new FactsType(type.Id, type.Name, type.ModuleName, KindName(type.Kind), type.IsAbstract, Place(type.Location), metrics);
    }

    private static string KindName(TypeKind kind) => kind.ToString().ToLowerInvariant();

    private static bool IsMethodLike(Callable callable) => callable.Kind is CallableKind.Method or CallableKind.Constructor or CallableKind.Destructor or CallableKind.Operator;

    // ---- functions --------------------------------------------------------------------------------------------

    private IReadOnlyList<FactsFunction> BuildFunctions(DirectedGraph unitGraph) =>
        [.. _index.Callables().Select(x =>
        {
            var (callable, module, owner) = x;
            var metrics = new SortedDictionary<string, double?>(StringComparer.Ordinal)
            {
                ["cyclomatic"] = ControlFlow.CyclomaticComplexity(callable),
                ["maxNesting"] = ControlFlow.MaxNesting(callable.Body),
                ["parameterCount"] = callable.Parameters.Count,
                ["lines"] = callable.Location.LineSpan,
            };
            if (owner is not null) metrics["blastRadius"] = BlastRadiusOf(owner.Id, unitGraph);
            var kind = callable.Kind switch
            {
                CallableKind.Method => "method",
                CallableKind.Constructor => "constructor",
                CallableKind.Function => "function",
                _ => "other",
            };
            return new FactsFunction(_functionIds[callable.Id], callable.Name, module.Name, owner?.Id, kind, VisibilityName(callable.Visibility), Place(callable.Location), metrics);
        }).OrderBy(f => f.Id, StringComparer.Ordinal)];

    private static string VisibilityName(Visibility visibility) => visibility switch
    {
        Visibility.Public => "public",
        Visibility.Protected => "protected",
        Visibility.Internal => "internal",
        Visibility.Private => "private",
        _ => "unspecified",
    };

    // ---- dependencies and graphs ------------------------------------------------------------------------------

    private IReadOnlyList<FactsDependency> BuildDependencies()
    {
        var edges = new Dictionary<(string From, string To, string Kind), (int Count, SourceLocation Location)>();
        foreach (var type in _types)
        {
            foreach (var dependency in type.Dependencies.Where(d => d.TargetTypeId != type.Id))
            {
                var key = (type.Id, dependency.TargetTypeId, EdgeKind(dependency.Kind));
                edges[key] = edges.TryGetValue(key, out var seen) ? (seen.Count + 1, seen.Location) : (1, dependency.Location);
            }
        }

        return [.. edges.OrderBy(e => e.Key.From, StringComparer.Ordinal).ThenBy(e => e.Key.To, StringComparer.Ordinal).ThenBy(e => e.Key.Kind, StringComparer.Ordinal)
            .Select(e =>
            {
                var external = !_typeIds.Contains(e.Key.To);
                return new FactsDependency(e.Key.From, e.Key.To, e.Key.Kind, "runtime", external, external && TypeMetrics.IsStandardLibrary(e.Key.To, _model), e.Value.Count,
                    e.Value.Location.IsKnown ? Place(e.Value.Location) : null);
            })];
    }

    private static string EdgeKind(DependencyKind kind) => kind switch
    {
        DependencyKind.Inheritance or DependencyKind.Implementation => "inheritance",
        DependencyKind.Creation or DependencyKind.Invocation => "call",
        _ => "type-ref",
    };

    private static int BlastRadiusOf(string unit, DirectedGraph graph) => BlastRadius.Compute(graph, unit).Transitive.Count;

    private static IEnumerable<FactsCycle> Cycles(string level, DirectedGraph graph) =>
        Tarjan.StronglyConnectedComponents(graph).Where(c => c.Count > 1).OrderBy(c => c[0], StringComparer.Ordinal).Select(c => new FactsCycle(level, c));

    // ---- paradigms and skipped rules --------------------------------------------------------------------------

    private IReadOnlyList<FactsEvidence> Evidence(ModuleDecl module) =>
        [.. ParadigmSigns.Collect(_model, module).Select(e => new FactsEvidence(e.Paradigm, e.Kind, e.Count, e.Description,
            [.. e.Examples.Select(id => _functionIds.GetValueOrDefault(id, id)).Order(StringComparer.Ordinal)]))];

    private IReadOnlyList<FactsSkippedRule> BuildSkippedRules(Dictionary<string, IReadOnlyList<FactsEvidence>> evidence)
    {
        var skipped = new List<FactsSkippedRule>();
        foreach (var module in _model.Modules)
        {
            var active = ParadigmSigns.ActiveParadigms(evidence[module.Name].Select(e => new EvidenceItem(e.Paradigm, e.Kind, e.Count, e.Description, e.Examples)));
            foreach (var rule in _options.SupportedRules.Where(r => r.Paradigms.Count > 0 && !ParadigmSigns.Applies(r.Paradigms, active)))
            {
                var paradigm = rule.Paradigms[0];
                skipped.Add(new FactsSkippedRule(_options.RuleId(rule.Id), module.Name, "paradigm-not-detected", ParadigmSigns.NotApplicable(paradigm)));
            }
        }
        return [.. skipped.OrderBy(s => s.RuleId, StringComparer.Ordinal).ThenBy(s => s.Module, StringComparer.Ordinal)];
    }

    // ---- helpers ----------------------------------------------------------------------------------------------

    private static FactsHealth ToHealth(HealthScore health) =>
        new(Math.Round(health.Score, 1), [.. health.Categories.Select(c => new FactsCategory(c.Category, c.Score, c.Weight, c.Penalty, c.FindingCount))], health.Explanation);

    private static FactsLocation Place(SourceLocation location) => new(location.FilePath, location.StartLine, location.StartColumn, location.EndLine, location.EndColumn);

    private static double? Round(double? value) => value is null ? null : Math.Round(value.Value, 4);
}
