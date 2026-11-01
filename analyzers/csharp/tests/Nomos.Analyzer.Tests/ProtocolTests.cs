using System.Diagnostics;
using System.Text.Json;
using Xunit;

namespace Nomos.Analyzer.Tests;

/// <summary>Runs the analyzer as a process, the way clients do. Set NOMOS_UPDATE_GOLDEN=1 to regenerate the stored files.</summary>
public class ProtocolTests
{
    private static string Root()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (!File.Exists(Path.Combine(directory!.FullName, "Nomos.slnx"))) directory = directory.Parent;
        return directory.FullName;
    }

    private static string Sample => Path.Combine(Root(), "tests", "fixtures", "golden", "sample-project");

    private static (int Code, string Stdout) Run(string workingDirectory, params string[] args)
    {
        var start = new ProcessStartInfo("dotnet") { WorkingDirectory = workingDirectory, RedirectStandardOutput = true, RedirectStandardError = true };
        start.ArgumentList.Add(Path.Combine(AppContext.BaseDirectory, "nomos-csharp.dll"));
        foreach (var arg in args) start.ArgumentList.Add(arg);
        using var process = Process.Start(start)!;
        var stderr = process.StandardError.ReadToEndAsync();
        var stdout = process.StandardOutput.ReadToEnd();
        process.WaitForExit();
        _ = stderr.GetAwaiter().GetResult();
        return (process.ExitCode, stdout);
    }

    private static void AssertGolden(string name, string actual)
    {
        var path = Path.Combine(Root(), "tests", "fixtures", "golden", name);
        var text = actual.ReplaceLineEndings("\n");
        if (Environment.GetEnvironmentVariable("NOMOS_UPDATE_GOLDEN") == "1") File.WriteAllText(path, text);
        Assert.Equal(File.ReadAllText(path).ReplaceLineEndings("\n"), text);
    }

    [Fact]
    public void Analyze_MatchesGoldenFactsAndSarif()
    {
        var output = Directory.CreateTempSubdirectory().FullName;

        var (code, facts) = Run(output, "analyze", "--root", Sample, "--config", Path.Combine(Sample, "nomos.json"), "--sarif", "out.sarif");

        Assert.Equal(0, code);
        AssertGolden("expected.facts.json", facts);
        AssertGolden("expected.sarif", File.ReadAllText(Path.Combine(output, "out.sarif")));
    }

    [Fact]
    public void Manifest_ListsTheRulesBySpecIds()
    {
        var (code, stdout) = Run(Root(), "manifest");

        Assert.Equal(0, code);
        using var manifest = JsonDocument.Parse(stdout);
        var rules = manifest.RootElement.GetProperty("capabilities").GetProperty("supportedRules").EnumerateArray().Select(r => r.GetString()).ToList();
        Assert.Contains("CS.NAM001", rules);
        Assert.DoesNotContain("CC005", rules);
    }

    [Theory]
    [InlineData("nonsense")]
    [InlineData("analyze")]
    [InlineData("analyze", "--root")]
    [InlineData("analyze", "--root", ".", "--fail-on", "minor")]
    [InlineData("analyze", "--root", ".", "--rules", "NOPE")]
    public void BadUsage_ReturnsTwo_AndPrintsNothing(params string[] args)
    {
        var (code, stdout) = Run(Sample, args);
        Assert.Equal(2, code);
        Assert.Empty(stdout);
    }

    [Fact]
    public void UnusableInput_ReturnsThree_AndPrintsNothing()
    {
        var empty = Directory.CreateTempSubdirectory().FullName;
        var badConfig = Path.Combine(empty, "nomos.json");
        File.WriteAllText(badConfig, """{ "schemaVersion": "2.0.0", "analyzers": [] }""");
        string[][] calls =
        [
            ["analyze", "--root", "/no/such/place"],
            ["analyze", "--root", empty],
            ["analyze", "--root", Sample, "--config", "/no/such.json"],
            ["analyze", "--root", Sample, "--config", badConfig],
        ];

        foreach (var args in calls)
        {
            var (code, stdout) = Run(Root(), args);
            Assert.Equal(3, code);
            Assert.Empty(stdout);
        }
    }

    [Fact]
    public void Rules_LimitsWhatRuns_AndConfigCanSwitchARuleOff()
    {
        var output = Directory.CreateTempSubdirectory().FullName;
        var config = Path.Combine(output, "nomos.json");
        File.WriteAllText(config, """
            { "schemaVersion": "1.0.0", "analyzers": [{ "language": "csharp", "command": ["x"] }], "rules": { "CS.NAM001": { "enabled": false } } }
            """);

        Assert.Equal(0, Run(output, "analyze", "--root", Sample, "--rules", "CS.NAM001,SEC001", "--sarif", "only.sarif").Code);
        Assert.Equal(0, Run(output, "analyze", "--root", Sample, "--rules", "CS.NAM001", "--config", config, "--sarif", "off.sarif").Code);

        using var only = JsonDocument.Parse(File.ReadAllText(Path.Combine(output, "only.sarif")));
        var ids = only.RootElement.GetProperty("runs")[0].GetProperty("results").EnumerateArray().Select(r => r.GetProperty("ruleId").GetString()).Distinct().Order(StringComparer.Ordinal);
        Assert.Equal(["CS.NAM001", "SEC001"], ids);
        using var off = JsonDocument.Parse(File.ReadAllText(Path.Combine(output, "off.sarif")));
        Assert.Equal(0, off.RootElement.GetProperty("runs")[0].GetProperty("results").GetArrayLength());
    }
}
