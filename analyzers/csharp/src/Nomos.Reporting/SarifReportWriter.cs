using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using Nomos.Abstractions;

namespace Nomos.Reporting;

/// <summary>Writes SARIF 2.1.0 for CI systems and IDEs.</summary>
public sealed class SarifReportWriter : IReportWriter
{
    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <inheritdoc />
    public string Format => "sarif";

    /// <inheritdoc />
    public string FileExtension => ".sarif";

    /// <inheritdoc />
    public void Write(AnalysisResult result, TextWriter output)
    {
        var rules = result.Analyzers.ToList();
        var ruleIndex = rules.Select((r, i) => (r.Id, i)).ToDictionary(p => p.Id, p => p.i);
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
                            name = "Nomos",
                            semanticVersion = result.ToolVersion,
                            rules = rules.Select(r => new
                            {
                                id = r.Id,
                                name = r.Title,
                                shortDescription = new { text = r.Title },
                                fullDescription = new { text = r.Description.Length > 0 ? r.Description : r.Title },
                                defaultConfiguration = new { level = Level(r.DefaultSeverity) },
                                properties = new { category = r.Category, paradigms = r.Paradigms, languages = r.Languages },
                            }),
                        },
                    },
                    results = result.Findings.Select(f => new
                    {
                        ruleId = f.AnalyzerId,
                        ruleIndex = ruleIndex.GetValueOrDefault(f.AnalyzerId),
                        level = Level(f.Severity),
                        message = new { text = $"{f.Message}. {f.Evidence.Explanation}" },
                        locations = f.Evidence.Location.IsKnown ? new[] { Location(f) } : [],
                        partialFingerprints = new Dictionary<string, string> { ["nomos/v1"] = f.Fingerprint },
                        properties = new { confidence = f.Confidence.ToString(), module = f.Module, symbol = f.Symbol },
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

    private static string Level(Severity severity) => severity switch
    {
        Severity.Critical or Severity.Major => "error",
        Severity.Minor => "warning",
        _ => "note",
    };
}
