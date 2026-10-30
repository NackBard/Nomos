using System.Globalization;
using Nomos.Abstractions;

namespace Nomos.Core;

/// <summary>
/// Computes explainable health scores.
/// Per category: 100 * exp(-penalty / max(KLOC, MinKloc) / DecayPerKloc), where penalty sums
/// severity penalty * confidence factor over findings. A module is the weighted mean of its categories;
/// the project is the mean of its modules, weighted by lines of code.
/// </summary>
public sealed class HealthScorer(ScoringConfig config)
{
    /// <summary>Scores modules.</summary>
    /// <param name="modules">Module names with their sizes.</param>
    /// <param name="findings">Effective findings.</param>
    /// <param name="categories">Categories that actually ran; others do not contribute.</param>
    public IReadOnlyList<ModuleHealth> ScoreModules(IEnumerable<(string Name, int LinesOfCode)> modules, IReadOnlyList<Finding> findings, IReadOnlyCollection<string> categories)
    {
        var byModule = findings.Where(f => f.Module is not null).ToLookup(f => f.Module!);
        return [.. modules.Select(m => new ModuleHealth(m.Name, m.LinesOfCode, Score(m.LinesOfCode, byModule[m.Name].ToList(), categories)))];
    }

    /// <summary>Aggregates module scores into the project score.</summary>
    /// <param name="modules">Module scores.</param>
    public HealthScore ScoreProject(IReadOnlyList<ModuleHealth> modules)
    {
        if (modules.Count == 0) return new HealthScore(100, [], ["No modules were analyzed, so nothing lowers the score."]);

        double totalLines = Math.Max(1, modules.Sum(m => m.LinesOfCode));
        var score = modules.Sum(m => m.Health.Score * m.LinesOfCode) / totalLines;
        var categories = modules.SelectMany(m => m.Health.Categories.Select(c => (m.LinesOfCode, c))).GroupBy(p => p.c.Category)
            .Select(g => new CategoryScore(
                g.Key,
                Math.Round(g.Sum(p => p.c.Score * p.LinesOfCode) / totalLines, 1),
                g.First().c.Weight,
                Math.Round(g.Sum(p => p.c.Penalty), 2),
                g.Sum(p => p.c.FindingCount)))
            .OrderBy(c => c.Category, StringComparer.Ordinal).ToList();

        var explanation = new List<string> { Format($"Mean of {modules.Count} module score(s), weighted by lines of code ({totalLines:0} total).") };
        explanation.AddRange(modules.OrderBy(m => m.Health.Score).ThenBy(m => m.Module, StringComparer.Ordinal).Take(3)
            .Select(m => Format($"Lowest: {m.Module} = {m.Health.Score:0.0} ({m.LinesOfCode} lines).")));
        return new HealthScore(Math.Round(score, 1), categories, explanation);
    }

    private HealthScore Score(int linesOfCode, IReadOnlyList<Finding> findings, IReadOnlyCollection<string> categories)
    {
        var totalWeight = categories.Sum(Weight);
        var kloc = Math.Max(linesOfCode / 1000.0, config.MinKloc);
        var breakdown = new List<CategoryScore>();
        var total = 0.0;
        foreach (var category in categories.Order(StringComparer.Ordinal))
        {
            var own = findings.Where(f => f.Category == category).ToList();
            var penalty = own.Sum(Penalty);
            var score = 100 * Math.Exp(-penalty / kloc / config.DecayPerKloc);
            var weight = totalWeight > 0 ? Weight(category) / totalWeight : 0;
            // The total uses exact weights: summing the rounded display weights can exceed 1 and push the score above 100.
            total += score * weight;
            breakdown.Add(new CategoryScore(category, Math.Round(score, 1), Math.Round(weight, 3), Math.Round(penalty, 2), own.Count));
        }

        var explanation = new List<string> { Format($"Weighted mean over {breakdown.Count} categories, normalized by {kloc:0.###} KLOC.") };
        explanation.AddRange(breakdown.Where(c => c.Penalty > 0).OrderByDescending(c => c.Penalty * c.Weight).ThenBy(c => c.Category, StringComparer.Ordinal)
            .Select(c => Format($"{c.Category}: {c.Score:0.0} (weight {c.Weight:0.###}) from {c.FindingCount} finding(s), penalty {c.Penalty:0.##}.")));
        return new HealthScore(Math.Round(total, 1), breakdown, explanation);
    }

    private double Weight(string category) => config.CategoryWeights.GetValueOrDefault(category, 1);

    private double Penalty(Finding finding) =>
        config.SeverityPenalties.GetValueOrDefault(finding.Severity, 0) * config.ConfidenceFactors.GetValueOrDefault(finding.Confidence, 1);

    private static string Format(FormattableString text) => text.ToString(CultureInfo.InvariantCulture);
}
