namespace Nomos.Analyzers.Principles;

/// <summary>Flags direct instantiation of concrete services that have an abstraction.</summary>
[Analyzer("PRN005", Categories.Principles, Title = "Dependency Inversion", Severity = Severity.Minor, Paradigms = [Paradigms.ObjectOriented],
    Description = "Creating a project class that implements a project abstraction binds the caller to the concrete type.")]
public sealed class DependencyInversionAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var roots = context.Options.List("compositionRootSuffixes", ["Factory", "Builder", "Program", "Startup", "Module", "Registry", "Tests"]);
        // A test class instantiates the class under test by design, so it counts as a composition root.
        foreach (var type in context.Types.Where(t => !IrQueries.IsTestClass(t) && !roots.Any(r => t.Name.EndsWith(r, StringComparison.Ordinal))))
        {
            foreach (var callable in type.Callables.Where(c => !(c.Has(Modifiers.Static) && c.Name == "Main")))
            {
                foreach (var creation in callable.Body.All<ObjectCreationExpression>())
                {
                    if (context.Model.FindType(creation.CreatedType.Id) is not { Kind: TypeKind.Class } created) continue;
                    if (created.Id.StartsWith(type.Id + ".", StringComparison.Ordinal)) continue;
                    var abstraction = created.Interfaces.Where(i => !i.IsExternal).Select(i => i.Name).FirstOrDefault()
                        ?? (context.Model.FindType(created.BaseType?.Id) is { IsAbstract: true } @base ? @base.Name : null);
                    if (abstraction is null) continue;
                    context.Report(Confidence.Medium, creation.Location, $"{type.Name} creates {created.Name} directly",
                        $"{created.Name} is available through {abstraction}, but {callable.Name} instantiates the concrete class. Injecting the abstraction keeps {type.Name} replaceable and testable.",
                        type.ModuleName, callable.Id);
                }
            }
        }
    }
}
