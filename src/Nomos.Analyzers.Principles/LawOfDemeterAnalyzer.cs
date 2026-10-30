namespace Nomos.Analyzers.Principles;

/// <summary>Flags navigation through object graphs.</summary>
[Analyzer("PRN009", Categories.Principles, Title = "Law of Demeter", Severity = Severity.Minor, Paradigms = [Paradigms.ObjectOriented],
    Description = "A chain that walks through several distinct project types couples the caller to their internal structure.")]
public sealed class LawOfDemeterAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var maxHops = context.Options.Int("maxHops", 2);
        foreach (var callable in context.Callables)
        {
            var inner = new HashSet<IrNode>(ReferenceEqualityComparer.Instance);
            foreach (var node in callable.Body.All<Expression>())
            {
                if (inner.Contains(node)) continue;
                var chain = Chain(node).ToList();
                foreach (var link in chain) inner.Add(link);

                // Only project types count: fluent framework APIs such as LINQ are designed for chaining.
                var types = chain.Select(c => c.Type).Where(t => t is { IsExternal: false, Id: not null }).Select(t => t!.Id!).Distinct().ToList();
                if (types.Count <= maxHops) continue;
                context.Report(Confidence.Medium, node.Location, $"Chain crosses {types.Count} project types",
                    $"The call site navigates {string.Join(" -> ", types)}. Asking the first object for what is needed hides that structure.", symbol: callable.Id);
            }
        }
    }

    private static IEnumerable<Expression> Chain(Expression start)
    {
        for (var current = start; current is InvocationExpression or MemberAccessExpression;)
        {
            yield return current;
            current = current is InvocationExpression call ? call.Callee is MemberAccessExpression callee ? callee.Target : null! : ((MemberAccessExpression)current).Target;
        }
    }
}
