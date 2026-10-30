using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using Nomos.Abstractions;

namespace Nomos.Reporting;

/// <summary>Writes the full result as JSON, the machine contract for IDEs and other clients.</summary>
public sealed class JsonReportWriter : IReportWriter
{
    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    /// <inheritdoc />
    public string Format => "json";

    /// <inheritdoc />
    public string FileExtension => ".json";

    /// <inheritdoc />
    public void Write(AnalysisResult result, TextWriter output) => output.WriteLine(JsonSerializer.Serialize(new
    {
        schemaVersion = 1,
        result.ProjectName,
        result.ToolVersion,
        result.Languages,
        result.ActiveParadigms,
        result.FileCount,
        result.Health,
        result.Modules,
        findings = result.Findings.Select(Project),
        suppressed = result.Suppressed.Select(Project),
        result.Metrics,
        analyzers = result.Analyzers.Select(a => new { a.Id, a.Title, a.Category, a.DefaultSeverity, a.Languages, a.Paradigms }),
        result.Diagnostics,
    }, Options).ReplaceLineEndings("\n"));

    private static object Project(Finding f) => new
    {
        id = f.AnalyzerId,
        f.Category,
        f.Severity,
        f.Confidence,
        f.Message,
        f.Module,
        f.Symbol,
        f.Fingerprint,
        location = f.Evidence.Location,
        f.Evidence.Snippet,
        f.Evidence.Explanation,
    };
}
