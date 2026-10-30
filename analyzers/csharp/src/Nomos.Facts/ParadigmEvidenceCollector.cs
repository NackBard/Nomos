using Nomos.Abstractions;
using Nomos.Abstractions.Ir;

namespace Nomos.Facts;

/// <summary>
/// Collects paradigm evidence per module by spec/paradigms.md. fp.pure-functions and fp.immutable-types are not
/// collected: the spec leaves "pure" to the analyzer and gives no checkable definition (D-026).
/// </summary>
internal sealed class ParadigmEvidenceCollector(ProjectModel model, IReadOnlyDictionary<string, string> functionIds)
{
    private const int LambdaActivation = 3;

    public IReadOnlyList<FactsEvidence> Collect(ModuleDecl module)
    {
        var result = new List<FactsEvidence>();
        var types = module.AllTypes.ToList();
        var callables = module.AllCallables.Where(c => c.Kind != CallableKind.Accessor).ToList();

        var classes = types.Where(t => t.Kind is TypeKind.Class or TypeKind.Struct or TypeKind.Record
            && t.Fields.Count + t.Properties.Count + t.Callables.Count(c => c.Kind != CallableKind.Accessor) > 0).Select(t => t.Id).ToList();
        Add(result, Paradigms.ObjectOriented, "oop.classes", "classes with methods or fields", classes);

        Add(result, Paradigms.ObjectOriented, "oop.mutable-state-classes", "classes with mutable instance state", types
            .Where(t => t.Kind is TypeKind.Class or TypeKind.Struct or TypeKind.Record
                && (t.Fields.Any(f => !f.IsStatic && !f.IsReadOnly && !f.IsConstant) || t.Properties.Any(p => !p.IsStatic && p.SetterVisibility is not null && !p.IsInitOnly)))
            .Select(t => t.Id).ToList());

        Add(result, Paradigms.ObjectOriented, "oop.inheritance", "project types inheriting project types", types
            .Where(t => t.Kind == TypeKind.Class && model.FindType(t.BaseType?.Id) is not null).Select(t => t.Id).ToList());

        Add(result, Paradigms.ObjectOriented, "oop.abstractions", "interfaces and abstract classes", types.Where(t => t.IsAbstract).Select(t => t.Id).ToList());

        Add(result, Paradigms.Structural, "str.free-functions", "functions outside types", module.Functions.Select(Name).ToList());

        Add(result, Paradigms.Structural, "str.control-flow", "functions with branches or loops",
            callables.Where(HasControlFlow).Select(Name).ToList());

        Add(result, Paradigms.Structural, "str.global-state", "module-level variables and static mutable state",
            [.. module.Globals.Select(g => g.Id), .. types.SelectMany(t => t.Fields.Where(f => f.IsStatic && !f.IsReadOnly && !f.IsConstant).Select(f => f.Id))]);

        var lambdaOwners = callables.SelectMany(c => c.Body.All<InvocationExpression>().SelectMany(i => i.Arguments.OfType<LambdaExpression>()).Select(_ => Name(c))).ToList();
        Add(result, Paradigms.Functional, "fp.lambdas", "lambdas passed as arguments", lambdaOwners, count: lambdaOwners.Count);

        Add(result, Paradigms.Functional, "fp.higher-order", "functions taking or returning functions", callables
            .Where(c => c.Parameters.Any(p => p.Type?.Kind == TypeRefKind.Function) || c.ReturnType?.Kind == TypeRefKind.Function).Select(Name).ToList());

        return [.. result.OrderBy(e => e.Kind, StringComparer.Ordinal)];
    }

    /// <summary>The paradigms a module shows (spec/paradigms.md, "Условие активации").</summary>
    public static HashSet<string> ActiveParadigms(IReadOnlyList<FactsEvidence> evidence)
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

    /// <summary>Explains why a rule was skipped for a module.</summary>
    public static string NotApplicable(string paradigm) => paradigm switch
    {
        Paradigms.ObjectOriented => "OOP rule not applicable: module has no classes",
        Paradigms.Functional => "Functional rule not applicable: module shows no functional style",
        Paradigms.Structural => "Structural rule not applicable: module has no free functions or branching",
        _ => $"Rule for paradigm '{paradigm}' not applicable: no evidence of it in the module",
    };

    private static bool HasControlFlow(Callable callable) =>
        callable.Body.All<IfStatement>().Any() || callable.Body.All<LoopStatement>().Any() || callable.Body.All<SwitchStatement>().Any()
        || callable.Body.All<ConditionalExpression>().Any() || callable.Body.All<SwitchExpression>().Any();

    private string Name(Callable callable) => functionIds.GetValueOrDefault(callable.Id, callable.Id);

    private static void Add(List<FactsEvidence> result, string paradigm, string kind, string description, IReadOnlyList<string> ids, int? count = null)
    {
        var total = count ?? ids.Count;
        if (total == 0) return;
        result.Add(new FactsEvidence(paradigm, kind, total, description, [.. ids.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).Take(5)]));
    }
}
