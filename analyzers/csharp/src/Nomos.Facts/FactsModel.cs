namespace Nomos.Facts;

// Shape of contracts/facts.schema.json. Property order is the output order; names are camelCased on write.

internal sealed record FactsDocument(
    string SchemaVersion,
    FactsAnalyzer Analyzer,
    IReadOnlyList<FactsFile> Files,
    IReadOnlyList<FactsModule> Modules,
    IReadOnlyList<FactsType> Types,
    IReadOnlyList<FactsFunction> Functions,
    IReadOnlyList<FactsDependency> Dependencies,
    IReadOnlyList<FactsCycle> Cycles,
    FactsHealth Health,
    IReadOnlyList<FactsSkippedRule> SkippedRules,
    FactsChecks? Checks,
    IReadOnlyList<FactsDiagnostic> Diagnostics);

internal sealed record FactsAnalyzer(string Name, string Version, string Language, bool Semantic);

internal sealed record FactsFile(string Path, int Lines, int Loc, double? Coverage, string? Module, bool Parsed = true);

internal sealed record FactsModule(
    string Id,
    string Name,
    IReadOnlyList<string> Files,
    int Loc,
    SortedDictionary<string, double?> Metrics,
    IReadOnlyList<FactsEvidence> ParadigmEvidence,
    IReadOnlyList<string> ActiveParadigms,
    FactsHealth? Health);

internal sealed record FactsEvidence(string Paradigm, string Kind, int Count, string Description, IReadOnlyList<string> Examples);

internal sealed record FactsLocation(string File, int StartLine, int? StartColumn = null, int? EndLine = null, int? EndColumn = null);

internal sealed record FactsType(
    string Id,
    string Name,
    string Module,
    string Kind,
    bool IsAbstract,
    FactsLocation Location,
    SortedDictionary<string, double?> Metrics);

internal sealed record FactsFunction(
    string Id,
    string Name,
    string Module,
    string? Type,
    string Kind,
    string Visibility,
    FactsLocation Location,
    SortedDictionary<string, double?> Metrics);

internal sealed record FactsDependency(string From, string To, string Kind, string Phase, bool External, bool Stdlib, int Count, FactsLocation? Location);

internal sealed record FactsCycle(string Level, IReadOnlyList<string> Members);

internal sealed record FactsCategory(string Category, double Score, double Weight, double Penalty, int FindingCount);

internal sealed record FactsHealth(double Score, IReadOnlyList<FactsCategory> Categories, IReadOnlyList<string> Explanation);

internal sealed record FactsSkippedRule(string RuleId, string? Module, string Reason, string Message);

internal sealed record FactsChecks(string? SarifFile, int ResultCount);

internal sealed record FactsDiagnostic(string Level, string Message, string? File, string? Code);
