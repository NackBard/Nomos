namespace Nomos.Analyzers.Patterns;

internal static class Roles
{
    /// <summary>Gets abstractions a type implements or extends, by id.</summary>
    public static IEnumerable<string> Abstractions(TypeDecl type, ProjectModel model) =>
        type.Interfaces.Append(type.BaseType).Where(t => t?.Id is not null && model.FindType(t.Id) is { IsAbstract: true }).Select(t => t!.Id!);

    public static bool Stores(TypeDecl type, string typeId) => type.Fields.Any(f => f.Type?.Id == typeId) || type.Properties.Any(p => p.Type?.Id == typeId);

    public static bool Injects(TypeDecl type, string typeId) =>
        type.Callables.Any(c => c.Kind == CallableKind.Constructor && c.Parameters.Any(p => p.Type?.Id == typeId));
}

/// <summary>Recognizes the Singleton pattern.</summary>
[Analyzer("PAT001", Categories.Patterns, Title = "Singleton", Severity = Severity.Info, Paradigms = [Paradigms.ObjectOriented],
    Description = "A class with only private constructors that exposes a static instance of itself.")]
public sealed class SingletonAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var type in context.Types.Where(t => t.Kind == TypeKind.Class))
        {
            var constructors = type.Callables.Where(c => c.Kind == CallableKind.Constructor).ToList();
            var holdsSelf = type.Fields.Any(f => f.IsStatic && f.Type?.Id == type.Id) || type.Properties.Any(p => p.IsStatic && p.Type?.Id == type.Id);
            if (constructors.Count > 0 && constructors.All(c => c.Visibility == Visibility.Private) && holdsSelf)
                context.Report(type, Confidence.High, $"{type.Name} is a Singleton", "Private constructors plus a static member of its own type. Singletons are global state: they hide dependencies and hinder testing.");
        }
    }
}

/// <summary>Recognizes the Factory pattern.</summary>
[Analyzer("PAT002", Categories.Patterns, Title = "Factory", Severity = Severity.Info, Paradigms = [Paradigms.ObjectOriented],
    Description = "A method that returns an abstraction and creates several of its concrete subtypes.")]
public sealed class FactoryAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var type in context.Types)
        {
            foreach (var callable in type.Callables.Where(c => c.ReturnType?.Id is not null && context.Model.FindType(c.ReturnType.Id) is { IsAbstract: true }))
            {
                var created = callable.Body.All<ObjectCreationExpression>().Where(o => context.Model.FindType(o.CreatedType.Id) is { IsAbstract: false } t && Roles.Abstractions(t, context.Model).Contains(callable.ReturnType!.Id))
                    .Select(o => o.CreatedType.Name).Distinct().ToList();
                if (created.Count >= 2)
                    context.Report(Confidence.High, callable.Location, $"{callable.Name} is a Factory of {callable.ReturnType!.Name}", $"It returns the abstraction and creates {string.Join(", ", created)}.", type.ModuleName, callable.Id);
                else if (created.Count == 1 && type.Name.Contains("Factory", StringComparison.Ordinal))
                    context.Report(Confidence.Medium, callable.Location, $"{callable.Name} is a Factory of {callable.ReturnType!.Name}", $"The type name and the creation of {created[0]} behind the abstraction suggest it.", type.ModuleName, callable.Id);
            }
        }
    }
}

/// <summary>Recognizes the Strategy pattern.</summary>
[Analyzer("PAT003", Categories.Patterns, Title = "Strategy", Severity = Severity.Info, Paradigms = [Paradigms.ObjectOriented],
    Description = "A context class that receives one of several interchangeable implementations and delegates to it.")]
public sealed class StrategyAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var abstraction in context.Types.Where(t => t.IsAbstract && t.Callables.Count > 0))
        {
            var implementers = context.Model.DirectSubtypes(abstraction.Id).Where(t => !t.IsAbstract).ToList();
            if (implementers.Count < 2) continue;
            foreach (var holder in context.Types.Where(t => t.Id != abstraction.Id && Roles.Stores(t, abstraction.Id) && Roles.Injects(t, abstraction.Id) && !implementers.Contains(t)))
            {
                var delegates = holder.Callables.Any(c => c.Body.All<InvocationExpression>().Any(i => i.Target.DeclaringTypeId == abstraction.Id));
                if (delegates)
                    context.Report(holder, Confidence.Medium, $"{holder.Name} uses {abstraction.Name} as a Strategy", $"It holds an injected {abstraction.Name}, with {implementers.Count} implementations: {string.Join(", ", implementers.Select(i => i.Name))}.");
            }
        }
    }
}

