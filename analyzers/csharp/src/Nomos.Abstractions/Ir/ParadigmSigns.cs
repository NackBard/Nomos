using System.Runtime.CompilerServices;

namespace Nomos.Abstractions.Ir;

/// <summary>One kind of paradigm evidence in a module (spec/paradigms.md).</summary>
/// <param name="Paradigm">Paradigm the evidence belongs to.</param>
/// <param name="Kind">Evidence kind, e.g. <c>oop.classes</c>.</param>
/// <param name="Count">How many entities show it.</param>
/// <param name="Description">What is counted.</param>
/// <param name="Examples">Up to five identifiers of the model (type ids and callable ids), in ordinal order.</param>
public sealed record EvidenceItem(string Paradigm, string Kind, int Count, string Description, IReadOnlyList<string> Examples);

/// <summary>
/// Finds the signs of paradigms in modules by spec/paradigms.md. The engine uses it to run a rule only where its
/// paradigm shows, and the facts writer reports it, so both always agree.
/// </summary>
public static class ParadigmSigns
{
    private const int LambdaActivation = 3;
    private static readonly ConditionalWeakTable<ProjectModel, HashSet<string>> PureCache = [];

    /// <summary>Collects the evidence of a module.</summary>
    /// <param name="model">The project model.</param>
    /// <param name="module">The module.</param>
    public static IReadOnlyList<EvidenceItem> Collect(ProjectModel model, ModuleDecl module)
    {
        var result = new List<EvidenceItem>();
        var types = module.AllTypes.ToList();
        var callables = module.AllCallables.Where(c => c.Kind != CallableKind.Accessor).ToList();
        var pure = PureFunctions(model);
        static bool IsClassLike(TypeDecl t) => t.Kind is TypeKind.Class or TypeKind.Struct or TypeKind.Record;

        Add(result, Paradigms.ObjectOriented, "oop.classes", "classes with methods or fields",
            types.Where(t => IsClassLike(t) && t.Fields.Count + t.Properties.Count + t.Callables.Count(c => c.Kind != CallableKind.Accessor) > 0).Select(t => t.Id));
        Add(result, Paradigms.ObjectOriented, "oop.mutable-state-classes", "classes with mutable instance state",
            types.Where(t => IsClassLike(t) && HasMutableInstanceState(t)).Select(t => t.Id));
        Add(result, Paradigms.ObjectOriented, "oop.inheritance", "project types inheriting project types",
            types.Where(t => t.Kind == TypeKind.Class && model.FindType(t.BaseType?.Id) is not null).Select(t => t.Id));
        Add(result, Paradigms.ObjectOriented, "oop.abstractions", "interfaces and abstract classes", types.Where(t => t.IsAbstract).Select(t => t.Id));

        Add(result, Paradigms.Structural, "str.free-functions", "functions outside types", module.Functions.Select(f => f.Id));
        Add(result, Paradigms.Structural, "str.control-flow", "functions with branches or loops", callables.Where(HasControlFlow).Select(c => c.Id));
        Add(result, Paradigms.Structural, "str.global-state", "module-level variables and static mutable state",
            module.Globals.Select(g => g.Id).Concat(types.SelectMany(t => t.Fields.Where(f => f.IsStatic && !f.IsReadOnly && !f.IsConstant).Select(f => f.Id))));

        var lambdaOwners = callables.SelectMany(c => c.Body.All<InvocationExpression>().SelectMany(i => i.Arguments.OfType<LambdaExpression>()).Select(_ => c.Id)).ToList();
        Add(result, Paradigms.Functional, "fp.lambdas", "lambdas passed as arguments", lambdaOwners, count: lambdaOwners.Count);
        Add(result, Paradigms.Functional, "fp.higher-order", "functions taking or returning functions", callables
            .Where(c => c.Parameters.Any(p => p.Type?.Kind == TypeRefKind.Function) || c.ReturnType?.Kind == TypeRefKind.Function).Select(c => c.Id));
        Add(result, Paradigms.Functional, "fp.pure-functions", "functions that provably have no effects (conservative)", callables.Where(c => pure.Contains(c.Id)).Select(c => c.Id));
        Add(result, Paradigms.Functional, "fp.immutable-types", "types without mutable state", types.Where(t => IsClassLike(t) && IsImmutable(t)).Select(t => t.Id));

        return [.. result.OrderBy(e => e.Kind, StringComparer.Ordinal)];
    }

