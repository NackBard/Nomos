using System.Text.Json;
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
    public void Json_CarriesTheWholeResult()
    {
        using var document = JsonDocument.Parse(Render(new JsonReportWriter()));
        var root = document.RootElement;
        Assert.Equal(87.5, root.GetProperty("health").GetProperty("score").GetDouble());
        var finding = root.GetProperty("findings")[0];
        Assert.Equal("major", finding.GetProperty("severity").GetString());
        Assert.Equal("medium", finding.GetProperty("confidence").GetString());
        Assert.Equal("Because of \"reasons\"", finding.GetProperty("explanation").GetString());
        Assert.Equal(16, finding.GetProperty("fingerprint").GetString()!.Length);
    }

    [Fact]
    public void Sarif_FollowsTheSchemaShape()
    {
        using var document = JsonDocument.Parse(Render(new SarifReportWriter()));
        var root = document.RootElement;
        Assert.Equal("2.1.0", root.GetProperty("version").GetString());
        var run = root.GetProperty("runs")[0];
        Assert.Equal("X1", run.GetProperty("tool").GetProperty("driver").GetProperty("rules")[0].GetProperty("id").GetString());
        var result = run.GetProperty("results")[0];
        Assert.Equal("error", result.GetProperty("level").GetString());
        Assert.Equal(0, result.GetProperty("ruleIndex").GetInt32());
        var physical = result.GetProperty("locations")[0].GetProperty("physicalLocation");
        Assert.Equal("a.cs", physical.GetProperty("artifactLocation").GetProperty("uri").GetString());
        Assert.Equal(3, physical.GetProperty("region").GetProperty("startLine").GetInt32());
        Assert.True(result.GetProperty("partialFingerprints").TryGetProperty("nomos/v1", out _));
        Assert.Equal("Medium", result.GetProperty("properties").GetProperty("confidence").GetString());
    }

    [Fact]
    public void Markdown_GroupsRepeatedFindingsOfOneSymbolButKeepsThemInJson()
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

        using var json = new StringWriter();
        new JsonReportWriter().Write(result, json);
        using var document = JsonDocument.Parse(json.ToString());
        Assert.Equal(3, document.RootElement.GetProperty("findings").GetArrayLength());
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
