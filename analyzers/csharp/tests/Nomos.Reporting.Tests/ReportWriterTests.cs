using Nomos.Abstractions;
using Nomos.Abstractions.Ir;
using Xunit;

namespace Nomos.Reporting.Tests;

public class ReportWriterTests
{
    private static readonly AnalyzerDescriptor Descriptor = new("X1", "Rule", "Cat", "Checks things", Severity.Major, [], ["oop"]);

    private static readonly AnalysisResult Sample = new()
    {
        ProjectName = "demo<script>",
        ToolVersion = "1.2.3",
        Languages = ["csharp"],
        ActiveParadigms = new Dictionary<string, IReadOnlyList<string>> { ["csharp"] = ["oop"] },
        FileCount = 1,
        Findings =
        [
            new Finding("X1", "Cat", Severity.Major, Confidence.Medium, "Bad <thing>", new Evidence(new SourceLocation("a.cs", 3, 2, 4, 1), "int x = a < b;", "Because of \"reasons\""))
            { Module = "M", Symbol = "M.T" },
        ],
        Suppressed = [],
        Metrics = [new Metric("cyclomatic", MetricScope.Callable, "M.T.Go()", 4)],
        Analyzers = [Descriptor],
        Modules = [ModuleDecl_("M")],
        Health = new HealthScore(87.5, [new CategoryScore("Cat", 87.5, 1, 3, 1)], ["Mean of 1 module."]),
        Diagnostics = [new ToolDiagnostic(DiagnosticLevel.Info, "csharp", "note")],
    };

    private static string Render(IReportWriter writer)
    {
        using var output = new StringWriter();
        writer.Write(Sample, output);
        return output.ToString();
    }

    [Fact]
    public void Markdown_GroupsRepeatedFindingsOfOneSymbol()
    {
        static Finding At(int line) => new("X1", "Cat", Severity.Major, Confidence.Medium, "Bad", new Evidence(new SourceLocation("a.cs", line, 1, line, 2), "x", "Because"))
        {
            Module = "M",
            Symbol = "M.T.Go()",
        };
        var result = Sample with { Findings = [At(3), At(5), At(8)] };

        using var markdown = new StringWriter();
        new MarkdownReportWriter().Write(result, markdown);
        Assert.Contains("`a.cs:3, 5, 8`", markdown.ToString(), StringComparison.Ordinal);
        Assert.Single(markdown.ToString().Split('\n'), l => l.StartsWith("- **X1**", StringComparison.Ordinal));
    }

    [Fact]
    public void Markdown_ShowsScoreConfidenceAndExplanation()
    {
        var text = Render(new MarkdownReportWriter());
        Assert.Contains("Health: 87.5", text, StringComparison.Ordinal);
        Assert.Contains("Medium confidence", text, StringComparison.Ordinal);
        Assert.Contains("Because of", text, StringComparison.Ordinal);
    }

    [Fact]
    public void Html_EscapesCodeAndIsSelfContained()
    {
        var text = Render(new HtmlReportWriter());
        Assert.DoesNotContain("<script>", text, StringComparison.Ordinal);
        Assert.Contains("demo&lt;script&gt;", text, StringComparison.Ordinal);
        Assert.Contains("a &lt; b", text, StringComparison.Ordinal);
        Assert.DoesNotContain("http", text, StringComparison.Ordinal);
    }

    private static ModuleHealth ModuleDecl_(string name) => new(name, 100, new HealthScore(87.5, [], []));
}
