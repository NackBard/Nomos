namespace Nomos.Analyzers.Maintainability;

/// <summary>Measures cyclomatic complexity.</summary>
[Analyzer("MNT001", Categories.Maintainability, Title = "Cyclomatic complexity", Severity = Severity.Minor,
    Description = "Counts decision points per callable; reports every value as a metric and flags those above the limit.")]
public sealed class CyclomaticComplexityAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var max = context.Options.Int("maxComplexity", 10);
        foreach (var callable in context.Callables.Where(c => c.Body is not null))
        {
            var complexity = ControlFlow.CyclomaticComplexity(callable);
            context.Report(new Metric("cyclomatic", MetricScope.Callable, callable.Id, complexity));
            if (complexity > max)
                context.Report(Confidence.High, callable.Location, $"{callable.Name} has cyclomatic complexity {complexity}",
                    $"The count is exact; above {max}, the number of paths to test and to understand grows quickly.", symbol: callable.Id,
                    severity: complexity > max * 2 ? Severity.Major : null, measured: new Measurement("cyclomatic", complexity, max));
        }

        foreach (var type in context.Types.Where(t => t.Callables.Count > 0))
            context.Report(new Metric("cyclomatic-sum", MetricScope.Type, type.Id, TypeMetrics.Wmc(type), type.ModuleName));
        foreach (var module in context.Modules.Where(m => m.AllCallables.Any()))
            context.Report(new Metric("cyclomatic-mean", MetricScope.Module, module.Name, Math.Round(module.AllCallables.Average(ControlFlow.CyclomaticComplexity), 2), module.Name));
    }
}

/// <summary>Computes the maintainability index.</summary>
[Analyzer("MNT002", Categories.Maintainability, Title = "Maintainability index", Severity = Severity.Minor,
    Description = "MI = max(0, (171 - 5.2 ln V - 0.23 G - 16.2 ln L) * 100 / 171), from Halstead volume V, cyclomatic complexity G and lines L.")]
public sealed class MaintainabilityIndexAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var min = context.Options.Number("minIndex", 20);
        foreach (var module in context.Modules)
        {
            var indices = new List<double>();
            foreach (var callable in module.AllCallables.Where(c => c.Body is not null && c.Location.IsKnown))
            {
                if (CallableMetrics.MaintainabilityIndex(callable, context.Model) is not { } index) continue;
                indices.Add(index);
                context.Report(new Metric("maintainability-index", MetricScope.Callable, callable.Id, Math.Round(index, 1), module.Name));
                if (index < min)
                    context.Report(Confidence.Medium, callable.Location, $"{callable.Name} has a maintainability index of {index:0}",
                        $"Below {min:0}. The formula is an empirical blend of size and complexity, useful for ranking rather than as a measure of quality.", module.Name, callable.Id,
                        measured: new Measurement("maintainabilityIndex", Math.Round(index, 4), min));
            }
            if (indices.Count > 0) context.Report(new Metric("maintainability-index", MetricScope.Module, module.Name, Math.Round(indices.Average(), 1), module.Name));
        }
    }

}

/// <summary>Finds duplicated code on the token level.</summary>
[Analyzer("MNT003", Categories.Maintainability, Title = "Duplication", Severity = Severity.Minor,
    Description = "Finds type-2 clones: token sequences equal after normalizing identifiers and literals, with a rolling hash.")]
public sealed class DuplicationAnalyzer : AnalyzerBase
{
    private const ulong Base = 1_000_003;

    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var window = context.Options.Int("minTokens", 100);
        var files = context.Model.Files.Where(f => f.Language == context.Language).Select(f => (f.Path, Tokens: Normalize(f))).Where(f => f.Tokens.Count >= window).ToList();
        var seen = new Dictionary<ulong, List<(int File, int Position)>>();
        var duplicated = 0;
        var total = files.Sum(f => f.Tokens.Count);
        ulong power = 1;
        for (var i = 1; i < window; i++) power = unchecked(power * Base);

