using System.Text.Json;
using Nomos.Abstractions;
using Nomos.Abstractions.Ir;
using Nomos.Languages.CSharp;
using Xunit;

namespace Nomos.Facts.Tests;

public class FactsTests
{
    private static readonly AnalyzerDescriptor OopRule = new("PRN001", "Single Responsibility", "Principles", "Counts dependencies.", Severity.Major, [], ["oop"]);
    private static readonly AnalyzerDescriptor NamingRule = new("CC005", "Naming conventions", "CleanCode", "Names.", Severity.Info, [], []);

    private static readonly FactsOptions Options = new("test-analyzer", "1.2.3", [OopRule, NamingRule], id => id == "CC005" ? "CS.NAM001" : id);

    private static async Task<AnalysisResult> Analyze(IReadOnlyList<Finding>? findings = null, params (string Path, string Text)[] sources)
    {
        var adapted = await new CSharpLanguageAdapter().LoadAsync([.. sources.Select(s => new SourceInput(s.Path, s.Text))], CancellationToken.None);
        return new AnalysisResult
        {
            ProjectName = "t",
            ToolVersion = "0",
            Languages = ["csharp"],
            ActiveParadigms = new Dictionary<string, IReadOnlyList<string>>(),
            FileCount = adapted.Files.Count,
            Findings = findings ?? [],
            Suppressed = [],
            Metrics = [],
            Analyzers = [],
            Modules = [],
            Health = new HealthScore(100, [], []),
            Diagnostics = [],
            Model = new ProjectModel("t", adapted.Modules, adapted.Files),
        };
    }

    private static async Task<JsonElement> Facts(params (string Path, string Text)[] sources)
    {
        var result = await Analyze(null, sources);
        return JsonDocument.Parse(FactsWriter.Write(result, Options)).RootElement;
    }

    private static JsonElement Entity(JsonElement facts, string list, string id) =>
        facts.GetProperty(list).EnumerateArray().Single(e => e.GetProperty("id").GetString() == id);

    private static double? Metric(JsonElement entity, string name) =>
        entity.GetProperty("metrics").TryGetProperty(name, out var value) && value.ValueKind != JsonValueKind.Null ? value.GetDouble() : null;

    [Fact]
    public async Task IsolatedModule_HasNullInstability_AndNullDistance()
    {
        var facts = await Facts(("a.cs", "namespace A; public class X { }"));
        var module = Entity(facts, "modules", "A");
        Assert.Equal(JsonValueKind.Null, module.GetProperty("metrics").GetProperty("instability").ValueKind);
        Assert.Equal(JsonValueKind.Null, module.GetProperty("metrics").GetProperty("distance").ValueKind);
        Assert.Equal(0, Metric(module, "abstractness"));
    }

    [Fact]
    public async Task MartinMetrics_CountDistinctUnits_NotEdges()
    {
        var facts = await Facts(
            ("d.cs", "namespace D; public interface IRepo { } public class E { }"),
            ("s.cs", "namespace S; public class One { public D.IRepo R; public D.E E1; public D.E E2; } public class Two { public D.IRepo R; }"));
        var domain = Entity(facts, "modules", "D");
        var services = Entity(facts, "modules", "S");
        Assert.Equal(2, Metric(domain, "ca"));
        Assert.Equal(0, Metric(domain, "ce"));
        Assert.Equal(0, Metric(domain, "instability"));
        Assert.Equal(0.5, Metric(domain, "abstractness"));
        Assert.Equal(0.5, Metric(domain, "distance"));
        Assert.Equal(2, Metric(services, "ce"));
        Assert.Equal(1, Metric(services, "instability"));
    }

    [Fact]
    public async Task Cycles_SkipSelfReferences_AndReportModuleCyclesWithoutTypeCycles()
    {
        var facts = await Facts(
            ("e.cs", "namespace E { public class E1 { public F.F1 O; public E.E1 Self; } public class E2 { } }"),
            ("f.cs", "namespace F { public class F1 { } public class F2 { public E.E2 O; } }"));
        var cycles = facts.GetProperty("cycles").EnumerateArray().ToList();
        var only = Assert.Single(cycles);
        Assert.Equal("module", only.GetProperty("level").GetString());
        Assert.Equal(["E", "F"], only.GetProperty("members").EnumerateArray().Select(m => m.GetString()));
        Assert.DoesNotContain(facts.GetProperty("dependencies").EnumerateArray(), d => d.GetProperty("from").GetString() == d.GetProperty("to").GetString());
    }

    [Fact]
    public async Task Dit_CountsAnExternalBaseAsOneStep_AndNotInterfaces()
    {
        var facts = await Facts(("a.cs", "namespace A { public interface I { } public class X : System.IO.StreamReader, I { public X() : base(\"\") { } } public class Y : X { public Y() { } } }"));
        Assert.Equal(1, Metric(Entity(facts, "types", "A.X"), "dit"));
        Assert.Equal(2, Metric(Entity(facts, "types", "A.Y"), "dit"));
    }

    [Fact]
    public async Task Cbo_IgnoresStandardLibraryTypes_AndLcom4IsNullWithoutInstanceMethods()
    {
        var facts = await Facts(("a.cs", "namespace A { public class Other { } public class X { public System.Text.StringBuilder S; public Other O; public static void M() { } } }"));
        var type = Entity(facts, "types", "A.X");
        Assert.Equal(1, Metric(type, "cbo"));
        Assert.Null(Metric(type, "lcom4"));
    }

