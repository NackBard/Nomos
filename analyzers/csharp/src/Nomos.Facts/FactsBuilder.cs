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
        var dependencies = BuildDependencies(out var unitEdges);
        var unitGraph = new DirectedGraph();
        foreach (var id in _typeIds) unitGraph.AddNode(id);
        foreach (var (from, to) in unitEdges) unitGraph.AddEdge(from, to);

        var moduleGraph = new DirectedGraph();
        foreach (var module in _model.Modules) moduleGraph.AddNode(module.Name);
        foreach (var (from, to) in unitEdges)
        {
            if (_moduleOfType[from] != _moduleOfType[to]) moduleGraph.AddEdge(_moduleOfType[from], _moduleOfType[to]);
        }

        var evidence = _model.Modules.ToDictionary(m => m.Name, Evidence, StringComparer.Ordinal);
        var moduleHealth = _result.Modules.ToDictionary(m => m.Module, m => m.Health, StringComparer.Ordinal);
        var health = _result.Health;

        return new FactsDocument(
            SchemaVersion,
            new FactsAnalyzer(_options.AnalyzerName, _options.AnalyzerVersion, Languages.CSharp, Semantic: true),
            BuildFiles(),
            [.. _model.Modules.OrderBy(m => m.Name, StringComparer.Ordinal).Select(m => BuildModule(m, unitEdges, evidence[m.Name], moduleHealth.GetValueOrDefault(m.Name)))],
            [.. _types.Select(t => BuildType(t, unitGraph))],
            BuildFunctions(unitGraph),
            dependencies,
            [.. Cycles("type", unitGraph), .. Cycles("module", moduleGraph)],
            ToHealth(health),
            BuildSkippedRules(evidence),
            _options.SarifFile is null ? null : new FactsChecks(_options.SarifFile, _options.ResultCount),
            [.. _result.Diagnostics
                .Select(d => new FactsDiagnostic(d.Level.ToString().ToLowerInvariant(), d.Message, null, d.Source))
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
            return new FactsFile(f.Path, size.Lines, size.Loc, modules is [var only] ? only : null);
        })];
    }

    private FactsModule BuildModule(ModuleDecl module, IReadOnlyList<(string From, string To)> unitEdges, IReadOnlyList<FactsEvidence> evidence, HealthScore? health)
    {
        var own = module.AllTypes.Select(t => t.Id).ToHashSet(StringComparer.Ordinal);
        var ca = unitEdges.Where(e => own.Contains(e.To) && !own.Contains(e.From)).Select(e => e.From).Distinct().Count();
        var ce = unitEdges.Where(e => own.Contains(e.From) && !own.Contains(e.To)).Select(e => e.To).Distinct().Count();
        double? instability = ca + ce == 0 ? null : (double)ce / (ca + ce);
        var typeCount = module.AllTypes.Count();
        double? abstractness = typeCount == 0 ? null : (double)module.AllTypes.Count(t => t.IsAbstract) / typeCount;
        double? distance = abstractness is null || instability is null ? null : Math.Abs(abstractness.Value + instability.Value - 1);

        var files = FilesOf(module).ToList();
        return new FactsModule(
            module.Name,
            module.Name,
            files,
            files.Sum(f => _fileSizes.TryGetValue(f, out var size) ? size.Loc : 0),
            new SortedDictionary<string, double?>(StringComparer.Ordinal)
            {
                ["ca"] = ca,
                ["ce"] = ce,
                ["instability"] = Round(instability),
                ["abstractness"] = Round(abstractness),
                ["distance"] = Round(distance),
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
            metrics["dit"] = InheritanceDepth(type);
            metrics["cbo"] = Cbo(type);
            metrics["lcom4"] = Lcom4(type);
            metrics["wmc"] = type.Callables.Where(IsMethodLike).Sum(ControlFlow.CyclomaticComplexity);
        }
        return new FactsType(type.Id, type.Name, type.ModuleName, KindName(type.Kind), type.IsAbstract, Place(type.Location), metrics);
    }

    private static string KindName(TypeKind kind) => kind.ToString().ToLowerInvariant();

    private static bool IsMethodLike(Callable callable) => callable.Kind is CallableKind.Method or CallableKind.Constructor or CallableKind.Destructor or CallableKind.Operator;

    /// <summary>DIT: base classes only. A base outside the project is one step; its own ancestors are unknown.</summary>
    private int InheritanceDepth(TypeDecl type)
    {
        if (type.Kind != TypeKind.Class) return 0;
        var depth = 0;
        var seen = new HashSet<string> { type.Id };
        for (var current = type.BaseType; current is { Id: { } id } && seen.Add(id); current = _model.FindType(id)?.BaseType)
        {
            depth++;
            if (_model.FindType(id) is null) break;
        }
        return depth;
    }

    /// <summary>CBO: distinct other types the type points to, project types and external non-standard types.</summary>
    private int Cbo(TypeDecl type) =>
        type.Dependencies.Select(d => d.TargetTypeId).Where(t => t != type.Id && !IsStandardLibrary(t, _typeIds)).Distinct(StringComparer.Ordinal).Count();

    private static int? Lcom4(TypeDecl type)
    {
        var count = type.Callables.Count(c => c.Kind == CallableKind.Method && !c.Has(Modifiers.Static) && c.Body is not null);
        return count == 0 ? null : TypeMetrics.Lcom4(type);
    }

    private static bool IsStandardLibrary(string typeId, HashSet<string> projectTypes) =>
        !projectTypes.Contains(typeId) && (typeId == "System" || typeId.StartsWith("System.", StringComparison.Ordinal) || typeId.StartsWith("Microsoft.", StringComparison.Ordinal));

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

    private IReadOnlyList<FactsDependency> BuildDependencies(out List<(string From, string To)> unitEdges)
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

        unitEdges = [.. edges.Keys.Where(k => _typeIds.Contains(k.To)).Select(k => (k.From, k.To)).Distinct().OrderBy(e => e.From, StringComparer.Ordinal).ThenBy(e => e.To, StringComparer.Ordinal)];
        return [.. edges.OrderBy(e => e.Key.From, StringComparer.Ordinal).ThenBy(e => e.Key.To, StringComparer.Ordinal).ThenBy(e => e.Key.Kind, StringComparer.Ordinal)
            .Select(e =>
            {
                var external = !_typeIds.Contains(e.Key.To);
                return new FactsDependency(e.Key.From, e.Key.To, e.Key.Kind, "runtime", external, external && IsStandardLibrary(e.Key.To, _typeIds), e.Value.Count,
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

    private IReadOnlyList<FactsEvidence> Evidence(ModuleDecl module) => new ParadigmEvidenceCollector(_model, _functionIds).Collect(module);

    private IReadOnlyList<FactsSkippedRule> BuildSkippedRules(Dictionary<string, IReadOnlyList<FactsEvidence>> evidence)
    {
        var skipped = new List<FactsSkippedRule>();
        foreach (var module in _model.Modules)
        {
            var active = ParadigmEvidenceCollector.ActiveParadigms(evidence[module.Name]);
            foreach (var rule in _options.SupportedRules.Where(r => r.Paradigms.Count > 0 && !r.Paradigms.Any(active.Contains)))
            {
                var paradigm = rule.Paradigms[0];
                skipped.Add(new FactsSkippedRule(_options.RuleId(rule.Id), module.Name, "paradigm-not-detected", ParadigmEvidenceCollector.NotApplicable(paradigm)));
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
