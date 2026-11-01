namespace Nomos.Abstractions.Ir;

/// <summary>A growth estimate: n^Degree * (log n)^LogFactor, or exponential (spec/metrics.md).</summary>
/// <param name="Degree">Power of n.</param>
/// <param name="LogFactor">Power of log n.</param>
/// <param name="Exponential">Whether the estimate is exponential; the powers then mean nothing.</param>
/// <param name="Uncertain">Whether the estimate rests on recursion, a while loop or a callee.</param>
public readonly record struct Growth(int Degree, int LogFactor, bool Exponential, bool Uncertain)
{
    internal static Growth Constant { get; } = new(0, 0, false, false);
    internal static Growth Linear { get; } = new(1, 0, false, false);
    internal static Growth Logarithmic { get; } = new(0, 1, false, false);

    internal Growth Times(Growth other) => new(Degree + other.Degree, LogFactor + other.LogFactor, Exponential || other.Exponential, Uncertain || other.Uncertain);

    internal Growth Or(Growth other)
    {
        var uncertain = Uncertain || other.Uncertain;
        var larger = (Exponential, Degree, LogFactor).CompareTo((other.Exponential, other.Degree, other.LogFactor)) >= 0 ? this : other;
        return larger with { Uncertain = uncertain };
    }

    /// <inheritdoc />
    public override string ToString()
    {
        if (Exponential) return "O(2ⁿ)";
        var power = Degree switch { 0 => "", 1 => "n", 2 => "n²", 3 => "n³", _ => $"n^{Degree}" };
        var log = LogFactor switch { 0 => "", 1 => "log n", _ => $"log^{LogFactor} n" };
        var body = $"{power} {log}".Trim();
        return $"O({(body.Length == 0 ? "1" : body)})";
    }
}

/// <summary>Time estimates of a whole model by spec/metrics.md, shared by facts and analyzers.</summary>
public static class ComplexityEstimates
{
    /// <summary>
    /// Estimates every callable with a body. Callables go in ordinal id order: mutual recursion is cut at the callable
    /// still being estimated, so another order could give another value and facts could disagree with a finding.
    /// </summary>
    /// <param name="model">The project model.</param>
    public static IReadOnlyDictionary<string, Growth> Time(ProjectModel model)
    {
        var estimator = new Estimator(model);
        var result = new Dictionary<string, Growth>(StringComparer.Ordinal);
        foreach (var callable in model.Modules.SelectMany(m => m.AllCallables).Where(c => c.Body is not null).OrderBy(c => c.Id, StringComparer.Ordinal))
            result[callable.Id] = estimator.Estimate(callable);
        return result;
    }
}

/// <summary>Estimates time complexity from loop structure, known linear calls and recursion shape.</summary>
internal sealed class Estimator(ProjectModel model)
{
    private static readonly HashSet<string> LinearCalls =
    [
        "Contains", "IndexOf", "LastIndexOf", "Find", "FindIndex", "FindAll", "Exists", "Where", "Select", "SelectMany", "Any", "All",
        "First", "FirstOrDefault", "Last", "LastOrDefault", "Single", "SingleOrDefault", "Count", "Sum", "Min", "Max", "Average",
        "Aggregate", "ToList", "ToArray", "ToDictionary", "ToHashSet", "Distinct", "Reverse", "ForEach", "Join", "Concat", "Except", "Intersect",
    ];

    private static readonly HashSet<string> SortCalls = ["Sort", "OrderBy", "OrderByDescending", "ThenBy", "ThenByDescending"];
    private static readonly string[] ConstantLookupTypes = ["HashSet", "Dictionary", "ISet", "IDictionary", "ConcurrentDictionary", "FrozenSet", "FrozenDictionary", "IReadOnlyDictionary"];

    private readonly Dictionary<string, Growth> _memo = [];
    private readonly HashSet<string> _active = [];

    // Names bound to one element of an enclosing iteration. Walking such an element's own
    // children is a hierarchy traversal: linear in total size, so it does not multiply.
    private HashSet<string> _elements = [];

