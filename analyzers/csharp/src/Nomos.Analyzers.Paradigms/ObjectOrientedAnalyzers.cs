namespace Nomos.Analyzers.Profiles;

/// <summary>Flags state exposed for uncontrolled modification.</summary>
[Analyzer("OOP001", Categories.Paradigm, Title = "Encapsulation", Severity = Severity.Major, Paradigms = [Paradigms.ObjectOriented],
    Description = "Public mutable fields hand a type's invariants to every caller.")]
public sealed class EncapsulationAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var type in context.Types.Where(t => t.Kind is TypeKind.Class or TypeKind.Record))
        {
            foreach (var field in type.Fields.Where(f => f is { Visibility: Visibility.Public, IsReadOnly: false, IsConstant: false }))
                context.Report(Confidence.High, field.Location, $"Public mutable field {type.Name}.{field.Name}",
                    $"Any caller can change this field, so the type cannot protect its invariants. A property or a method can.", type.ModuleName, field.Id);
        }
    }
}

/// <summary>Measures depth of inheritance.</summary>
[Analyzer("OOP002", Categories.Paradigm, Title = "Inheritance depth", Severity = Severity.Minor, Paradigms = [Paradigms.ObjectOriented],
    Description = "Reports the depth of inheritance tree (DIT) and flags hierarchies deeper than maxDepth.")]
public sealed class InheritanceDepthAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var maxDepth = context.Options.Int("maxDepth", 4);
        foreach (var type in context.Types.Where(t => t.Kind is TypeKind.Class or TypeKind.Record))
        {
            var depth = TypeMetrics.Dit(type, context.Model);
            context.Report(new Metric("dit", MetricScope.Type, type.Id, depth, type.ModuleName));
            if (depth > maxDepth)
                context.Report(type, Confidence.High, $"{type.Name} sits {depth} levels deep",
                    $"The depth counts base classes in the project; a base outside it is one step. Beyond {maxDepth} levels, behavior is spread over many classes. Composition often reads better.",
                    measured: new Measurement("dit", depth, maxDepth));
        }
    }
}

/// <summary>Flags manual type dispatch.</summary>
[Analyzer("OOP003", Categories.Paradigm, Title = "Polymorphism", Severity = Severity.Minor, Paradigms = [Paradigms.ObjectOriented],
    Description = "Several runtime type tests on project types in one callable usually reimplement virtual dispatch.")]
public sealed class PolymorphismAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var minTests = context.Options.Int("minTypeTests", 3);
        foreach (var callable in context.Callables)
        {
            var tested = CallableMetrics.TestedTypes(callable);
            if (tested.Count >= minTests)
                context.Report(Confidence.Medium, callable.Location, $"{callable.Name} branches on {tested.Count} runtime types",
                    $"It tests for {string.Join(", ", tested)}. A virtual member on their common base would dispatch without the checks.", symbol: callable.Id,
                    measured: new Measurement("typeTests", tested.Count, minTests));
        }
    }
}

/// <summary>Measures cohesion.</summary>
[Analyzer("OOP004", Categories.Paradigm, Title = "Cohesion", Severity = Severity.Minor, Paradigms = [Paradigms.ObjectOriented],
    Description = "LCOM4 counts groups of methods that share no state; more than one group suggests a class that could be split.")]
public sealed class CohesionAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var maxLcom = context.Options.Int("maxLcom", 2);
        var minMethods = context.Options.Int("minMethods", 4);
        foreach (var type in context.Types.Where(t => t.Kind == TypeKind.Class && !t.Has(Modifiers.Static)))
        {
            if (TypeMetrics.Lcom4OrNull(type) is not { } lcom) continue;
            context.Report(new Metric("lcom4", MetricScope.Type, type.Id, lcom, type.ModuleName));
            if (lcom > maxLcom && type.Callables.Count(c => c.Kind == CallableKind.Method) >= minMethods)
                context.Report(type, Confidence.Medium, $"{type.Name} splits into {lcom} unrelated method groups",
                    $"LCOM4 finds method groups that share no field and do not call each other; each may be a separate class.",
                    measured: new Measurement("lcom4", lcom, maxLcom));
        }
    }
}

/// <summary>Measures coupling.</summary>
[Analyzer("OOP005", Categories.Paradigm, Title = "Coupling", Severity = Severity.Minor, Paradigms = [Paradigms.ObjectOriented],
    Description = "Coupling Between Objects counts distinct types a class depends on, ignoring the System namespace.")]
public sealed class CouplingAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var maxCoupling = context.Options.Int("maxCoupling", 15);
        foreach (var type in context.Types.Where(t => t.Kind is not (TypeKind.Enum or TypeKind.Delegate)))
        {
            var coupling = TypeMetrics.Cbo(type, context.Model);
            context.Report(new Metric("cbo", MetricScope.Type, type.Id, coupling, type.ModuleName));
            if (coupling > maxCoupling)
                context.Report(type, Confidence.Medium, $"{type.Name} depends on {coupling} types",
                    $"Beyond {maxCoupling} collaborators, changes elsewhere are likely to reach this class.",
                    measured: new Measurement("cbo", coupling, maxCoupling));
        }
    }
}

/// <summary>Flags inheritance used without using what is inherited.</summary>
[Analyzer("OOP006", Categories.Paradigm, Title = "Refused bequest", Severity = Severity.Minor, Paradigms = [Paradigms.ObjectOriented],
    Description = "A subclass that overrides nothing and touches no inherited member gains nothing from its base class.")]
public sealed class RefusedBequestAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var type in context.Types.Where(t => t.Kind is TypeKind.Class or TypeKind.Record))
        {
            if (context.Model.FindType(type.BaseType?.Id) is not { } baseType) continue;
            var offered = baseType.Callables.Count(c => c.Visibility >= Visibility.Protected && c.Kind == CallableKind.Method) + baseType.Fields.Count(f => f.Visibility >= Visibility.Protected);
            if (offered < 2 || type.Callables.Any(c => c.Has(Modifiers.Override))) continue;
            var usesBase = type.Callables.Any(c => c.Body.All<Expression>().Any(e => e switch
            {
                NameExpression { Symbol.Kind: SymbolKind.Base } => true,
                NameExpression name => name.Symbol.DeclaringTypeId == baseType.Id,
                MemberAccessExpression access => access.Member.DeclaringTypeId == baseType.Id,
                InvocationExpression call => call.Target.DeclaringTypeId == baseType.Id,
                _ => false,
            }));
            if (!usesBase)
                context.Report(type, Confidence.Low, $"{type.Name} inherits {baseType.Name} but uses none of it",
                    $"{baseType.Name} offers {offered} members; none are overridden or used here. Outside callers may still rely on the inherited API, which this check cannot rule out.");
        }
    }
}