        for (var fileIndex = 0; fileIndex < files.Count; fileIndex++)
        {
            var tokens = files[fileIndex].Tokens;
            ulong hash = 0;
            for (var i = 0; i < window; i++) hash = unchecked(hash * Base + tokens[i].Hash);
            var skipUntil = 0;
            for (var position = 0; position + window <= tokens.Count; position++)
            {
                if (position > 0) hash = unchecked((hash - tokens[position - 1].Hash * power) * Base + tokens[position + window - 1].Hash);
                if (position >= skipUntil && seen.TryGetValue(hash, out var earlier))
                {
                    foreach (var (otherFile, otherPosition) in earlier)
                    {
                        var length = MatchLength(files[otherFile].Tokens, otherPosition, tokens, position);
                        if (length < window) continue;
                        if (otherFile == fileIndex && otherPosition + length > position) continue;
                        duplicated += length;
                        skipUntil = position + length;
                        Report(context, files[fileIndex].Path, tokens[position].Line, tokens[position + length - 1].Line, files[otherFile].Path, files[otherFile].Tokens[otherPosition].Line, length, window);
                        break;
                    }
                }
                if (!seen.TryGetValue(hash, out var list)) seen[hash] = list = [];
                list.Add((fileIndex, position));
            }
        }
        if (total > 0) context.Report(new Metric("duplication-percent", MetricScope.Project, context.Model.Name, Math.Round(100.0 * duplicated / total, 1)));
    }

    private static void Report(AnalysisContext context, string path, int startLine, int endLine, string otherPath, int otherLine, int length, int window) =>
        context.Report(Confidence.High, new SourceLocation(path, startLine, 1, endLine, 1), $"{length} tokens duplicate {otherPath}:{otherLine}",
            "The token sequences are identical after replacing identifiers and literals with placeholders.",
            measured: new Measurement("cloneTokens", length, window));

    private static int MatchLength(List<(ulong Hash, int Line)> a, int i, List<(ulong Hash, int Line)> b, int j)
    {
        var length = 0;
        while (i + length < a.Count && j + length < b.Count && a[i + length].Hash == b[j + length].Hash) length++;
        return length;
    }

    private static List<(ulong Hash, int Line)> Normalize(SourceFile file)
    {
        var imports = file.Tokens.Where(t => t is { Kind: SourceTokenKind.Keyword, Text: "using" or "namespace" or "import" or "package" }).Select(t => t.Line).ToHashSet();
        return [.. file.Tokens.Where(t => !imports.Contains(t.Line)).Select(t => (StableHash(t), t.Line))];
    }

    private static ulong StableHash(SourceToken token)
    {
        var text = token.Kind switch { SourceTokenKind.Identifier => "$id", SourceTokenKind.Literal => "$lit", _ => token.Text };
        ulong hash = 14695981039346656037;
        foreach (var c in text) hash = unchecked((hash ^ c) * 1099511628211);
        return hash;
    }
}

/// <summary>Reads test coverage from a report.</summary>
[Analyzer("MNT004", Categories.Maintainability, Title = "Test coverage", Severity = Severity.Minor,
    Description = "When thresholds.report points to a Cobertura XML or LCOV file, reports line coverage and flags files below minCoverage.")]
public sealed class TestCoverageAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var report = context.Options.Text("report", string.Empty);
        if (report.Length == 0 || context.RootPath is null) return;
        var path = Path.Combine(context.RootPath, report);
        if (!File.Exists(path)) return;

        var coverage = CoverageReport.Load(path);
        var min = context.Options.Number("minCoverage", 50);
        var covered = 0;
        var total = 0;
        foreach (var file in context.Model.Files.Where(f => f.Language == context.Language))
        {
            if (coverage.Lines(file.Path) is not { } lines) continue;
            covered += lines.Count(h => h.Value > 0);
            total += lines.Count;
            var percent = coverage.Percent(file.Path)!.Value;
            if (percent < min)
                context.Report(Confidence.High, new SourceLocation(file.Path, 1, 1, 1, 1), $"{file.Path} has {percent:0}% line coverage",
                    $"Measured from {report}; below the {min:0}% minimum. Coverage shows what ran, not what was verified.",
                    measured: new Measurement("coverage", percent, min));
        }
        if (total > 0) context.Report(new Metric("coverage-percent", MetricScope.Project, context.Model.Name, Math.Round(100.0 * covered / total, 1)));
    }
}