    [Fact]
    public async Task Overloads_KeepTheSignatureInTheirId_OthersUseTypeAndName()
    {
        var facts = await Facts(("a.cs", "namespace A { public class X { public void Run() { } public void Run(int a) { } public void Once() { } } }"));
        var ids = facts.GetProperty("functions").EnumerateArray().Select(f => f.GetProperty("id").GetString()).ToList();
        Assert.Contains("A.X.Once", ids);
        Assert.Contains("A.X.Run()", ids);
        Assert.Contains("A.X.Run(System.Int32)", ids);
    }

    [Fact]
    public async Task Cyclomatic_CountsShortCircuitOperatorsButNotNullCoalescing()
    {
        var facts = await Facts(("a.cs", "namespace A { public class X { public bool Both(bool a, bool b) => a && b; public string Pick(string a, string b) => a ?? b; } }"));
        Assert.Equal(2, Metric(Entity(facts, "functions", "A.X.Both"), "cyclomatic"));
        Assert.Equal(1, Metric(Entity(facts, "functions", "A.X.Pick"), "cyclomatic"));
    }

    [Fact]
    public async Task Loc_SkipsBlankAndCommentOnlyLines_WhileLinesCountsEverything()
    {
        var facts = await Facts(("a.cs", "// header\n\nnamespace A;\n\n/* block\n   comment */\npublic class X { } // tail\n"));
        var file = facts.GetProperty("files")[0];
        Assert.Equal(7, file.GetProperty("lines").GetInt32());
        Assert.Equal(2, file.GetProperty("loc").GetInt32());
        Assert.Equal(2, Entity(facts, "modules", "A").GetProperty("loc").GetInt32());
    }

    [Fact]
    public async Task ModuleWithoutClasses_GetsParadigmNotDetected_ForOopRulesOnly()
    {
        var facts = await Facts(("a.cs", "namespace Plain { public enum Mode { A, B } }"));
        var skipped = facts.GetProperty("skippedRules").EnumerateArray().ToList();
        var record = Assert.Single(skipped);
        Assert.Equal("PRN001", record.GetProperty("ruleId").GetString());
        Assert.Equal("Plain", record.GetProperty("module").GetString());
        Assert.Equal("paradigm-not-detected", record.GetProperty("reason").GetString());
        Assert.Empty(Entity(facts, "modules", "Plain").GetProperty("paradigmEvidence").EnumerateArray());
    }

    [Fact]
    public async Task Output_IsDeterministic()
    {
        var result = await Analyze(null, ("b.cs", "namespace B { public class Q { public A.P X; } }"), ("a.cs", "namespace A { public class P { } }"));
        Assert.Equal(FactsWriter.Write(result, Options), FactsWriter.Write(result, Options));
    }

    [Fact]
    public async Task Sarif_FollowsTheProfile()
    {
        var location = new SourceLocation("a.cs", 3, 5, 3, 9);
        var findings = new[]
        {
            new Finding("PRN001", "Principles", Severity.Major, Confidence.Medium, "X has many dependencies", new Evidence(location, "class X", "Many collaborators suggest several reasons to change.")) { Module = "A", Symbol = "A.X.Run(System.Int32)", Measured = new Measurement("parameterCount", 1, 0) },
            new Finding("CC005", "CleanCode", Severity.Info, Confidence.High, "name is odd", new Evidence(new SourceLocation("a.cs", 1, 1, 1, 2), "", "Convention.")),
        };
        var result = await Analyze(findings, ("a.cs", "namespace A { public class X { public void Run() { } public void Run(int a) { } } }"));
        using var writer = new StringWriter();
        SarifProfileWriter.Write(result, Options, writer);
        var run = JsonDocument.Parse(writer.ToString()).RootElement.GetProperty("runs")[0];

        Assert.Equal("test-analyzer", run.GetProperty("tool").GetProperty("driver").GetProperty("name").GetString());
        Assert.Equal(["CS.NAM001", "PRN001"], run.GetProperty("tool").GetProperty("driver").GetProperty("rules").EnumerateArray().Select(r => r.GetProperty("id").GetString()));

        var results = run.GetProperty("results").EnumerateArray().ToList();
        Assert.Equal(["CS.NAM001", "PRN001"], results.Select(r => r.GetProperty("ruleId").GetString()));
        var major = results[1];
        Assert.Equal("warning", major.GetProperty("level").GetString());
        Assert.Equal("note", results[0].GetProperty("level").GetString());
        Assert.Equal("X has many dependencies", major.GetProperty("message").GetProperty("text").GetString());
        var properties = major.GetProperty("properties");
        Assert.Equal("medium", properties.GetProperty("confidence").GetString());
        Assert.Equal("major", properties.GetProperty("severity").GetString());
        Assert.Equal("Many collaborators suggest several reasons to change.", properties.GetProperty("explanation").GetString());
        Assert.Equal("A.X.Run(System.Int32)", properties.GetProperty("entity").GetString());
        var measured = properties.GetProperty("measured");
        Assert.Equal("parameterCount", measured.GetProperty("metric").GetString());
        Assert.Equal(1, measured.GetProperty("value").GetDouble());
        Assert.Equal(0, measured.GetProperty("threshold").GetDouble());
        Assert.False(results[0].GetProperty("properties").TryGetProperty("measured", out _));
    }
}
