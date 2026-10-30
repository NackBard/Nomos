using Nomos.Abstractions;
using Nomos.Abstractions.Ir;
using Nomos.Core;
using Xunit;

namespace Nomos.Core.Tests;

[Analyzer("T001", "Test", Title = "Reports every type", Severity = Severity.Minor, Paradigms = ["p1"])]
public sealed class EveryTypeAnalyzer : AnalyzerBase
{
    public override void Analyze(AnalysisContext context)
    {
        foreach (var type in context.Types) context.Report(type, Confidence.High, $"type {type.Name}", "because");
        context.Report(new Metric("count", MetricScope.Project, "p", context.Types.Count()));
    }
}

[Analyzer("T002", "Test", Title = "Other paradigm", Paradigms = ["p2"])]
public sealed class OtherParadigmAnalyzer : AnalyzerBase
{
    public override void Analyze(AnalysisContext context) => Assert.Fail("must not run");
}

[Analyzer("T003", "Test", Title = "Other language", Languages = ["other"])]
public sealed class OtherLanguageAnalyzer : AnalyzerBase
{
    public override void Analyze(AnalysisContext context) => Assert.Fail("must not run");
}

[Analyzer("T004", "Test", Title = "Crashes")]
public sealed class CrashingAnalyzer : AnalyzerBase
{
    public override void Analyze(AnalysisContext context) => throw new InvalidOperationException("boom");
}

[Analyzer("T005", "Other", Title = "Disabled by default", EnabledByDefault = false)]
public sealed class OptInAnalyzer : AnalyzerBase
{
    public override void Analyze(AnalysisContext context) => context.Report(Confidence.Low, SourceLocation.None, "opted in", "because");
}

public sealed class ToyAdapter : ILanguageAdapter
{
    public string Language => "toy";

    public IReadOnlyList<string> FileExtensions => [".toy"];

    public IReadOnlyList<string> SupportedParadigms => ["p1", "p2"];

    public IReadOnlyList<string> DefaultParadigms => ["p1"];

    public Task<AdapterResult> LoadAsync(IReadOnlyList<SourceInput> sources, CancellationToken cancellationToken)
    {
        var modules = sources.Select(s =>
        {
            var location = new SourceLocation(s.Path, 1, 1, 1, 1);
            return new ModuleDecl(s.Path, Language)
            {
                LinesOfCode = 100,
                Types = [new TypeDecl(location) { Id = s.Text, Name = s.Text, Kind = TypeKind.Class, ModuleName = s.Path, Attributes = s.Text == "Attributed" ? [new AttributeInfo("NomosSuppress", ["T001"], location)] : [] }],
            };
        }).ToList();
        var files = sources.Select(s => new SourceFile(s.Path, Language, s.Text)
        {
            Comments = s.Text == "Commented" ? [new CommentInfo("// nomos-disable T001", new SourceLocation(s.Path, 1, 1, 1, 1), false)] : [],
        }).ToList();
        return Task.FromResult(new AdapterResult(modules, files, []));
    }
}

public class EngineTests
{
    private static readonly ComponentCatalog Catalog = ComponentCatalog.Discover([typeof(EngineTests).Assembly]);

    private static Task<AnalysisResult> Run(NomosConfig? config = null, params string[] types) =>
        new AnalysisEngine(Catalog).RunAsync(new AnalysisRequest
        {
            ProjectName = "t",
            Config = config ?? new NomosConfig(),
            Sources = new Dictionary<string, IReadOnlyList<SourceInput>> { ["toy"] = [.. (types.Length == 0 ? ["A"] : types).Select(t => new SourceInput($"{t}.toy", t))] },
        });

    [Fact]
    public void Catalog_DiscoversAnalyzersAdaptersAndTheirMetadata()
    {
        var analyzer = Catalog.Analyzers.Single(a => a.Descriptor.Id == "T001");
        Assert.Equal("Test", analyzer.Descriptor.Category);
        Assert.Equal(Severity.Minor, analyzer.Descriptor.DefaultSeverity);
        Assert.Equal(["p1"], analyzer.Descriptor.Paradigms);
        Assert.Single(Catalog.Adapters);
    }

    [Fact]
    public async Task Engine_SelectsAnalyzersByLanguageAndParadigm()
    {
        var result = await Run();
        Assert.Equal(["T001", "T004"], result.Analyzers.Select(a => a.Id));
        Assert.Equal("type A", Assert.Single(result.Findings).Message);
        Assert.Equal(1, Assert.Single(result.Metrics).Value);
    }

