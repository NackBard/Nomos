using Nomos.Cli;
using Xunit;

namespace Nomos.Cli.Tests;

/// <summary>Compares reports on the sample project with stored files. Set NOMOS_UPDATE_GOLDEN=1 to regenerate them.</summary>
[Collection("console")]
public class GoldenTests
{
    private static string Root()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (!File.Exists(Path.Combine(directory!.FullName, "Nomos.slnx"))) directory = directory.Parent;
        return directory.FullName;
    }

    [Theory]
    [InlineData("json", ".json")]
    [InlineData("sarif", ".sarif")]
    [InlineData("md", ".md")]
    public async Task Report_MatchesGoldenFile(string format, string extension)
    {
        var golden = Path.Combine(Root(), "tests", "fixtures", "golden");
        var output = Directory.CreateTempSubdirectory().FullName;

        var exit = await Program.Main(["analyze", Path.Combine(golden, "sample-project"), "--format", format, "--output", output, "--quiet"]);

        Assert.Equal(0, exit);
        var actual = File.ReadAllText(Path.Combine(output, "nomos" + extension)).ReplaceLineEndings("\n");
        var expectedPath = Path.Combine(golden, "expected" + extension);
        if (Environment.GetEnvironmentVariable("NOMOS_UPDATE_GOLDEN") == "1") File.WriteAllText(expectedPath, actual);
        Assert.Equal(File.ReadAllText(expectedPath).ReplaceLineEndings("\n"), actual);
    }

    [Fact]
    public async Task Findings_DoNotAffectTheExitCode()
    {
        var sample = Path.Combine(Root(), "tests", "fixtures", "golden", "sample-project");
        var output = Directory.CreateTempSubdirectory().FullName;

        Assert.Equal(0, await Program.Main(["analyze", sample, "--output", output, "--quiet"]));
        Assert.Equal(2, await Program.Main(["analyze", sample, "--output", output, "--quiet", "--fail-on", "Minor"]));
    }

    [Fact]
    public async Task BadUsage_ReturnsTwo()
    {
        Assert.Equal(2, await Program.Main(["nonsense"]));
        Assert.Equal(2, await Program.Main(["analyze", "/no/such/place", "--quiet"]));
        Assert.Equal(2, await Program.Main(["analyze", Root(), "--format"]));
    }

    [Fact]
    public async Task ListAnalyzers_AndInit_Work()
    {
        Assert.Equal(0, await Program.Main(["list-analyzers"]));
        var folder = Directory.CreateTempSubdirectory().FullName;
        Assert.Equal(0, await Program.Main(["init", folder]));
        Assert.True(File.Exists(Path.Combine(folder, "nomos.json")));
        Assert.Equal(2, await Program.Main(["init", folder]));
    }
}
