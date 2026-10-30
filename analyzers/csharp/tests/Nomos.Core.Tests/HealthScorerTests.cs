using Nomos.Abstractions;
using Nomos.Abstractions.Ir;
using Nomos.Core;
using Xunit;

namespace Nomos.Core.Tests;

public class HealthScorerTests
{
    private static Finding Finding(string module, string category, Severity severity, Confidence confidence) =>
        new("X", category, severity, confidence, "m", new Evidence(SourceLocation.None, "", "e")) { Module = module };

    [Fact]
    public void NoFindings_ScoreOneHundred()
    {
        var scorer = new HealthScorer(new ScoringConfig());
        var modules = scorer.ScoreModules([("m", 500)], [], ["A", "B"]);
        Assert.Equal(100, modules[0].Health.Score);
    }

    [Fact]
    public void Score_DependsOnSeverityConfidenceAndSize()
    {
        var scorer = new HealthScorer(new ScoringConfig());
        double Score(int lines, Severity severity, Confidence confidence) =>
            scorer.ScoreModules([("m", lines)], [Finding("m", "A", severity, confidence)], ["A"])[0].Health.Score;

        Assert.True(Score(1000, Severity.Critical, Confidence.High) < Score(1000, Severity.Minor, Confidence.High));
        Assert.True(Score(1000, Severity.Major, Confidence.High) < Score(1000, Severity.Major, Confidence.Low));
        Assert.True(Score(500, Severity.Major, Confidence.High) < Score(5000, Severity.Major, Confidence.High));
        Assert.Equal(100, Score(1000, Severity.Info, Confidence.High));
    }

    [Fact]
    public void Formula_MatchesTheDocumentedOne()
    {
        var scorer = new HealthScorer(new ScoringConfig());
        var health = scorer.ScoreModules([("m", 1000)], [Finding("m", "A", Severity.Major, Confidence.High)], ["A"])[0].Health;
        Assert.Equal(Math.Round(100 * Math.Exp(-3.0 / 1 / 20), 1), health.Score);
    }

    [Fact]
    public void Weights_ComeFromConfig()
    {
        var scorer = new HealthScorer(new ScoringConfig { CategoryWeights = { ["A"] = 3, ["B"] = 1 } });
        var health = scorer.ScoreModules([("m", 1000)], [], ["A", "B"])[0].Health;
        Assert.Equal(0.75, health.Categories.Single(c => c.Category == "A").Weight);
    }

    [Fact]
    public void Project_WeighsModulesByLines_AndExplainsItself()
    {
        var scorer = new HealthScorer(new ScoringConfig());
        var modules = scorer.ScoreModules([("big", 9000), ("small", 1000)], Enumerable.Repeat(Finding("small", "A", Severity.Critical, Confidence.High), 10).ToList(), ["A"]);
        var project = scorer.ScoreProject(modules);

        Assert.True(project.Score > modules[1].Health.Score);
        Assert.Equal(90 + modules[1].Health.Score / 10, project.Score, 0);
        Assert.Contains(project.Explanation, e => e.Contains("small", StringComparison.Ordinal));
        Assert.Contains(modules[1].Health.Explanation, e => e.Contains("penalty", StringComparison.Ordinal));
    }
}
