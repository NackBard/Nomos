namespace Nomos.Analyzers.Algorithms;

/// <summary>Estimates time complexity.</summary>
[Analyzer("ALG001", Categories.Algorithms, Title = "Time complexity estimate", Severity = Severity.Minor,
    Description = "Estimates growth from loop nesting, known linear calls, recursion shape and project callees. Always an estimate: input sizes are unknown.")]
public sealed class TimeComplexityAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var reportFrom = context.Options.Int("reportFromDegree", 2);
        var estimates = ComplexityEstimates.Time(context.Model);
        foreach (var callable in context.Callables.Where(c => c.Body is not null))
        {
            var growth = estimates[callable.Id];
            context.Report(growth.Exponential
                ? new Metric("timeExponential", MetricScope.Callable, callable.Id, 1)
                : new Metric("timeDegree", MetricScope.Callable, callable.Id, growth.Degree));
            if (!growth.Exponential && growth.Degree < reportFrom) continue;
            context.Report(growth.Uncertain ? Confidence.Low : Confidence.Medium, callable.Location, $"{callable.Name} is likely {growth}",
                growth.Uncertain
                    ? "Estimated from recursion, a while loop or a callee; loop bounds and call counts are not known exactly."
                    : "Estimated from nested loops over inputs of unknown size. Small inputs may make this irrelevant.",
                symbol: callable.Id, severity: growth.Exponential ? Severity.Major : null,
                measured: growth.Exponential ? new Measurement("timeExponential", 1, 1) : new Measurement("timeDegree", growth.Degree, reportFrom));
        }
    }
}

/// <summary>Flags linear operations repeated in loops.</summary>
[Analyzer("ALG002", Categories.Algorithms, Title = "Quadratic pattern", Severity = Severity.Minor,
    Description = "Finds list searches, front insertions and string concatenation inside loops.")]
public sealed class QuadraticPatternAnalyzer : AnalyzerBase
{
    private static readonly HashSet<string> Searches = ["Contains", "IndexOf", "Find", "FindIndex", "Exists", "Any", "First", "FirstOrDefault", "Single", "SingleOrDefault", "Count", "ElementAt", "Remove"];
    private static readonly string[] LinearReceivers = ["List", "IList", "IEnumerable", "ICollection", "IReadOnlyList", "IReadOnlyCollection", "LinkedList", "Collection"];

    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var callable in context.Callables)
        {
            foreach (var (node, depth) in callable.Body.WithLoopDepth().Where(n => n.LoopDepth > 0))
            {
                switch (node)
                {
                    case InvocationExpression call when IsLinearSearch(call):
                        Report(context, callable, call, $"{call.Target.Name} on {call.Receiver?.Type?.SimpleName ?? "a sequence"} inside a loop",
                            "Each iteration scans the sequence. A HashSet or Dictionary built once makes the lookup constant-time.");
                        break;
                    case InvocationExpression { Target.Name: "RemoveAt" or "Insert", Arguments: [LiteralExpression { Value: "0" }, ..] } call:
                        Report(context, callable, call, $"{call.Target.Name}(0) inside a loop", "Every element shifts on each call. A Queue, a Stack or iterating from the end avoids this.");
                        break;
                    case AssignmentExpression { Operator: "+=", Target.Type.Kind: TypeRefKind.Primitive, Target.Type.SimpleName: "string" } append:
                        Report(context, callable, append, "String concatenation inside a loop", "Each step copies the whole string so far. StringBuilder grows in amortized constant time.");
                        break;
                }
            }
        }
    }

    private static bool IsLinearSearch(InvocationExpression call) =>
        Searches.Contains(call.Target.Name) && call.Receiver?.Type is { } type && (type.Kind == TypeRefKind.Array || LinearReceivers.Contains(type.SimpleName));

    private static void Report(AnalysisContext context, Callable callable, IrNode node, string message, string explanation) =>
        context.Report(Confidence.Medium, node.Location, $"Likely quadratic: {message}", explanation, symbol: callable.Id);
}

/// <summary>Flags allocations that repeat many times.</summary>
[Analyzer("ALG003", Categories.Algorithms, Title = "Allocation in hot loop", Severity = Severity.Minor,
    Description = "Finds materializing calls in loops, and object creation or closures in nested loops.")]
public sealed class HotLoopAllocationAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var minDepth = context.Options.Int("minDepthForObjects", 2);
        foreach (var callable in context.Callables)
        {
            var measured = new Measurement("allocationDepth", CallableMetrics.AllocationDepth(callable), minDepth);
            foreach (var (node, depth) in callable.Body.WithLoopDepth())
            {
                if (depth >= 1 && node is InvocationExpression { Target.Name: "ToList" or "ToArray" or "ToDictionary" or "ToHashSet" } call)
                    context.Report(Confidence.Medium, call.Location, $"{call.Target.Name} allocates on each loop iteration", "A new collection is built per iteration; moving it out of the loop or reusing a buffer reduces GC pressure.", symbol: callable.Id);
                else if (depth >= minDepth && node is ObjectCreationExpression { CreatedType.Kind: not TypeRefKind.Struct } creation)
                    context.Report(Confidence.Low, creation.Location, $"Allocation of {creation.CreatedType.SimpleName} in a nested loop", "Runs once per inner iteration. Whether it matters depends on how hot the loop really is, which static analysis cannot tell.", symbol: callable.Id, measured: measured);
                else if (depth >= minDepth && node is LambdaExpression lambda)
                    context.Report(Confidence.Low, lambda.Location, "Lambda in a nested loop", "A capturing lambda allocates a closure per iteration; a non-capturing one is cached.", symbol: callable.Id, measured: measured);
            }
        }
    }
}

/// <summary>Estimates space complexity.</summary>
[Analyzer("ALG004", Categories.Algorithms, Title = "Space complexity estimate", Severity = Severity.Minor,
    Description = "Estimates extra memory from collections growing in loops, arrays of non-constant size and recursion depth.")]
public sealed class SpaceComplexityAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var reportFrom = context.Options.Int("reportFromDegree", 2);
        foreach (var callable in context.Callables.Where(c => c.Body is not null))
        {
            var degree = CallableMetrics.SpaceDegree(callable);
            context.Report(new Metric("spaceDegree", MetricScope.Callable, callable.Id, degree));
            if (degree >= reportFrom)
            {
                var growth = new Growth(degree, 0, false, true);
                context.Report(Confidence.Low, callable.Location, $"{callable.Name} likely uses {growth} extra memory",
                    "Estimated from collection growth under nested loops or multi-dimensional allocation sizes.", symbol: callable.Id,
                    measured: new Measurement("spaceDegree", degree, reportFrom));
            }
        }
    }
}
