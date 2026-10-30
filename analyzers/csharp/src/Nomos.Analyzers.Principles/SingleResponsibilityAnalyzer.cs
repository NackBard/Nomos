namespace Nomos.Analyzers.Principles;

/// <summary>Flags classes whose collaborators span too many concerns.</summary>
[Analyzer("PRN001", Categories.Principles, Title = "Single Responsibility", Severity = Severity.Major, Paradigms = [Paradigms.ObjectOriented],
    Description = "A class that takes many constructor dependencies, or reaches into many project modules, likely has several reasons to change.")]
public sealed class SingleResponsibilityAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var maxDependencies = context.Options.Int("maxConstructorDependencies", 5);
        var maxModules = context.Options.Int("maxModules", 4);
        var minMethods = context.Options.Int("minMethods", 3);
        foreach (var type in context.Types.Where(t => t.Kind == TypeKind.Class))
        {
            var methods = type.Callables.Count(c => c.Kind == CallableKind.Method);
            if (methods < minMethods) continue;
            var injected = type.Callables.Where(c => c.Kind == CallableKind.Constructor)
                .Select(c => c.Parameters.Count(p => p.Type?.Kind is TypeRefKind.Interface or TypeRefKind.Class)).DefaultIfEmpty(0).Max();
            var modules = type.Dependencies.Where(d => !d.IsExternal).Select(d => context.Model.FindType(d.TargetTypeId)?.ModuleName)
                .OfType<string>().Where(m => m != type.ModuleName).Distinct().Count();
            if (injected > maxDependencies)
                context.Report(type, Confidence.Medium, $"{type.Name} takes {injected} dependencies in its constructor",
                    $"More than {maxDependencies} injected collaborators usually mean several responsibilities live in one class.");
            else if (modules > maxModules)
                context.Report(type, Confidence.Low, $"{type.Name} depends on {modules} other modules",
                    $"Reaching into more than {maxModules} modules suggests the class coordinates unrelated concerns.");
        }
    }
}
