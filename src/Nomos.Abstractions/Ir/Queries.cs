namespace Nomos.Abstractions.Ir;

/// <summary>Reusable structural queries over IR.</summary>
public static class IrQueries
{
    private static readonly HashSet<string> StubExceptions = ["NotImplementedException", "NotSupportedException"];

    /// <summary>Gets descendant nodes of a given type, the root included.</summary>
    /// <typeparam name="T">Node type.</typeparam>
    /// <param name="root">Root node; null yields nothing.</param>
    public static IEnumerable<T> All<T>(this IrNode? root) where T : IrNode =>
        root is null ? [] : root.DescendantsAndSelf().OfType<T>();

    /// <summary>Gets nodes together with the number of loops enclosing them.</summary>
    /// <param name="root">Root node.</param>
    public static IEnumerable<(IrNode Node, int LoopDepth)> WithLoopDepth(this IrNode? root)
    {
        if (root is null) yield break;
        var stack = new Stack<(IrNode Node, int Depth)>();
        stack.Push((root, 0));
        while (stack.Count > 0)
        {
            var (node, depth) = stack.Pop();
            yield return (node, depth);
            var inner = node is LoopStatement ? depth + 1 : depth;
            foreach (var child in node.Children.Reverse())
            {
                // A loop's iterable and initializers run once per entry, not once per iteration.
                var isHeader = node is LoopStatement loop && (ReferenceEquals(child, loop.Iterable) || loop.Initializers.Contains(child));
                stack.Push((child, isHeader ? depth : inner));
            }
        }
    }

    /// <summary>Gets whether a body does nothing but throw a "not implemented" style exception.</summary>
    /// <param name="callable">The callable.</param>
    public static bool IsStub(Callable callable)
    {
        if (callable.Body?.Statements is not [var only]) return false;
        return ThrownType(only) is { } name && StubExceptions.Contains(name);
    }

    private static string? ThrownType(Statement statement) => statement switch
    {
        ThrowStatement { Value: ObjectCreationExpression creation } => creation.CreatedType.SimpleName,
        ReturnStatement { Value: OpaqueExpression { Inner: [ObjectCreationExpression creation] } } => creation.CreatedType.SimpleName,
        ExpressionStatement { Expression: OpaqueExpression { Inner: [ObjectCreationExpression creation] } } => creation.CreatedType.SimpleName,
        _ => null,
    };

    /// <summary>Gets whether a type is a test fixture, judged by attributes on its methods.</summary>
    /// <param name="type">The type.</param>
    public static bool IsTestClass(TypeDecl type) =>
        type.Callables.Any(c => c.Attributes.Any(a => a.Name is "Fact" or "Theory" or "Test" or "TestMethod" or "TestCase"));
}

/// <summary>Object-oriented measures shared by analyzers.</summary>
public static class TypeMetrics
{
    /// <summary>Gets the members of its own type a callable touches, as identifiers.</summary>
    /// <param name="callable">The callable.</param>
    /// <param name="type">The declaring type.</param>
    public static HashSet<string> OwnMembersUsed(Callable callable, TypeDecl type)
    {
        var members = type.Fields.Select(f => f.Id).Concat(type.Properties.Select(p => p.Id)).ToHashSet();
        var used = new HashSet<string>();
        foreach (var node in callable.Body.All<Expression>())
        {
            var symbol = node switch
            {
                NameExpression name => name.Symbol,
                MemberAccessExpression access => access.Member,
                _ => null,
            };
            if (symbol?.Id is { } id && members.Contains(id)) used.Add(id);
        }
        return used;
    }

    /// <summary>
    /// Computes LCOM4: the number of connected components among instance methods,
    /// where two methods connect when they share a member or one calls the other.
    /// </summary>
    /// <param name="type">The type.</param>
    public static int Lcom4(TypeDecl type)
    {
        var methods = type.Callables.Where(c => c.Kind == CallableKind.Method && !c.Has(Modifiers.Static) && c.Body is not null).ToList();
        if (methods.Count == 0) return 0;

        var parent = Enumerable.Range(0, methods.Count).ToArray();
        int Find(int i) => parent[i] == i ? i : parent[i] = Find(parent[i]);
        var used = methods.Select(m => OwnMembersUsed(m, type)).ToList();
        var calls = methods.Select(m => m.Body.All<InvocationExpression>().Select(i => i.Target.Id).OfType<string>().ToHashSet()).ToList();

        for (var i = 0; i < methods.Count; i++)
        {
            for (var j = i + 1; j < methods.Count; j++)
            {
                if (used[i].Overlaps(used[j]) || calls[i].Contains(methods[j].Id) || calls[j].Contains(methods[i].Id))
                    parent[Find(i)] = Find(j);
            }
        }
        return Enumerable.Range(0, methods.Count).Select(Find).Distinct().Count();
    }

    /// <summary>Computes Tight Class Cohesion: the share of method pairs that use a common member.</summary>
    /// <param name="type">The type.</param>
    public static double Tcc(TypeDecl type)
    {
        var used = type.Callables.Where(c => c.Kind == CallableKind.Method && c.Body is not null).Select(m => OwnMembersUsed(m, type)).ToList();
        if (used.Count < 2) return 1;
        var connected = 0;
        for (var i = 0; i < used.Count; i++)
            for (var j = i + 1; j < used.Count; j++)
                if (used[i].Overlaps(used[j])) connected++;
        return connected / (used.Count * (used.Count - 1) / 2.0);
    }

    /// <summary>Computes Weighted Methods per Class as the sum of cyclomatic complexities.</summary>
    /// <param name="type">The type.</param>
    public static int Wmc(TypeDecl type) => type.Callables.Sum(ControlFlow.CyclomaticComplexity);

    /// <summary>Gets foreign data used by a callable: fields and properties of other project types, by owner.</summary>
    /// <param name="callable">The callable.</param>
    /// <param name="model">The project model.</param>
    public static Dictionary<string, HashSet<string>> ForeignData(Callable callable, ProjectModel model)
    {
        var result = new Dictionary<string, HashSet<string>>();
        foreach (var access in callable.Body.All<MemberAccessExpression>())
        {
            var member = access.Member;
            if (member.Kind is not (SymbolKind.Field or SymbolKind.Property) || member.IsExternal || member.IsStatic) continue;
            if (member.DeclaringTypeId is not { } owner || owner == callable.DeclaringTypeId || model.FindType(owner) is null) continue;
            if (!result.TryGetValue(owner, out var members)) result[owner] = members = [];
            members.Add(member.Name);
        }
        return result;
    }
}
