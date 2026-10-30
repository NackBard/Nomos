using System.Text.RegularExpressions;
using Nomos.Abstractions;
using Nomos.Core;
using Xunit;

namespace Nomos.Analyzers.Tests;

/// <summary>Runs each analyzer on tests/fixtures/&lt;language&gt;/&lt;paradigm&gt;/&lt;id&gt;/{bad,good}.cs.</summary>
public class AnalyzerFixtureTests
{
    private static readonly ComponentCatalog Catalog = BuildCatalog();

    public static TheoryData<string> AnalyzerIds()
    {
        var data = new TheoryData<string>();
        foreach (var analyzer in Catalog.Analyzers.OrderBy(a => a.Descriptor.Id, StringComparer.Ordinal)) data.Add(analyzer.Descriptor.Id);
        return data;
    }

    [Fact]
    public void Catalog_FindsAllBuiltInAnalyzers()
    {
        Assert.Empty(Catalog.Diagnostics);
        Assert.True(Catalog.Analyzers.Count >= 50, $"Found {Catalog.Analyzers.Count}");
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
        var config = NomosConfig.LoadOrDefault(directory);
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

    private static ComponentCatalog BuildCatalog() => ComponentCatalog.Discover(PluginLoader.LoadBuiltIn());
}