    [Fact]
    public async Task Config_ChoosesParadigms_AndWarnsAboutUnsupportedOnes()
    {
        var config = new NomosConfig { Languages = { ["toy"] = new LanguageConfig { Paradigms = ["p1", "nope"] } } };
        var result = await Run(config);
        Assert.Equal(["p1"], result.ActiveParadigms["toy"]);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("nope", StringComparison.Ordinal));
    }

    [Fact]
    public async Task CrashingAnalyzer_BecomesDiagnostic_AndOthersStillRun()
    {
        var result = await Run();
        Assert.Contains(result.Diagnostics, d => d is { Level: DiagnosticLevel.Error, Source: "T004" } && d.Message.Contains("boom", StringComparison.Ordinal));
        Assert.Single(result.Findings);
    }

    [Fact]
    public async Task Config_EnablesDisablesAndOverridesSeverity()
    {
        var config = new NomosConfig
        {
            Analyzers =
            {
                ["T001"] = new AnalyzerConfig { Severity = Severity.Critical },
                ["T004"] = new AnalyzerConfig { Enabled = false },
                ["T005"] = new AnalyzerConfig { Enabled = true },
            },
        };
        var result = await Run(config);
        Assert.Equal(["T001", "T005"], result.Analyzers.Select(a => a.Id));
        Assert.Equal(Severity.Critical, result.Findings.Single(f => f.AnalyzerId == "T001").Severity);
    }

    [Fact]
    public async Task Config_DisablesWholeCategory_UnlessAnalyzerOptsIn()
    {
        var config = new NomosConfig
        {
            Categories = { ["Test"] = new CategoryConfig { Enabled = false } },
            Analyzers = { ["T001"] = new AnalyzerConfig { Enabled = true } },
        };
        var result = await Run(config);
        Assert.Equal(["T001"], result.Analyzers.Select(a => a.Id));
    }

    [Fact]
    public async Task Suppressions_WorkByConfigCommentAndAttribute()
    {
        var config = new NomosConfig { Suppressions = { new SuppressionConfig { Id = "T001", Path = "Silenced*" } } };
        var result = await Run(config, "Plain", "Silenced", "Commented", "Attributed");

        Assert.Equal("type Plain", Assert.Single(result.Findings).Message);
        Assert.Equal(3, result.Suppressed.Count);
    }

    [Fact]
    public void Finding_RequiresAnExplanation()
    {
        var context = new AnalysisContext(new EveryTypeAnalyzer().Descriptor, new ProjectModel("p", [], []), [], "toy", new HashSet<string>(),
            null!, null!, _ => { }, _ => { });
        Assert.Throws<ArgumentException>(() => context.Report(Confidence.High, SourceLocation.None, "m", " "));
    }

    [Fact]
    public void Fingerprint_SurvivesLineShifts()
    {
        Finding At(int line) => new("A", "C", Severity.Minor, Confidence.Low, "m", new Evidence(new SourceLocation("f", line, 1, line, 1), "s", "e"));
        Assert.Equal(At(1).Fingerprint, At(50).Fingerprint);
    }

    [Fact]
    public void Glob_HandlesSegments()
    {
        Assert.True(Glob.IsMatch("**/bin/**", "src/bin/x.cs"));
        Assert.True(Glob.IsMatch("**/bin/**", "bin/x.cs"));
        Assert.True(Glob.IsMatch("src/*.cs", "src/a.cs"));
        Assert.False(Glob.IsMatch("src/*.cs", "src/d/a.cs"));
        Assert.True(Glob.IsMatch("**", "any/path.cs"));
    }

    [Fact]
    public void Config_LoadsJsonWithCommentsAndThresholds()
    {
        var path = Path.Combine(Directory.CreateTempSubdirectory().FullName, NomosConfig.FileName);
        File.WriteAllText(path, """
            {
              // comment
              "languages": { "csharp": { "paradigms": ["oop"] } },
              "analyzers": { "X": { "enabled": false, "severity": "Major", "thresholds": { "max": 3, "ratio": 0.5, "names": ["a"] } } },
              "scoring": { "decayPerKloc": 10 },
            }
            """);
        var config = NomosConfig.Load(path);

        Assert.Equal(["oop"], config.Languages["CSharp"].Paradigms);
        Assert.Equal(Severity.Major, config.Analyzers["x"].Severity);
        Assert.Equal(10, config.Scoring.DecayPerKloc);
        Assert.Equal(1, config.Scoring.CategoryWeights["CleanCode"]);
    }

    [Fact]
    public void Config_ReportsMalformedFiles()
    {
        var path = Path.Combine(Directory.CreateTempSubdirectory().FullName, NomosConfig.FileName);
        File.WriteAllText(path, "{ nope");
        Assert.Throws<ConfigurationException>(() => NomosConfig.Load(path));
    }

    [Fact]
    public void SourceCollector_AppliesBuiltInAndConfiguredExcludes()
    {
        var root = Directory.CreateTempSubdirectory().FullName;
        Directory.CreateDirectory(Path.Combine(root, "bin"));
        Directory.CreateDirectory(Path.Combine(root, "skip"));
        File.WriteAllText(Path.Combine(root, "a.toy"), "A");
        File.WriteAllText(Path.Combine(root, "bin", "b.toy"), "B");
        File.WriteAllText(Path.Combine(root, "skip", "c.toy"), "C");
        File.WriteAllText(Path.Combine(root, "d.txt"), "D");

        var sources = SourceCollector.Collect(root, [new ToyAdapter()], new NomosConfig { Exclude = ["skip/**"] });

        Assert.Equal("a.toy", Assert.Single(sources["toy"]).Path);
    }

    [Fact]
    public void SourceCollector_RejectsMissingPath() =>
        Assert.Throws<ConfigurationException>(() => SourceCollector.Collect("/definitely/not/here", [new ToyAdapter()], new NomosConfig()));
}