/// <summary>Recognizes the Observer pattern.</summary>
[Analyzer("PAT004", Categories.Patterns, Title = "Observer", Severity = Severity.Info, Paradigms = [Paradigms.ObjectOriented],
    Description = "A type with events it raises, or a list of observers it notifies in a loop, with subscribe methods.")]
public sealed class ObserverAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var type in context.Types.Where(t => t.Kind == TypeKind.Class))
        {
            if (type.Events.Count > 0)
            {
                context.Report(type, Confidence.Medium, $"{type.Name} is an Observer subject", $"It publishes events: {string.Join(", ", type.Events.Select(e => e.Name))}.");
                continue;
            }
            var subscribes = type.Callables.Any(c => c.Name is "Subscribe" or "Attach" or "Register" or "AddObserver" or "AddListener");
            var notifies = type.Callables.Any(c => c.Body.All<LoopStatement>().Any(l => l.Kind == LoopKind.ForEach && l.Body.All<InvocationExpression>().Any()) && c.Name.StartsWith("Notify", StringComparison.Ordinal));
            if (subscribes && notifies)
                context.Report(type, Confidence.High, $"{type.Name} is an Observer subject", "It has a subscribe method and notifies registered observers in a loop.");
        }
    }
}

/// <summary>Recognizes the Decorator pattern.</summary>
[Analyzer("PAT005", Categories.Patterns, Title = "Decorator", Severity = Severity.Info, Paradigms = [Paradigms.ObjectOriented],
    Description = "A class that implements an abstraction, wraps an instance of the same abstraction and forwards to it.")]
public sealed class DecoratorAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var type in context.Types.Where(t => t.Kind == TypeKind.Class))
        {
            foreach (var abstraction in Roles.Abstractions(type, context.Model))
            {
                var forwards = type.Callables.Any(c => c.Implements.Count > 0 && c.Body.All<InvocationExpression>().Any(i => i.Target.Name == c.Name && i.Receiver is NameExpression { Symbol.Kind: SymbolKind.Field or SymbolKind.Property }));
                if (Roles.Stores(type, abstraction) && Roles.Injects(type, abstraction) && forwards)
                    context.Report(type, Confidence.High, $"{type.Name} is a Decorator of {context.Model.FindType(abstraction)?.Name}", "It implements the abstraction, wraps an instance of it, and forwards calls.");
            }
        }
    }
}

/// <summary>Recognizes the Repository pattern.</summary>
[Analyzer("PAT006", Categories.Patterns, Title = "Repository", Severity = Severity.Info, Paradigms = [Paradigms.ObjectOriented],
    Description = "A type named *Repository, or a collection-like API of get, add and remove methods over one entity.")]
public sealed class RepositoryAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var type in context.Types.Where(t => t.Kind is TypeKind.Class or TypeKind.Interface))
        {
            var names = type.Callables.Select(c => c.Name).ToList();
            var reads = names.Any(n => n.StartsWith("Get", StringComparison.Ordinal) || n.StartsWith("Find", StringComparison.Ordinal));
            var writes = names.Any(n => n.StartsWith("Add", StringComparison.Ordinal) || n.StartsWith("Save", StringComparison.Ordinal) || n.StartsWith("Insert", StringComparison.Ordinal));
            var removes = names.Any(n => n.StartsWith("Remove", StringComparison.Ordinal) || n.StartsWith("Delete", StringComparison.Ordinal));
            var named = type.Name.EndsWith("Repository", StringComparison.Ordinal);
            if (named && reads && (writes || removes))
                context.Report(type, Confidence.High, $"{type.Name} is a Repository", "The name and the collection-like read/write API agree.");
            else if (named)
                context.Report(type, Confidence.Low, $"{type.Name} may be a Repository", "Only the name suggests it; the API is not collection-like.");
        }
    }
}

/// <summary>Recognizes the Builder pattern.</summary>
[Analyzer("PAT007", Categories.Patterns, Title = "Builder", Severity = Severity.Info, Paradigms = [Paradigms.ObjectOriented],
    Description = "Fluent methods that return the type itself, plus a terminal Build-like method.")]
