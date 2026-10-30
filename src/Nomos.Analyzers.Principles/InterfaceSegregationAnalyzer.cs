namespace Nomos.Analyzers.Principles;

/// <summary>Flags fat interfaces.</summary>
[Analyzer("PRN004", Categories.Principles, Title = "Interface Segregation", Severity = Severity.Minor, Paradigms = [Paradigms.ObjectOriented],
    Description = "Interfaces with many members, or whose implementers stub some of them, force clients to depend on what they do not use.")]
public sealed class InterfaceSegregationAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var maxMembers = context.Options.Int("maxMembers", 10);
        foreach (var contract in context.Types.Where(t => t.Kind == TypeKind.Interface))
        {
            var members = contract.Callables.Count + contract.Properties.Count + contract.Events.Count;
            var stubbed = context.Model.DirectSubtypes(contract.Id).SelectMany(t => t.Callables)
                .Where(c => c.Implements.Any(i => i.StartsWith(contract.Id + ".", StringComparison.Ordinal)) && IrQueries.IsStub(c)).Select(c => c.Name).Distinct().ToList();
            if (stubbed.Count > 0)
                context.Report(contract, Confidence.High, $"{contract.Name} has members its implementers refuse",
                    $"Implementers only throw in: {string.Join(", ", stubbed)}. The interface is wider than some clients need.");
            else if (members > maxMembers)
                context.Report(contract, Confidence.Medium, $"{contract.Name} declares {members} members",
                    $"More than {maxMembers} members on one interface usually mix several client roles.");
        }
    }
}
