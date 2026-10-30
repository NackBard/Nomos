namespace Nomos.Analyzers.CleanCode;

/// <summary>Flags long callables.</summary>
[Analyzer("CC001", Categories.CleanCode, Title = "Long method", Severity = Severity.Minor, Paradigms = [Paradigms.ObjectOriented, Paradigms.Structural, Paradigms.Functional],
    Description = "Counts source lines of a callable against maxLines.")]
public sealed class LongMethodAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var maxLines = context.Options.Int("maxLines", 40);
        foreach (var callable in context.Callables.Where(c => c.Body is not null))
        {
            var lines = callable.Location.LineSpan;
            if (lines > maxLines)
                context.Report(Confidence.High, callable.Location, $"{callable.Name} spans {lines} lines",
                    $"The line count is exact; the limit of {maxLines} is a readability convention.", symbol: callable.Id,
                    severity: lines > maxLines * 2 ? Severity.Major : null, measured: new Measurement("lines", lines, maxLines));
        }
    }
}

/// <summary>Flags large types.</summary>
[Analyzer("CC002", Categories.CleanCode, Title = "Large class", Severity = Severity.Minor, Paradigms = [Paradigms.ObjectOriented],
    Description = "Counts lines and members of a type, over all partial parts.")]
public sealed class LargeClassAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var maxLines = context.Options.Int("maxLines", 400);
        var maxMembers = context.Options.Int("maxMembers", 30);
        foreach (var type in context.Types.Where(t => t.Kind is not (TypeKind.Enum or TypeKind.Delegate)))
        {
            var members = type.Fields.Count + type.Properties.Count + type.Callables.Count;
            context.Report(new Metric("lines", MetricScope.Type, type.Id, type.LineCount, type.ModuleName));
            if (type.LineCount > maxLines || members > maxMembers)
                context.Report(type, Confidence.High, $"{type.Name} has {type.LineCount} lines and {members} members",
                    $"The counts are exact; the limits ({maxLines} lines, {maxMembers} members) are conventions.",
                    measured: type.LineCount > maxLines ? new Measurement("lines", type.LineCount, maxLines) : null);
        }
    }
}

/// <summary>Flags long parameter lists.</summary>
[Analyzer("CC003", Categories.CleanCode, Title = "Too many parameters", Severity = Severity.Minor, Paradigms = [Paradigms.ObjectOriented, Paradigms.Structural, Paradigms.Functional],
    Description = "Counts parameters of a callable; constructors have a separate limit because of dependency injection.")]
public sealed class TooManyParametersAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var max = context.Options.Int("maxParameters", 5);
        var maxConstructor = context.Options.Int("maxConstructorParameters", 7);
        foreach (var callable in context.Callables)
        {
            var limit = callable.Kind == CallableKind.Constructor ? maxConstructor : max;
            if (callable.Parameters.Count > limit)
                context.Report(Confidence.High, callable.Location, $"{callable.Name} takes {callable.Parameters.Count} parameters",
                    $"The limit is {limit}. Long lists are easy to misorder; a parameter object groups what belongs together.", symbol: callable.Id,
                    measured: new Measurement("parameterCount", callable.Parameters.Count, limit));
        }
    }
}

/// <summary>Flags deep nesting of control structures.</summary>
[Analyzer("CC004", Categories.CleanCode, Title = "Deep nesting", Severity = Severity.Minor, Paradigms = [Paradigms.ObjectOriented, Paradigms.Structural, Paradigms.Functional],
    Description = "Measures nesting of branches, loops and guarded blocks; 'else if' chains stay flat.")]
public sealed class DeepNestingAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var maxDepth = context.Options.Int("maxDepth", 4);
        foreach (var callable in context.Callables)
        {
            var depth = ControlFlow.MaxNesting(callable.Body);
            if (depth > maxDepth)
                context.Report(Confidence.High, callable.Location, $"{callable.Name} nests {depth} levels deep",
                    $"The limit is {maxDepth}. Guard clauses or extracted methods flatten the flow.", symbol: callable.Id,
                    measured: new Measurement("maxNesting", depth, maxDepth));
        }
    }
}
