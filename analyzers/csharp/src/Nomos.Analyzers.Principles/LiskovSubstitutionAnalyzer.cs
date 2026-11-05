namespace Nomos.Analyzers.Principles;

/// <summary>Flags overrides that refuse the base contract.</summary>
[Analyzer("PRN003", Categories.Principles, Title = "Liskov Substitution", Severity = Severity.Major, Paradigms = [Paradigms.ObjectOriented],
    Description = "An override or implementation that only throws NotSupported/NotImplemented cannot stand in for its base type.")]
public sealed class LiskovSubstitutionAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var callable in context.Callables.Where(c => c.Has(Modifiers.Override) || c.Implements.Count > 0))
        {
            if (!IrQueries.IsStub(callable)) continue;
            context.Report(callable.Has(Modifiers.Override) ? Confidence.High : Confidence.Medium, callable.Location,
                $"{callable.Name} rejects the inherited contract",
                $"The member exists only to throw, so code written against the base type breaks when it receives this subtype.",
                symbol: callable.Id);
        }
    }
}
