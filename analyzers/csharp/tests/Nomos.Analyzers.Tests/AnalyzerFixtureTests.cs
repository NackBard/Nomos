using System.Text.RegularExpressions;
using Nomos.Abstractions;
using Nomos.Analyzer.CSharp;
using Nomos.Core;
using Xunit;

namespace Nomos.Analyzers.Tests;

/// <summary>Runs each analyzer on tests/fixtures/&lt;language&gt;/&lt;paradigm&gt;/&lt;id&gt;/{bad,good}.cs.</summary>
public class AnalyzerFixtureTests
{
    private static readonly ComponentCatalog Catalog = BuiltInComponents.Catalog();

    public static TheoryData<string> AnalyzerIds()
    {
        var data = new TheoryData<string>();
        foreach (var analyzer in Catalog.Analyzers.OrderBy(a => a.Descriptor.Id, StringComparer.Ordinal)) data.Add(analyzer.Descriptor.Id);
        return data;
    }

    [Fact]
    public void Catalog_HasEveryClassMarkedAsAnalyzer()
    {
        var marked = Catalog.Analyzers.Select(a => a.GetType().Assembly).Distinct()
            .SelectMany(a => a.GetTypes()).Where(t => t.IsDefined(typeof(AnalyzerAttribute), false));
        Assert.Equal(marked.OrderBy(t => t.FullName, StringComparer.Ordinal), Catalog.Analyzers.Select(a => a.GetType()).OrderBy(t => t.FullName, StringComparer.Ordinal));
    }

    [Fact]
    public void AnalyzerIds_ExistInSpecRules()
    {
        var spec = Directory.GetFiles(Path.Combine(Root(), "..", "..", "spec", "rules"), "*.yaml")
            .SelectMany(File.ReadAllLines).Select(l => Regex.Match(l, @"^\s*- \{?\s*id:\s*([^\s,]+)")).Where(m => m.Success).Select(m => m.Groups[1].Value).ToHashSet();
        Assert.All(Catalog.Analyzers, a => Assert.Contains(a.Descriptor.Id, spec));
    }

    [Theory]
    [InlineData("// nomos-disable CS.NAM001 -- generated names")]
    [InlineData("// nomos-disable-next-line cs.nam001")]
    public async Task Directive_AcceptsLanguagePrefixedRuleIds(string directive)
    {
        var source = $"namespace N;\n{directive}\npublic class bad_name {{ public int Size; }}\n";
        var result = await Run("CS.NAM001", Path.GetTempPath(), "a.cs", source);
        Assert.DoesNotContain(result.Findings, f => f.AnalyzerId == "CS.NAM001");
        Assert.Contains(result.Suppressed, f => f.AnalyzerId == "CS.NAM001");
    }

    [Theory]
    [InlineData("FUN005")]
    [InlineData("OOP003")]
    [InlineData("STR003")]
    public async Task ThresholdRule_ReportsWhatItMeasured(string id)
    {
        var (directory, text) = Fixture(id, "bad.cs");
        var result = await Run(id, directory, "bad.cs", text);

        var findings = result.Findings.Where(f => f.AnalyzerId == id).ToList();
        Assert.NotEmpty(findings);
        Assert.All(findings, f => Assert.True(f.Measured is { } m && (m.Metric == "typeTests" ? m.Value >= m.Threshold : m.Value > m.Threshold)));
    }

    [Theory]
    [MemberData(nameof(AnalyzerIds))]
    public async Task BadFixture_Fires_OnEveryExpectedLine(string id)
    {
        var (directory, text) = Fixture(id, "bad.cs");
        var result = await Run(id, directory, "bad.cs", text);

        Assert.DoesNotContain(result.Diagnostics, d => d.Level == DiagnosticLevel.Error);
        var findings = result.Findings.Where(f => f.AnalyzerId == id).ToList();
        Assert.NotEmpty(findings);
        Assert.All(findings, f =>
        {
            Assert.False(string.IsNullOrWhiteSpace(f.Evidence.Explanation));
            Assert.True(f.Evidence.Location.IsKnown);
        });

        var expected = text.ReplaceLineEndings("\n").Split('\n').Select((line, i) => (line, number: i + 1))
            .Where(l => Regex.IsMatch(l.line, @"// expect(-previous)?\s*$"))
            .Select(l => l.line.Contains("expect-previous", StringComparison.Ordinal) ? l.number - 1 : l.number).ToList();
        var lines = findings.Select(f => f.Evidence.Location.StartLine).ToHashSet();
        Assert.NotEmpty(expected);
        Assert.All(expected, line => Assert.Contains(line, lines));
    }

    [Theory]
    [MemberData(nameof(AnalyzerIds))]
    public async Task GoodFixture_StaysSilent(string id)
    {
        var (directory, text) = Fixture(id, "good.cs");
        var result = await Run(id, directory, "good.cs", text);

        Assert.DoesNotContain(result.Diagnostics, d => d.Level == DiagnosticLevel.Error);
        Assert.Empty(result.Findings.Where(f => f.AnalyzerId == id).Select(f => $"{f.Evidence.Location.StartLine}: {f.Message}"));
    }

    private static async Task<AnalysisResult> Run(string id, string directory, string name, string text)
    {
        var file = Path.Combine(directory, "nomos.json");
        var config = File.Exists(file) ? NomosConfig.Load(file) : new NomosConfig();
        config.Languages[Abstractions.Languages.CSharp] = new LanguageConfig { Paradigms = [Paradigms.ObjectOriented, Paradigms.Functional, Paradigms.Structural] };
        return await new AnalysisEngine(Catalog.Filter(d => d.Id == id)).RunAsync(new AnalysisRequest
        {
            Path = directory,
            Config = config,
            ProjectName = id,
            Sources = new Dictionary<string, IReadOnlyList<SourceInput>> { [Abstractions.Languages.CSharp] = [new SourceInput(name, text)] },
        });
    }

    private static (string Directory, string Text) Fixture(string id, string file)
    {
        var descriptor = Catalog.Analyzers.Single(a => a.Descriptor.Id == id).Descriptor;
        var paradigm = descriptor.Paradigms.Count > 0 ? descriptor.Paradigms[0] : "universal";
        var language = descriptor.Languages.Count > 0 ? descriptor.Languages[0] : Abstractions.Languages.CSharp;
        var directory = Path.Combine(Root(), "tests", "fixtures", language, paradigm, id);
        return (directory, File.ReadAllText(Path.Combine(directory, file)));
    }

    private static string Root()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (!File.Exists(Path.Combine(directory!.FullName, "Nomos.slnx"))) directory = directory.Parent;
        return directory.FullName;
    }
}
