namespace Nomos.Analyzers.Principles;

/// <summary>Flags speculative generality.</summary>
[Analyzer("PRN008", Categories.Principles, Title = "You Aren't Gonna Need It", Severity = Severity.Minor,
    Description = "Non-public abstractions without enough implementers and unused private parameters are generality nobody uses.")]
public sealed class YouArentGonnaNeedItAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var type in context.Types.Where(t => t.IsAbstract && t.Visibility != Visibility.Public))
        {
            var subtypes = context.Model.DirectSubtypes(type.Id).Count();
            if (subtypes <= 1)
                context.Report(type, Confidence.Low, $"{type.Name} has {subtypes} implementer(s)",
                    $"A non-public abstraction with at most one implementation adds indirection without a second use. It may still serve test doubles, which this analysis cannot see.");
        }

        foreach (var callable in context.Callables.Where(c => c is { Visibility: Visibility.Private, Body: not null, Kind: CallableKind.Method }))
        {
            var used = DataFlow.Analyze(callable.Body);
            foreach (var parameter in callable.Parameters.Where(p => !used.LocalReads.Contains(p.Name) && !used.LocalWrites.Contains(p.Name)))
                context.Report(Confidence.Medium, parameter.Location, $"Parameter {parameter.Name} of {callable.Name} is never used",
                    $"The method is private, so no external contract requires this parameter.", symbol: callable.Id);
        }
    }
}
