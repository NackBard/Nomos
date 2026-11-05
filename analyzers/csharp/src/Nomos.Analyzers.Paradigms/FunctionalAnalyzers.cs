namespace Nomos.Analyzers.Profiles;

internal static class Effects
{
    private static readonly HashSet<string> EffectfulTypes = ["Console", "File", "Directory", "Environment", "HttpClient", "Process", "Random", "DateTime", "DateTimeOffset", "Guid", "Stopwatch", "Debug", "Trace"];
    private static readonly HashSet<string> Mutators = ["Add", "AddRange", "Remove", "RemoveAt", "RemoveAll", "Clear", "Insert", "Push", "Pop", "Enqueue", "Dequeue", "Sort", "Reverse"];

    /// <summary>Lists observable effects of a body as (code that shows the effect, location); code reads the same in every language.</summary>
    public static IEnumerable<(string What, SourceLocation Where)> Of(IrNode? body)
    {
        var flow = DataFlow.Analyze(body);
        foreach (var (symbol, location) in flow.MemberWrites) yield return ($"{symbol.Name} = …", location);
        foreach (var parameter in flow.MutatedParameters) yield return ($"{parameter}.… = …", body!.Location);
        foreach (var call in flow.Invocations)
        {
            var owner = call.Target.DeclaringTypeId?.Split('.').Last();
            if (owner is not null && EffectfulTypes.Contains(owner) && !call.Target.Name.StartsWith("Parse", StringComparison.Ordinal))
                yield return ($"{owner}.{call.Target.Name}()", call.Location);
            else if (Mutators.Contains(call.Target.Name) && call.Receiver is NameExpression { Symbol.Kind: SymbolKind.Field or SymbolKind.Property or SymbolKind.Parameter } target && call.Target.IsExternal)
                yield return ($"{target.Symbol.Name}.{call.Target.Name}()", call.Location);
        }
        foreach (var access in body.All<MemberAccessExpression>().Where(a => a.Member.Name is "Now" or "UtcNow" or "Today" && a.Member.IsExternal))
            yield return ($"{access.Member.DeclaringTypeId?.Split('.').Last() ?? "DateTime"}.{access.Member.Name}", access.Location);
    }
}

/// <summary>Flags value-returning functions with effects.</summary>
[Analyzer("FUN001", Categories.Paradigm, Title = "Impure function", Severity = Severity.Minor, Paradigms = [Paradigms.Functional],
    Description = "A callable that returns a value and also writes state or performs I/O cannot be reasoned about by substitution.")]
public sealed class ImpureFunctionAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var callable in context.Callables.Where(c => c is { ReturnType: not null, Kind: CallableKind.Method or CallableKind.Function or CallableKind.Operator }))
        {
            var effects = Effects.Of(callable.Body).ToList();
            if (effects.Count > 0)
                context.Report(Confidence.Medium, callable.Location, $"{callable.Name} returns a value and has side effects",
                    $"Observed: {string.Join("; ", effects.Select(e => e.What).Distinct())}. Effects hidden behind calls to other methods are not visible here.", symbol: callable.Id);
        }
    }
}

/// <summary>Flags effects inside lambdas.</summary>
[Analyzer("FUN002", Categories.Paradigm, Title = "Side effect in lambda", Severity = Severity.Minor, Paradigms = [Paradigms.Functional],
    Description = "A lambda passed to a higher-order function that changes outer variables couples the result to evaluation order.")]
public sealed class LambdaSideEffectAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var callable in context.Callables)
        {
            foreach (var lambda in callable.Body.All<InvocationExpression>().SelectMany(i => i.Arguments.OfType<LambdaExpression>()))
            {
                var flow = DataFlow.Analyze(lambda.Body);
                var parameters = lambda.Parameters.Select(p => p.Name).ToHashSet();
                var captured = flow.LocalWrites.Where(w => !flow.LocalDeclarations.Contains(w) && !parameters.Contains(w)).ToList();
                var members = flow.MemberWrites.Select(w => w.Symbol.Name).ToList();
                if (captured.Count + members.Count > 0)
                    context.Report(Confidence.High, lambda.Location, $"Lambda changes state outside itself",
                        $"It writes {string.Join(", ", captured.Concat(members).Distinct())}. With lazy or parallel evaluation, the order of these writes is not guaranteed.", symbol: callable.Id);
            }
        }
    }
}