public sealed class BuilderAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var type in context.Types.Where(t => t.Kind == TypeKind.Class))
        {
            var fluent = type.Callables.Count(c => c.ReturnType?.Id == type.Id && c.Body.All<ReturnStatement>().All(r => r.Value is NameExpression { Symbol.Kind: SymbolKind.This }) && c.Body.All<ReturnStatement>().Any());
            var terminal = type.Callables.Any(c => c.Name is "Build" or "Create" or "ToResult" && c.ReturnType?.Id != type.Id);
            if (fluent >= 2 && terminal)
                context.Report(type, Confidence.High, $"{type.Name} is a Builder", $"{fluent} fluent methods return this, and a terminal method builds the result.");
        }
    }
}

/// <summary>Flags the Service Locator antipattern.</summary>
[Analyzer("PAT101", Categories.Patterns, Title = "Service Locator", Severity = Severity.Minor, Paradigms = [Paradigms.ObjectOriented],
    Description = "Resolving dependencies from a container inside business code hides them from the constructor.")]
public sealed class ServiceLocatorAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var roots = context.Options.List("compositionRootSuffixes", ["Program", "Startup", "Factory", "Module", "Registry", "Extensions"]);
        foreach (var type in context.Types.Where(t => !roots.Any(r => t.Name.EndsWith(r, StringComparison.Ordinal))))
        {
            foreach (var callable in type.Callables)
            {
                foreach (var call in callable.Body.All<InvocationExpression>().Where(i => i.Target.Name is "GetService" or "GetRequiredService" or "Resolve" or "GetInstance"))
                {
                    var receiver = call.Receiver?.Type?.SimpleName ?? (call.Receiver as NameExpression)?.Symbol.Name ?? string.Empty;
                    if (receiver.Contains("ServiceProvider", StringComparison.Ordinal) || receiver.Contains("Locator", StringComparison.Ordinal) || receiver.Contains("Container", StringComparison.Ordinal))
                        context.Report(Confidence.Medium, call.Location, $"{type.Name} pulls a dependency from {receiver}", "The class's real dependencies are invisible in its constructor and fail only at run time.", type.ModuleName, callable.Id);
                }
            }
        }
    }
}

/// <summary>Flags the Anemic Domain Model antipattern.</summary>
[Analyzer("PAT102", Categories.Patterns, Title = "Anemic Domain Model", Severity = Severity.Minor, Paradigms = [Paradigms.ObjectOriented],
    Description = "A domain-named class with settable data and no behavior, while logic lives in services.")]
public sealed class AnemicDomainModelAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var minProperties = context.Options.Int("minProperties", 3);
        var namespaces = context.Options.List("domainNamespaces", ["Domain", "Model", "Entities"]);
        foreach (var type in context.Types.Where(t => t.Kind == TypeKind.Class))
        {
            var settable = type.Properties.Count(p => p.SetterVisibility == Visibility.Public);
            var inDomain = namespaces.Any(n => type.ModuleName.Contains(n, StringComparison.OrdinalIgnoreCase));
            if (inDomain && settable >= minProperties && !type.Callables.Any(c => c.Kind == CallableKind.Method))
                context.Report(type, Confidence.Medium, $"{type.Name} is an anemic domain object", $"{settable} public setters and no methods: its invariants must be enforced by whoever changes it. Plain DTOs are fine; this one sits in a domain namespace.");
        }
    }
}

/// <summary>Flags the Middle Man smell.</summary>
[Analyzer("PAT103", Categories.Patterns, Title = "Middle Man", Severity = Severity.Minor, Paradigms = [Paradigms.ObjectOriented],
    Description = "A class that does almost nothing but forward to one collaborator, without implementing a shared abstraction.")]
public sealed class MiddleManAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var minMethods = context.Options.Int("minMethods", 3);
        foreach (var type in context.Types.Where(t => t.Kind == TypeKind.Class && !t.Interfaces.Any() && t.BaseType is null))
        {
            var methods = type.Callables.Where(c => c is { Kind: CallableKind.Method, Visibility: Visibility.Public }).ToList();
            if (methods.Count < minMethods) continue;
            var targets = methods.Select(ForwardTarget).ToList();
            if (targets.All(t => t is not null) && targets.Distinct().Count() == 1)
                context.Report(type, Confidence.Medium, $"{type.Name} only forwards to {targets[0]}", $"All {methods.Count} public methods are single calls to the same member; callers could use it directly.");
        }
    }

    private static string? ForwardTarget(Callable callable)
    {
        var call = callable.Body?.Statements switch
        {
            [ReturnStatement { Value: InvocationExpression c }] => c,
            [ExpressionStatement { Expression: InvocationExpression c }] => c,
            _ => null,
        };
        return (call?.Receiver as NameExpression)?.Symbol is { Kind: SymbolKind.Field or SymbolKind.Property } symbol ? symbol.Name : null;
    }
}
