using System.Globalization;
using Nomos.Abstractions;

namespace Nomos.Reporting;

/// <summary>Writes a human-readable Markdown summary.</summary>
public sealed class MarkdownReportWriter : IReportWriter
{
    /// <inheritdoc />
    public string Format => "md";

    /// <inheritdoc />
    public string FileExtension => ".md";

    /// <inheritdoc />
    public void Write(AnalysisResult result, TextWriter output)
    {
        var inv = CultureInfo.InvariantCulture;
        output.WriteLine($"# Nomos report: {result.ProjectName}");
        output.WriteLine();
        output.WriteLine(string.Create(inv, $"**Health: {result.Health.Score:0.0}** | {result.FileCount} files | {result.Findings.Count} findings | {result.Suppressed.Count} suppressed"));
        output.WriteLine();
        foreach (var line in result.Health.Explanation) output.WriteLine($"- {line}");
        output.WriteLine();
        output.WriteLine("Every finding is a heuristic result. Confidence states how likely it is to be right.");

        output.WriteLine();
        output.WriteLine("## Categories");
        output.WriteLine();
        output.WriteLine("| Category | Score | Weight | Findings |");
        output.WriteLine("|---|---:|---:|---:|");
        foreach (var c in result.Health.Categories) output.WriteLine(string.Create(inv, $"| {c.Category} | {c.Score:0.0} | {c.Weight:0.###} | {c.FindingCount} |"));

        output.WriteLine();
        output.WriteLine("## Modules");
        output.WriteLine();
        output.WriteLine("| Module | Score | Lines |");
        output.WriteLine("|---|---:|---:|");
        foreach (var m in result.Modules.OrderBy(m => m.Health.Score).ThenBy(m => m.Module, StringComparer.Ordinal))
            output.WriteLine(string.Create(inv, $"| {m.Module} | {m.Health.Score:0.0} | {m.LinesOfCode} |"));

        output.WriteLine();
        output.WriteLine("## Findings");
        foreach (var group in result.Findings.OrderByDescending(f => f.Severity).ThenByDescending(f => f.Confidence).GroupBy(f => f.Severity))
        {
            output.WriteLine();
            output.WriteLine($"### {group.Key} ({group.Count()})");
            output.WriteLine();
            // The same rule firing repeatedly on one symbol is shown once with all its lines; JSON and SARIF keep every finding.
            foreach (var same in group.GroupBy(f => (f.AnalyzerId, f.Confidence, f.Evidence.Location.FilePath, f.Symbol, f.Message, f.Evidence.Explanation)))
            {
                var f = same.First();
                var lines = string.Join(", ", same.Select(x => x.Evidence.Location.StartLine));
                output.WriteLine($"- **{f.AnalyzerId}** `{f.Evidence.Location.FilePath}:{lines}` ({f.Confidence} confidence): {f.Message}");
                output.WriteLine($"  - {f.Evidence.Explanation}");
            }
        }

        if (result.Diagnostics.Count > 0)
        {
            output.WriteLine();
            output.WriteLine("## Analysis notes");
            output.WriteLine();
            foreach (var d in result.Diagnostics) output.WriteLine($"- {d.Level} ({d.Source}): {d.Message}");
        }
    }
}