    public Growth Estimate(Callable callable)
    {
        if (_memo.TryGetValue(callable.Id, out var known)) return known;
        if (callable.Body is null || !_active.Add(callable.Id)) return Growth.Constant;
        var outer = _elements;
        _elements = [];
        var growth = Combine(callable, Cost(callable.Body));
        _elements = outer;
        _active.Remove(callable.Id);
        return _memo[callable.Id] = growth;
    }

    private Growth Cost(IrNode node)
    {
        switch (node)
        {
            case LoopStatement loop:
                var header = loop.Initializers.Cast<IrNode>().Concat(loop.Iterable is null ? [] : [loop.Iterable]).Aggregate(Growth.Constant, (g, n) => g.Or(Cost(n)));
                var added = loop.Variable is not null && _elements.Add(loop.Variable);
                var iteration = Cost(loop.Body);
                if (loop.Condition is not null) iteration = iteration.Or(Cost(loop.Condition));
                if (added) _elements.Remove(loop.Variable!);
                return header.Or((IsElementWalk(loop.Iterable) ? Growth.Constant : LoopFactor(loop)).Times(iteration));
            case LocalDeclaration { Initializer: { } initializer } local:
                if (IsElementWalk(initializer)) _elements.Add(local.Name);
                return Cost(initializer);
            case InvocationExpression call:
                return InvocationCost(call);
            default:
                return node.Children.Aggregate(Growth.Constant, (g, n) => g.Or(Cost(n)));
        }
    }

    private Growth InvocationCost(InvocationExpression call)
    {
        var parts = call.Children.Where(c => c is not LambdaExpression).Aggregate(Growth.Constant, (g, n) => g.Or(Cost(n)));
        var lambdas = call.Arguments.OfType<LambdaExpression>().ToList();
        var bound = lambdas.SelectMany(l => l.Parameters).Select(p => p.Name).Where(_elements.Add).ToList();
        var lambda = lambdas.Aggregate(Growth.Constant, (g, l) => g.Or(Cost(l.Body)));
        _elements.ExceptWith(bound);
        var receiver = call.Receiver?.Type;
        var isConstantLookup = receiver is { Kind: TypeRefKind.Primitive } || (receiver is not null && ConstantLookupTypes.Contains(receiver.SimpleName));
        if (call.Target.IsExternal || call.Target.Id is null)
        {
            if (SortCalls.Contains(call.Target.Name)) return parts.Or(new Growth(1, 1, false, false));
            if (LinearCalls.Contains(call.Target.Name) && !isConstantLookup) return parts.Or((IsElementWalk(call.Receiver) ? Growth.Constant : Growth.Linear).Times(lambda));
            return parts.Or(lambda);
        }
        var target = model.FindCallable(call.Target.Id);
        if (target is null) return parts.Or(lambda);
        var callee = Estimate(target);
        return parts.Or(lambda).Or(callee.Degree > 0 || callee.LogFactor > 0 || callee.Exponential ? callee with { Uncertain = true } : callee);
    }

    private bool IsElementWalk(Expression? expression) => expression switch
    {
        NameExpression name => _elements.Contains(name.Symbol.Name),
        MemberAccessExpression access => IsElementWalk(access.Target),
        ElementAccessExpression element => IsElementWalk(element.Target),
        InvocationExpression call => IsElementWalk(call.Receiver),
        _ => false,
    };

    private static Growth LoopFactor(LoopStatement loop)
    {
        if (loop.Iterable is CollectionExpression) return Growth.Constant;
        if (loop.Kind == LoopKind.ForEach) return Growth.Linear;

        var updates = loop.Updates.Concat(loop.Body.All<AssignmentExpression>()).Concat(loop.Body.All<LocalDeclaration>().Select(l => l.Initializer).OfType<Expression>());
        var halves = updates.Any(IsHalving);
        if (loop.Kind == LoopKind.For)
        {
            if (loop.Updates.Any(IsHalving)) return Growth.Logarithmic;
            var bounded = loop.Condition is BinaryExpression { Right: LiteralExpression { Kind: LiteralKind.Number } } && loop.Initializers.All(i => i is LocalDeclaration { Initializer: LiteralExpression });
            return bounded ? Growth.Constant : Growth.Linear;
        }
        return (halves ? Growth.Logarithmic : Growth.Linear) with { Uncertain = true };
    }