/// <summary>Flags mutable state.</summary>
[Analyzer("FUN003", Categories.Paradigm, Title = "Mutable state", Severity = Severity.Minor, Paradigms = [Paradigms.Functional],
    Description = "Reports reassigned locals, mutable instance fields and settable properties.")]
public sealed class MutableStateAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var callable in context.Callables)
        {
            var flow = DataFlow.Analyze(callable.Body);
            var counters = callable.Body.All<LoopStatement>().SelectMany(l => l.Initializers.OfType<LocalDeclaration>()).Select(l => l.Name).ToHashSet();
            var reassigned = flow.LocalWrites.Where(w => flow.LocalDeclarations.Contains(w) && !counters.Contains(w)).Order(StringComparer.Ordinal).ToList();
            if (reassigned.Count > 0)
                context.Report(Confidence.Medium, callable.Location, $"{callable.Name} reassigns {string.Join(", ", reassigned)}",
                    $"In functional style a new value gets a new name. Reassignment makes the meaning of a variable depend on the position in the code.", symbol: callable.Id);
        }

        foreach (var type in context.Types.Where(t => t.Kind is TypeKind.Class or TypeKind.Record or TypeKind.Struct))
        {
            var mutable = type.Fields.Where(f => !f.IsReadOnly && !f.IsStatic).Select(f => f.Name)
                .Concat(type.Properties.Where(p => p.SetterVisibility is not null).Select(p => p.Name)).ToList();
            if (mutable.Count > 0)
                context.Report(type, Confidence.Medium, $"{type.Name} has mutable members: {string.Join(", ", mutable)}",
                    $"Instances can change after construction, so a value's meaning depends on time.");
        }
    }
}

/// <summary>Flags recursion that grows the stack.</summary>
[Analyzer("FUN004", Categories.Paradigm, Title = "Non-tail recursion", Severity = Severity.Minor, Paradigms = [Paradigms.Functional],
    Description = "A self-call whose result is used further cannot be turned into a loop by tail-call elimination.")]
public sealed class NonTailRecursionAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var callable in context.Callables.Where(c => c.Body is not null))
        {
            var calls = callable.Body.All<InvocationExpression>().Where(i => i.Target.Id == callable.Id).ToList();
            if (calls.Count == 0) continue;
            var tail = new HashSet<IrNode>(ReferenceEqualityComparer.Instance);
            foreach (var exit in callable.Body.All<ReturnStatement>()) CollectTail(exit.Value, tail);
            var offending = calls.FirstOrDefault(c => !tail.Contains(c));
            if (offending is not null)
                context.Report(Confidence.High, offending.Location, $"{callable.Name} recurses outside tail position",
                    $"Work remains after the self-call returns, so each level keeps a stack frame; deep input can overflow the stack.", symbol: callable.Id);
        }
    }

    private static void CollectTail(Expression? expression, HashSet<IrNode> tail)
    {
        switch (expression)
        {
            case InvocationExpression call:
                tail.Add(call);
                break;
            case ConditionalExpression branch:
                CollectTail(branch.WhenTrue, tail);
                CollectTail(branch.WhenFalse, tail);
                break;
        }
    }
}

/// <summary>Measures the order of higher-order functions.</summary>
[Analyzer("FUN005", Categories.Paradigm, Title = "Higher-order depth", Severity = Severity.Minor, Paradigms = [Paradigms.Functional],
    Description = "Order 1 takes plain data, order 2 takes functions, order 3 takes functions of functions; high orders and nested lambdas are hard to follow.")]
public sealed class HigherOrderDepthAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var maxOrder = context.Options.Int("maxOrder", 3);
        var maxLambdaNesting = context.Options.Int("maxLambdaNesting", 3);
        foreach (var callable in context.Callables)
        {
            var order = CallableMetrics.HofOrder(callable);
            var nesting = CallableMetrics.LambdaNesting(callable);
            context.Report(new Metric("hofOrder", MetricScope.Callable, callable.Id, order));
            if (order > maxOrder)
                context.Report(Confidence.High, callable.Location, $"{callable.Name} is a function of order {order}",
                    $"The signature nests function types beyond order {maxOrder}.", symbol: callable.Id, measured: new Measurement("hofOrder", order, maxOrder));
            if (nesting > maxLambdaNesting)
                context.Report(Confidence.High, callable.Location, $"{callable.Name} nests lambdas {nesting} levels deep",
                    $"Beyond {maxLambdaNesting} levels, captured variables are hard to trace; named functions help.", symbol: callable.Id, measured: new Measurement("lambdaNesting", nesting, maxLambdaNesting));
        }
    }
}
