using System.Text.RegularExpressions;

namespace Nomos.Analyzers.CleanCode;

/// <summary>Checks C# naming conventions.</summary>
[Analyzer("CS.NAM001", Categories.CleanCode, Title = "Naming conventions", Severity = Severity.Info, Languages = [Languages.CSharp], Paradigms = [Paradigms.ObjectOriented, Paradigms.Structural, Paradigms.Functional],
    Description = "Types, methods and properties use PascalCase, interfaces start with I, parameters use camelCase; also flags one-letter parameters of public methods.")]
public sealed partial class NamingAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var type in context.Types)
        {
            if (!PascalCase().IsMatch(type.Name)) Report(context, type.Location, type.Name, "type", "PascalCase", type.Id);
            if (type.Kind == TypeKind.Interface && !InterfaceName().IsMatch(type.Name)) Report(context, type.Location, type.Name, "interface", "IPascalCase", type.Id);
            foreach (var property in type.Properties.Where(p => !PascalCase().IsMatch(p.Name) && p.Visibility != Visibility.Private && p.Name != "this[]"))
                Report(context, property.Location, property.Name, "property", "PascalCase", property.Id);
            foreach (var callable in type.Callables.Where(c => c.Kind == CallableKind.Method))
            {
                if (!PascalCase().IsMatch(callable.Name)) Report(context, callable.Location, callable.Name, "method", "PascalCase", callable.Id);
                foreach (var parameter in callable.Parameters.Where(p => !CamelCase().IsMatch(p.Name)))
                    Report(context, parameter.Location, parameter.Name, "parameter", "camelCase", callable.Id);
                if (callable.Visibility == Visibility.Public)
                    foreach (var parameter in callable.Parameters.Where(p => p.Name.Length == 1 && p.Name[0] is not ('x' or 'y' or 'z' or 'i' or 'n')))
                        context.Report(Confidence.Low, parameter.Location, $"Parameter {parameter.Name} of {callable.Name} says little",
                            "One-letter names in a public signature leave the meaning to the reader.", symbol: callable.Id);
            }
        }
    }

    private static void Report(AnalysisContext context, SourceLocation location, string name, string kind, string style, string symbol) =>
        context.Report(Confidence.High, location, $"The {kind} name {name} is not {style}", $"C# convention for a {kind} is {style}.", symbol: symbol);

    [GeneratedRegex("^@?[A-Z][A-Za-z0-9]*(_[A-Za-z0-9]+)*$")]
    private static partial Regex PascalCase();

    [GeneratedRegex("^I[A-Z]")]
    private static partial Regex InterfaceName();

    [GeneratedRegex("^@?_*[a-z][A-Za-z0-9]*$")]
    private static partial Regex CamelCase();
}