    private static bool IsHalving(Expression expression) => expression switch
    {
        AssignmentExpression { Operator: "/=" or ">>=" or "*=" or "<<=" } => true,
        AssignmentExpression { Value: var value } => DividesByTwo(value),
        _ => DividesByTwo(expression),
    };

    private static bool DividesByTwo(Expression expression) =>
        expression.All<BinaryExpression>().Any(b => b is { Operator: "/" or ">>", Right: LiteralExpression { Value: "2" or "1" } });

    private static Growth Combine(Callable callable, Growth work)
    {
        var body = callable.Body!;
        var self = body.All<InvocationExpression>().Where(i => i.Target.Id == callable.Id).ToList();
        if (self.Count == 0) return work;

        var halfNames = body.All<LocalDeclaration>().Where(l => l.Initializer is not null && DividesByTwo(l.Initializer)).Select(l => l.Name).ToHashSet();
        var halving = self.Any(c => c.Arguments.Any(a => DividesByTwo(a) || a.All<NameExpression>().Any(n => halfNames.Contains(n.Symbol.Name))));
        var memoized = body.All<InvocationExpression>().Any(i => i.Target.Name is "TryGetValue" or "ContainsKey");
        var perPath = CallsOnPath(body, callable.Id);
        var decrements = self.Any(c => c.Arguments.Any(a => a.All<BinaryExpression>().Any(b => b.Operator is "-" or "+")));

        var recursion = (perPath, halving) switch
        {
            (<= 1, true) => Growth.Logarithmic,
            (<= 1, false) => Growth.Linear,
            (_, true) => new Growth(1, 0, false, false),
            _ => memoized || !decrements ? Growth.Linear : new Growth(0, 0, true, false),
        };
        // A recursion that follows members or elements walks a structure: each node is visited once,
        // so a loop over children in the body must not multiply with the number of nodes.
        var total = perPath > 1 && halving ? work.Or(Growth.Linear).Times(Growth.Logarithmic)
            : !halving && !decrements ? work.Or(Growth.Linear)
            : recursion.Times(work);
        return total with { Uncertain = true };
    }

    /// <summary>Counts self-calls on the worst execution path, so exclusive branches do not add up.</summary>
    private static int CallsOnPath(IrNode node, string id)
    {
        switch (node)
        {
            case IfStatement branch:
                return CallsOnPath(branch.Condition, id) + Math.Max(CallsOnPath(branch.Then, id), branch.Else is null ? 0 : CallsOnPath(branch.Else, id));
            case ConditionalExpression ternary:
                return CallsOnPath(ternary.Condition, id) + Math.Max(CallsOnPath(ternary.WhenTrue, id), CallsOnPath(ternary.WhenFalse, id));
            case SwitchStatement choice:
                return choice.Sections.Select(s => CallsOnPath(s, id)).DefaultIfEmpty(0).Max();
            case SwitchExpression choice:
                return choice.Arms.Select(a => CallsOnPath(a, id)).DefaultIfEmpty(0).Max();
            case BlockStatement block:
                return BlockCalls(block.Statements, 0, id);
            default:
                var own = node is InvocationExpression call && call.Target.Id == id ? 1 : 0;
                return own + node.Children.Sum(c => CallsOnPath(c, id));
        }
    }

    private static int BlockCalls(IReadOnlyList<Statement> statements, int index, string id)
    {
        if (index >= statements.Count) return 0;
        // A guard that always exits is exclusive with the rest of the block.
        return statements[index] is IfStatement { Else: null } guard && !ControlFlow.CanComplete(guard.Then)
            ? CallsOnPath(guard.Condition, id) + Math.Max(CallsOnPath(guard.Then, id), BlockCalls(statements, index + 1, id))
            : CallsOnPath(statements[index], id) + BlockCalls(statements, index + 1, id);
    }
}
