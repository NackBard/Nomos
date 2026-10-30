using System.Text;

namespace Nomos.Analyzers.Principles;

/// <summary>Flags structurally identical callable bodies.</summary>
[Analyzer("PRN006", Categories.Principles, Title = "Don't Repeat Yourself", Severity = Severity.Minor,
    Description = "Callables whose IR is identical up to local names and literals encode one piece of knowledge twice.")]
public sealed class DontRepeatYourselfAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var minNodes = context.Options.Int("minNodes", 25);
        var candidates = context.Callables.Where(c => c.Body is not null)
            .Select(c => (Callable: c, Nodes: c.Body!.DescendantsAndSelf().ToList()))
            .Where(c => c.Nodes.Count >= minNodes)
            .GroupBy(c => Shape(c.Nodes));
        foreach (var group in candidates.Where(g => g.Count() > 1))
        {
            var members = group.Select(g => g.Callable).OrderBy(c => c.Id, StringComparer.Ordinal).ToList();
            var others = string.Join(", ", members.Skip(1).Select(c => c.Id));
            context.Report(Confidence.Medium, members[0].Location, $"{members[0].Name} has {members.Count - 1} structural duplicate(s)",
                $"Same statement structure and member usage, differing at most in local names and literals: {others}.", symbol: members[0].Id);
        }
    }

    private static string Shape(List<IrNode> nodes)
    {
        var shape = new StringBuilder();
        foreach (var node in nodes)
        {
            shape.Append(node.GetType().Name).Append(node switch
            {
                InvocationExpression invocation => invocation.Target.Name,
                MemberAccessExpression access => access.Member.Name,
                BinaryExpression binary => binary.Operator,
                _ => string.Empty,
            }).Append(';');
        }
        return shape.ToString();
    }
}
