namespace Nomos.Analyzers.Principles;

/// <summary>Flags repeated dispatch on an enum, which every new case must touch.</summary>
[Analyzer("PRN002", Categories.Principles, Title = "Open/Closed", Severity = Severity.Minor, Paradigms = [Paradigms.ObjectOriented],
    Description = "The same enum switched on in several places means adding a value requires editing all of them.")]
public sealed class OpenClosedAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var minOccurrences = context.Options.Int("minOccurrences", 2);
        var minCases = context.Options.Int("minCases", 3);
        var sites = new List<(string EnumName, string Key, SourceLocation Location, Callable Callable)>();
        foreach (var callable in context.Callables)
        {
            foreach (var node in callable.Body.All<IrNode>())
            {
                var (subject, cases) = node switch
                {
                    SwitchStatement s => (s.Subject, s.Sections.Count),
                    SwitchExpression e => (e.Subject, e.Arms.Count),
                    _ => (null, 0),
                };
                if (subject?.Type is { Kind: TypeRefKind.Enum } type && cases >= minCases)
                    sites.Add((type.Name, type.Id ?? type.Name, node.Location, callable));
            }
        }

        foreach (var group in sites.GroupBy(s => s.Key).Where(g => g.Count() >= minOccurrences))
        {
            foreach (var site in group)
                context.Report(Confidence.Medium, site.Location, $"Switch over {site.EnumName} repeats at {group.Count()} sites",
                    $"{group.Count()} switches dispatch on {site.EnumName}; a new value needs an edit at each. A polymorphic type or a table keeps this closed for modification.",
                    symbol: site.Callable.Id);
        }
    }
}
