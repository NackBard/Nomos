namespace Nomos.Analyzers.Profiles;

/// <summary>Flags unconditional jumps.</summary>
[Analyzer("STR001", Categories.Paradigm, Title = "Goto", Severity = Severity.Minor, Paradigms = [Paradigms.Structural],
    Description = "Goto breaks the single-entry, single-exit structure of blocks. 'goto case' is not flagged.")]
public sealed class GotoAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var callable in context.Callables)
        {
            foreach (var jump in callable.Body.All<GotoStatement>().Where(g => !g.Label.StartsWith("case", StringComparison.Ordinal) && g.Label != "default"))
                context.Report(Confidence.High, jump.Location, $"goto {jump.Label} in {callable.Name}", "The flow no longer follows the block structure; a loop, a helper or an early return usually replaces it.", symbol: callable.Id);
        }
    }
}

/// <summary>Flags writable shared state.</summary>
[Analyzer("STR002", Categories.Paradigm, Title = "Global state", Severity = Severity.Major, Paradigms = [Paradigms.Structural],
    Description = "Non-private static mutable fields and properties, and module-level variables, act as globals.")]
public sealed class GlobalStateAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var module in context.Modules)
        {
            foreach (var global in module.Globals.Where(g => !g.IsReadOnly))
                context.Report(Confidence.High, global.Location, $"Global variable {global.Name}", "Any function can change it, so its value depends on the call history.", module.Name, global.Id);
            foreach (var type in module.AllTypes)
            {
                foreach (var field in type.Fields.Where(f => f is { IsStatic: true, IsReadOnly: false, Visibility: not Visibility.Private }))
                    context.Report(Confidence.High, field.Location, $"Global mutable field {type.Name}.{field.Name}", "A non-private static mutable field is shared by all code and threads.", module.Name, field.Id);
                foreach (var property in type.Properties.Where(p => p is { IsStatic: true, SetterVisibility: > Visibility.Private }))
                    context.Report(Confidence.High, property.Location, $"Global mutable property {type.Name}.{property.Name}", "A static settable property is shared by all code and threads.", module.Name, property.Id);
            }
        }
    }
}

/// <summary>Flags oversized modules and files.</summary>
[Analyzer("STR003", Categories.Paradigm, Title = "Module size", Severity = Severity.Minor, Paradigms = [Paradigms.Structural],
    Description = "Measures lines of code per module and lines per file.")]
public sealed class ModuleSizeAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        var maxModuleLines = context.Options.Int("maxModuleLines", 3000);
        var maxFileLines = context.Options.Int("maxFileLines", 800);
        foreach (var module in context.Modules)
        {
            context.Report(new Metric("loc", MetricScope.Module, module.Name, module.LinesOfCode, module.Name));
            var first = module.AllTypes.FirstOrDefault();
            if (module.LinesOfCode > maxModuleLines && first is not null)
                context.Report(Confidence.High, first.Location, $"Module {module.Name} has {module.LinesOfCode} lines", $"The limit is {maxModuleLines}; a smaller module is easier to understand as a unit.", module.Name);
        }

        foreach (var file in context.Model.Files.Where(f => f.Language == context.Language && f.Lines.Count > maxFileLines))
            context.Report(Confidence.High, new SourceLocation(file.Path, 1, 1, 1, 1), $"{file.Path} has {file.Lines.Count} lines", $"The limit is {maxFileLines}.");
    }
}
