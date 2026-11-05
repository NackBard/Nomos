using System.Text.RegularExpressions;

namespace Nomos.Analyzers.CleanCode;

/// <summary>Flags placeholder comments and stub bodies.</summary>
[Analyzer("CC006", Categories.CleanCode, Title = "Placeholders", Severity = Severity.Minor, Paradigms = [Paradigms.ObjectOriented, Paradigms.Structural, Paradigms.Functional],
    Description = "Finds TODO, FIXME, HACK and XXX comments and bodies that only throw NotImplementedException.")]
public sealed partial class PlaceholderAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var file in context.Model.Files.Where(f => f.Language == context.Language))
        {
            foreach (var comment in file.Comments)
            {
                var match = Marker().Match(comment.Text);
                if (match.Success)
                    context.Report(Confidence.High, comment.Location, $"{match.Value} comment left in code", $"A placeholder records unfinished work that belongs in the issue tracker or in a fix.");
            }
        }

        foreach (var callable in context.Callables.Where(c => IrQueries.IsStub(c) && c.Body.All<ObjectCreationExpression>().Any(o => o.CreatedType.SimpleName == "NotImplementedException")))
            context.Report(Confidence.High, callable.Location, $"{callable.Name} is not implemented", $"The body only throws NotImplementedException.", symbol: callable.Id);
    }

    [GeneratedRegex(@"\b(TODO|FIXME|HACK|XXX)\b")]
    private static partial Regex Marker();
}

/// <summary>Flags comment blocks that look like disabled code.</summary>
[Analyzer("CC008", Categories.CleanCode, Title = "Commented-out code", Severity = Severity.Minor, Paradigms = [Paradigms.ObjectOriented, Paradigms.Structural, Paradigms.Functional],
    Description = "Line comments that end like statements are probably disabled code; version control keeps the history instead.")]
public sealed partial class CommentedOutCodeAnalyzer : AnalyzerBase
{
    /// <inheritdoc />
    public override void Analyze(AnalysisContext context)
    {
        foreach (var file in context.Model.Files.Where(f => f.Language == context.Language))
        {
            foreach (var comment in file.Comments.Where(c => !c.IsDocumentation && CodeLike().IsMatch(c.Text)))
                context.Report(Confidence.Low, comment.Location, $"Comment looks like disabled code", $"The comment has the shape of a statement; a textual heuristic cannot tell it from prose with certainty.");
        }
    }

    [GeneratedRegex(@"^(//|#)\s*[\w.\[\]<>()]+.*(;|\{|\}|\)\s*\{?)\s*$|^/\*.*;\s*\*/$")]
    private static partial Regex CodeLike();
}
