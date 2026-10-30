namespace Nomos.Analyzers.Principles;

/// <summary>Flags expressions that are hard to read at a glance.</summary>
[Analyzer("PRN007", Categories.Principles, Title = "Keep It Simple", Severity = Severity.Minor,
    Description = "Long boolean conditions and nested ternaries pack too many decisions into one expression.")]
public sealed class KeepItSimpleAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var maxOperators = context.Options.Int("maxBooleanOperators", 3);
        foreach (var callable in context.Callables)
        {
            foreach (var node in callable.Body.All<IrNode>())
            {
                var condition = node switch
                {
                    IfStatement branch => branch.Condition,
                    LoopStatement { Condition: { } loop } => loop,
                    _ => null,
                };
                var operators = condition.All<BinaryExpression>().Count(b => b.Operator is "&&" or "||");
                if (operators > maxOperators)
                    context.Report(Confidence.Medium, condition!.Location, $"Condition combines {operators} boolean operators",
                        $"More than {maxOperators} operators in one condition; named intermediate values or a predicate method would state the intent.", symbol: callable.Id);

                if (node is ConditionalExpression ternary && (ternary.WhenTrue is ConditionalExpression || ternary.WhenFalse is ConditionalExpression))
                    context.Report(Confidence.High, ternary.Location, "Nested ternary expression",
                        "A ternary inside a ternary hides the branching; an if or a switch expression shows it.", symbol: callable.Id);
            }
        }
    }
}