    /// <summary>The paradigms a module shows, by the activation column of spec/paradigms.md.</summary>
    /// <param name="evidence">Evidence of the module.</param>
    public static HashSet<string> ActiveParadigms(IEnumerable<EvidenceItem> evidence)
    {
        var active = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in evidence)
        {
            var activates = item.Kind switch
            {
                "oop.classes" or "str.free-functions" or "str.control-flow" or "fp.higher-order" or "fp.pure-functions" => true,
                "fp.lambdas" => item.Count >= LambdaActivation,
                _ => false,
            };
            if (activates) active.Add(item.Paradigm);
        }
        return active;
    }

    /// <summary>
    /// Gets whether a rule bound to paradigms applies to a module that shows the given ones. A rule without paradigms
    /// always applies. The set of paradigms is open, but only oop, functional and structural have defined evidence
    /// (spec/paradigms.md); a rule bound to any other paradigm cannot be judged per module and keeps applying.
    /// </summary>
    /// <param name="ruleParadigms">Paradigms of the rule.</param>
    /// <param name="active">Paradigms the module shows.</param>
    public static bool Applies(IReadOnlyList<string> ruleParadigms, HashSet<string> active) =>
        ruleParadigms.Count == 0 || ruleParadigms.Any(p => active.Contains(p) || !HasEvidence(p));

    private static bool HasEvidence(string paradigm) => paradigm is Paradigms.ObjectOriented or Paradigms.Functional or Paradigms.Structural;

    /// <summary>Explains why a rule was skipped for a module without its paradigm.</summary>
    /// <param name="paradigm">The paradigm of the rule.</param>
    public static string NotApplicable(string paradigm) => paradigm switch
    {
        Paradigms.ObjectOriented => "OOP rule not applicable: module has no classes",
        Paradigms.Functional => "Functional rule not applicable: module shows no functional style",
        Paradigms.Structural => "Structural rule not applicable: module has no free functions or branching",
        _ => $"Rule for paradigm '{paradigm}' not applicable: no evidence of it in the module",
    };

    private static void Add(List<EvidenceItem> result, string paradigm, string kind, string description, IEnumerable<string> ids, int? count = null)
    {
        var list = ids.ToList();
        var total = count ?? list.Count;
        if (total == 0) return;
        result.Add(new EvidenceItem(paradigm, kind, total, description, [.. list.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).Take(5)]));
    }

    private static bool HasControlFlow(Callable callable) =>
        callable.Body.All<IfStatement>().Any() || callable.Body.All<LoopStatement>().Any() || callable.Body.All<SwitchStatement>().Any()
        || callable.Body.All<ConditionalExpression>().Any() || callable.Body.All<SwitchExpression>().Any();

    private static bool HasMutableInstanceState(TypeDecl type) =>
        type.Fields.Any(f => !f.IsStatic && !f.IsReadOnly && !f.IsConstant) || type.Properties.Any(p => !p.IsStatic && p.SetterVisibility is not null && !p.IsInitOnly);

    private static bool IsImmutable(TypeDecl type)
    {
        var fields = type.Fields.Where(f => !f.IsStatic && !f.IsConstant).ToList();
        var properties = type.Properties.Where(p => !p.IsStatic).ToList();
        return fields.Count + properties.Count > 0 && !HasMutableInstanceState(type);
    }

    // ---- pure functions ---------------------------------------------------------------------------------------

    /// <summary>
    /// Ids of callables that are pure by a conservative definition (spec/paradigms.md): they write only their own locals
    /// and by-value parameters, read no mutable state outside their arguments, call only System.Math, System.String and
    /// other pure project functions, and create only strings and project types without explicit constructors. Anything the
    /// analysis cannot see through (unknown syntax, unresolved calls, delegates, await) makes a function not pure.
    /// </summary>
    /// <param name="model">The project model.</param>
    public static HashSet<string> PureFunctions(ProjectModel model) => PureCache.GetValue(model, ComputePure);

    private static HashSet<string> ComputePure(ProjectModel model)
    {
        var candidates = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var callable in model.Modules.SelectMany(m => m.AllCallables))
        {
            if (callable.Kind is not (CallableKind.Method or CallableKind.Function or CallableKind.Operator) || callable.Body is null) continue;
            if (LocalCheck(callable, model, out var callees)) candidates[callable.Id] = callees;
        }

        // Greatest fixed point: a function stays pure only while everything it calls stays pure.
        bool changed;
        do
        {
            changed = false;
            foreach (var id in candidates.Keys.ToList())
            {
                if (candidates[id].All(candidates.ContainsKey)) continue;
                candidates.Remove(id);
                changed = true;
            }
        } while (changed);
        return [.. candidates.Keys];
    }

    private static bool LocalCheck(Callable callable, ProjectModel model, out List<string> callees)
    {
        callees = [];
        if (callable.Parameters.Any(p => p.IsByReference)) return false;
        foreach (var node in callable.Body?.DescendantsAndSelf() ?? [])
        {
            switch (node)
            {
                case OpaqueStatement or OpaqueExpression or AwaitExpression:
                    return false;
                case AssignmentExpression assignment when !IsOwnVariable(assignment.Target):
                    return false;
                case UnaryExpression { IsMutation: true } unary when !IsOwnVariable(unary.Operand):
                    return false;
                case NameExpression { Symbol.Kind: SymbolKind.Field or SymbolKind.Property } name when !IsReadOnlyMember(name.Symbol, model):
                    return false;
                case MemberAccessExpression { Member.Kind: SymbolKind.Field or SymbolKind.Property } access when !MayRead(access, model):
                    return false;
                case InvocationExpression invocation:
                    if (!CallAllowed(invocation.Target, model, callees)) return false;
                    break;
                case ObjectCreationExpression creation when !CreationAllowed(creation.CreatedType, model):
                    return false;
            }
        }
        return true;
    }

    private static bool IsOwnVariable(Expression target) => target is NameExpression { Symbol.Kind: SymbolKind.Local or SymbolKind.Parameter };

    private static bool IsReadOnlyMember(SymbolRef symbol, ProjectModel model)
    {
        if (symbol.IsExternal) return symbol.IsStatic && symbol.DeclaringTypeId == "System.Math";
        var owner = model.FindType(symbol.DeclaringTypeId);
        if (owner is null) return false;
        return symbol.Kind == SymbolKind.Field
            ? owner.Fields.Any(f => f.Id == symbol.Id && (f.IsReadOnly || f.IsConstant))
            : owner.Properties.Any(p => p.Id == symbol.Id && (p.SetterVisibility is null || p.IsInitOnly));
    }

    /// <summary>Reading a member of an argument or a local is fine; anything else must be a constant or read-only member.</summary>
    private static bool MayRead(MemberAccessExpression access, ProjectModel model)
    {
        if (IsReadOnlyMember(access.Member, model)) return true;
        if (access.Member.IsStatic) return false;
        var root = access.Target;
        while (root is MemberAccessExpression inner) root = inner.Target;
        return root is NameExpression { Symbol.Kind: SymbolKind.Local or SymbolKind.Parameter };
    }

    private static bool CallAllowed(SymbolRef target, ProjectModel model, List<string> callees)
    {
        if (target.Kind != SymbolKind.Callable || target.Id is null) return false;
        if (target.IsExternal) return target.DeclaringTypeId is "System.Math" or "System.String";
        if (model.FindCallable(target.Id) is null) return false;
        callees.Add(target.Id);
        return true;
    }

    private static bool CreationAllowed(TypeRef type, ProjectModel model)
    {
        if (type.Id == "System.String") return true;
        return model.FindType(type.Id) is { } project && project.Callables.All(c => c.Kind != CallableKind.Constructor);
    }
}
