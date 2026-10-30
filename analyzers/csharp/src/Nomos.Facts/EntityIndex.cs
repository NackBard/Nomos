using Nomos.Abstractions.Ir;

namespace Nomos.Facts;

/// <summary>
/// Ids of types and functions as they appear in facts. The same ids go into SARIF (<c>properties.entity</c>), so
/// a result can be matched with the entity it is about.
/// </summary>
internal sealed class EntityIndex
{
    private readonly Dictionary<string, string> _functionIds = new(StringComparer.Ordinal);

    public EntityIndex(ProjectModel model)
    {
        Model = model;
        Types = [.. model.AllTypes.OrderBy(t => t.Id, StringComparer.Ordinal)];
        TypeIds = [.. Types.Select(t => t.Id)];
        AssignFunctionIds();
    }

    public ProjectModel Model { get; }

    public IReadOnlyList<TypeDecl> Types { get; }

    public HashSet<string> TypeIds { get; }

    public IReadOnlyDictionary<string, string> FunctionIds => _functionIds;

    /// <summary>Functions listed in facts: methods, constructors and free functions. Accessors and local functions are part of their owner.</summary>
    public IEnumerable<(Callable Callable, ModuleDecl Module, TypeDecl? Owner)> Callables() =>
        Model.Modules.SelectMany(m => m.AllTypes.SelectMany(t => t.Callables.Where(IsListed).Select(c => (c, m, (TypeDecl?)t)))
            .Concat(m.Functions.Select(f => (f, m, (TypeDecl?)null))));

    /// <summary>Finds the type or function a symbol id belongs to; members that are not functions resolve to their type.</summary>
    public string? Resolve(string? symbol)
    {
        if (string.IsNullOrEmpty(symbol)) return null;
        if (_functionIds.TryGetValue(symbol, out var function)) return function;
        if (TypeIds.Contains(symbol)) return symbol;
        var current = symbol.Contains('(') ? symbol[..symbol.IndexOf('(')] : symbol;
        for (var cut = current.LastIndexOf('.'); cut > 0; cut = current.LastIndexOf('.'))
        {
            current = current[..cut];
            if (TypeIds.Contains(current)) return current;
        }
        return null;
    }

    private static bool IsListed(Callable callable) => callable.Kind is not (CallableKind.Accessor or CallableKind.LocalFunction);

    /// <summary>Id is <c>Type.Name</c>; overloads keep the full IR id with the parameter types so ids stay unique.</summary>
    private void AssignFunctionIds()
    {
        var all = Callables().ToList();
        var counts = all.GroupBy(x => Key(x.Owner, x.Callable, x.Module), StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);
        foreach (var (callable, module, owner) in all)
        {
            var unique = counts[Key(owner, callable, module)] == 1;
            _functionIds[callable.Id] = unique ? $"{owner?.Id ?? module.Name}.{callable.Name}" : callable.Id;
        }
    }

    private static string Key(TypeDecl? owner, Callable callable, ModuleDecl module) => owner?.Id + "\0" + callable.Name + "\0" + module.Name;
}
