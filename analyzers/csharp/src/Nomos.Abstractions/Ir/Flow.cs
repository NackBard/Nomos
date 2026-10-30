namespace Nomos.Abstractions.Ir;

/// <summary>Language-independent control-flow queries over IR bodies.</summary>
public static class ControlFlow
{
    /// <summary>Computes McCabe cyclomatic complexity from decision points, lambdas included.</summary>
    /// <param name="callable">The callable.</param>
    public static int CyclomaticComplexity(Callable callable)
    {
        var complexity = 1;
        if (callable.Body is null) return complexity;
        foreach (var node in callable.Body.DescendantsAndSelf())
        {
            complexity += node switch
            {
                IfStatement or LoopStatement or ConditionalExpression or CatchClause => 1,
                SwitchSection section => section.Labels.Count > 0 ? 1 : 0,
                SwitchArm arm => arm.Pattern is null ? 0 : 1,
                BinaryExpression { Operator: "&&" or "||" or "??" or "and" or "or" } => 1,
                _ => 0,
            };
        }
        return complexity;
    }

    /// <summary>Computes the deepest nesting of control structures.</summary>
    /// <param name="body">The body.</param>
    public static int MaxNesting(Statement? body) => body is null ? 0 : Nesting(body, 0);

    private static int Nesting(IrNode node, int depth)
    {
        var nests = node is IfStatement or LoopStatement or SwitchStatement or TryStatement or ScopedStatement;
        // An "else if" stays at the depth of its parent, as it reads as a flat chain.
        var own = nests ? depth + 1 : depth;
        var result = own;
        foreach (var child in node.Children)
        {
            if (node is IfStatement parent && ReferenceEquals(child, parent.Else) && child is IfStatement)
                result = Math.Max(result, Nesting(child, depth));
            else
                result = Math.Max(result, Nesting(child, own));
        }
        return result;
    }

    /// <summary>Finds statements that can never run because the previous one always leaves the block.</summary>
    /// <param name="body">The body.</param>
    public static IReadOnlyList<Statement> UnreachableStatements(Statement? body)
    {
        var result = new List<Statement>();
        if (body is not null) Visit(body, result);
        return result;
    }

    private static void Visit(IrNode node, List<Statement> found)
    {
        if (node is BlockStatement block)
        {
            for (var i = 0; i < block.Statements.Count - 1; i++)
            {
                if (CanComplete(block.Statements[i])) continue;
                // Labels and local functions are reachable regardless of what precedes them.
                var next = block.Statements[i + 1];
                if (next is LabeledStatement or LocalFunctionStatement) continue;
                found.Add(next);
                break;
            }
        }
        foreach (var child in node.Children) Visit(child, found);
    }

    /// <summary>Gets whether execution can flow past a statement; conservative: returns true when unsure.</summary>
    /// <param name="statement">The statement.</param>
    public static bool CanComplete(Statement statement) => statement switch
    {
        ReturnStatement or ThrowStatement or BreakStatement or ContinueStatement or GotoStatement => false,
        BlockStatement block => block.Statements.All(CanComplete) || block.Statements.Any(s => s is LabeledStatement),
        IfStatement { Else: not null } branch => CanComplete(branch.Then) || CanComplete(branch.Else),
        ScopedStatement scoped => CanComplete(scoped.Body),
        LabeledStatement labeled => CanComplete(labeled.Inner),
        _ => true,
    };
}

/// <summary>What a callable reads, writes and calls.</summary>
public sealed class DataFlowFacts
{
    /// <summary>Gets names of locals and parameters that are read.</summary>
    public HashSet<string> LocalReads { get; } = [];

    /// <summary>Gets names of locals and parameters that are reassigned after declaration.</summary>
    public HashSet<string> LocalWrites { get; } = [];

    /// <summary>Gets declared local variable names.</summary>
    public HashSet<string> LocalDeclarations { get; } = [];

    /// <summary>Gets instance or static fields and properties that are read.</summary>
    public List<SymbolRef> MemberReads { get; } = [];

    /// <summary>Gets instance or static fields and properties that are assigned, with the write location.</summary>
    public List<(SymbolRef Symbol, SourceLocation Location)> MemberWrites { get; } = [];

    /// <summary>Gets parameters whose object state is mutated through member assignment.</summary>
    public HashSet<string> MutatedParameters { get; } = [];

    /// <summary>Gets all invocations.</summary>
    public List<InvocationExpression> Invocations { get; } = [];
}

/// <summary>Flow-insensitive data-flow extraction over IR.</summary>
public static class DataFlow
{
    /// <summary>Collects data-flow facts of a body.</summary>
    /// <param name="root">The body or expression; nested lambdas are included.</param>
    public static DataFlowFacts Analyze(IrNode? root)
    {
        var facts = new DataFlowFacts();
        if (root is null) return facts;
        var writeTargets = new HashSet<IrNode>(ReferenceEqualityComparer.Instance);
        foreach (var node in root.DescendantsAndSelf())
        {
            switch (node)
            {
                case AssignmentExpression assignment:
                    RecordWrite(assignment.Target, assignment.Target.Location, facts, writeTargets);
                    // A compound assignment also reads its target.
                    if (assignment.Operator != "=") writeTargets.Remove(assignment.Target);
                    break;
                case UnaryExpression { IsMutation: true } unary:
                    RecordWrite(unary.Operand, unary.Location, facts, writeTargets);
                    writeTargets.Remove(unary.Operand);
                    break;
                case LocalDeclaration local:
                    facts.LocalDeclarations.Add(local.Name);
                    break;
                case InvocationExpression invocation:
                    facts.Invocations.Add(invocation);
                    break;
                case NameExpression name when !writeTargets.Contains(name):
                    RecordRead(name.Symbol, facts);
                    break;
                case MemberAccessExpression access when !writeTargets.Contains(access):
                    RecordRead(access.Member, facts);
                    break;
            }
        }
        return facts;
    }

    private static void RecordRead(SymbolRef symbol, DataFlowFacts facts)
    {
        if (symbol.Kind is SymbolKind.Local or SymbolKind.Parameter) facts.LocalReads.Add(symbol.Name);
        else if (symbol.Kind is SymbolKind.Field or SymbolKind.Property) facts.MemberReads.Add(symbol);
    }

    private static void RecordWrite(Expression target, SourceLocation location, DataFlowFacts facts, HashSet<IrNode> writeTargets)
    {
        writeTargets.Add(target);
        switch (target)
        {
            case NameExpression { Symbol.Kind: SymbolKind.Local or SymbolKind.Parameter } name:
                facts.LocalWrites.Add(name.Symbol.Name);
                break;
            case NameExpression { Symbol.Kind: SymbolKind.Field or SymbolKind.Property } name:
                facts.MemberWrites.Add((name.Symbol, location));
                break;
            case MemberAccessExpression access when access.Member.Kind is SymbolKind.Field or SymbolKind.Property:
                facts.MemberWrites.Add((access.Member, location));
                if (access.Target is NameExpression { Symbol.Kind: SymbolKind.Parameter } owner) facts.MutatedParameters.Add(owner.Symbol.Name);
                break;
            case ElementAccessExpression { Target: NameExpression { Symbol.Kind: SymbolKind.Parameter } indexed }:
                facts.MutatedParameters.Add(indexed.Symbol.Name);
                break;
            case ElementAccessExpression { Target: NameExpression { Symbol.Kind: SymbolKind.Field or SymbolKind.Property } indexed }:
                facts.MemberWrites.Add((indexed.Symbol, location));
                break;
        }
    }
}
