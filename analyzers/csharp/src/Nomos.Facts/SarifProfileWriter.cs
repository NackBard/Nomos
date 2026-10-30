using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using Nomos.Abstractions;

namespace Nomos.Facts;

/// <summary>Writes findings as SARIF 2.1.0 by contracts/sarif-profile.md.</summary>
public static class SarifProfileWriter
{
    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>Writes the SARIF log with LF line endings.</summary>
    /// <param name="result">Result of an analysis run; findings carry implementation rule ids.</param>
    /// <param name="options">Analyzer identity and rule descriptors; <see cref="FactsOptions.RuleId"/> maps ids to spec ids.</param>
    /// <param name="output">Destination.</param>
    public static void Write(AnalysisResult result, FactsOptions options, TextWriter output)
    {
        var entities = result.Model is null ? null : new EntityIndex(result.Model);
        var rules = options.SupportedRules.Select(d => (Descriptor: d, Id: options.RuleId(d.Id))).OrderBy(r => r.Id, StringComparer.Ordinal).ToList();
        var ruleIndex = rules.Select((r, i) => (r.Id, i)).ToDictionary(p => p.Id, p => p.i, StringComparer.Ordinal);

        var findings = result.Findings
            .Select(f => f with { AnalyzerId = options.RuleId(f.AnalyzerId) })
            .OrderBy(f => f.Evidence.Location.FilePath, StringComparer.Ordinal)
            .ThenBy(f => f.Evidence.Location.StartLine)
            .ThenBy(f => f.Evidence.Location.StartColumn)
            .ThenBy(f => f.AnalyzerId, StringComparer.Ordinal)
            .ThenBy(f => f.Message, StringComparer.Ordinal)
            .ToList();

        var log = new Dictionary<string, object>
        {
            ["$schema"] = "https://json.schemastore.org/sarif-2.1.0.json",
            ["version"] = "2.1.0",
            ["runs"] = new[]
            {
                new
                {
                    tool = new
                    {
                        driver = new
                        {
                            name = options.AnalyzerName,
                            version = options.AnalyzerVersion,
                            semanticVersion = options.AnalyzerVersion,
                            rules = rules.Select(r => new
                            {
                                id = r.Id,
                                name = r.Descriptor.Title,
                                shortDescription = new { text = r.Descriptor.Title },
                                fullDescription = new { text = r.Descriptor.Description.Length > 0 ? r.Descriptor.Description : r.Descriptor.Title },
                                defaultConfiguration = new { level = Level(r.Descriptor.DefaultSeverity) },
                                properties = new { category = r.Descriptor.Category, paradigms = r.Descriptor.Paradigms.Order(StringComparer.Ordinal).ToList() },
                            }),
                        },
                    },
                    results = findings.Select(f => new
                    {
                        ruleId = f.AnalyzerId,
                        ruleIndex = ruleIndex.GetValueOrDefault(f.AnalyzerId),
                        level = Level(f.Severity),
                        message = new { text = f.Message },
                        locations = f.Evidence.Location.IsKnown ? new[] { Location(f) } : [],
                        partialFingerprints = new Dictionary<string, string> { ["nomos/v1"] = f.Fingerprint },
                        properties = new
                        {
                            severity = f.Severity.ToString().ToLowerInvariant(),
                            confidence = f.Confidence.ToString().ToLowerInvariant(),
                            explanation = f.Evidence.Explanation,
                            module = f.Module,
                            entity = entities?.Resolve(f.Symbol),
                        },
                    }),
                },
            },
        };
        output.WriteLine(JsonSerializer.Serialize(log, Options).ReplaceLineEndings("\n"));
    }

    private static object Location(Finding finding)
    {
        var location = finding.Evidence.Location;
        return new
        {
            physicalLocation = new
            {
                artifactLocation = new { uri = location.FilePath },
                region = new
                {
                    startLine = location.StartLine,
                    startColumn = location.StartColumn,
                    endLine = location.EndLine,
                    endColumn = location.EndColumn,
                    snippet = finding.Evidence.Snippet.Length > 0 ? new { text = finding.Evidence.Snippet } : null,
                },
            },
        };
    }

    /// <summary>Profile mapping: info is a note, minor and major are warnings, critical is an error.</summary>
    private static string Level(Severity severity) => severity switch
    {
        Severity.Critical => "error",
        Severity.Info => "note",
        _ => "warning",
    };
}
