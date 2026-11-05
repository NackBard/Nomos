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
    /// <param name="result">Result of an analysis run.</param>
    /// <param name="options">Analyzer identity and rule descriptors.</param>
    /// <param name="output">Destination.</param>
    public static void Write(AnalysisResult result, FactsOptions options, TextWriter output)
    {
        var entities = result.Model is null ? null : new EntityIndex(result.Model);
        var rules = options.SupportedRules.Select(d => (Descriptor: d, d.Id)).OrderBy(r => r.Id, StringComparer.Ordinal).ToList();
        var ruleIndex = rules.Select((r, i) => (r.Id, i)).ToDictionary(p => p.Id, p => p.i, StringComparer.Ordinal);

        var findings = result.Findings
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
                            rules = rules.Select(r => Text(options, r.Id, r.Descriptor)).Select(t => new
                            {
                                id = t.Id,
                                name = t.Title,
                                shortDescription = new { text = t.Description },
                                fullDescription = new { text = t.Rationale },
                                defaultConfiguration = new { level = Level(t.Descriptor.DefaultSeverity) },
                                messageStrings = MessageStrings(options, t.Id),
                                properties = new { category = t.Descriptor.Category, paradigms = t.Descriptor.Paradigms.Order(StringComparer.Ordinal).ToList() },
                            }),
                        },
                    },
                    results = findings.Select(f => new
                    {
                        ruleId = f.AnalyzerId,
                        ruleIndex = ruleIndex.GetValueOrDefault(f.AnalyzerId),
                        level = Level(f.Severity),
                        message = Message(options, f),
                        locations = f.Evidence.Location.IsKnown ? new[] { Location(f) } : [],
                        partialFingerprints = new Dictionary<string, string> { ["nomos/v1"] = f.Fingerprint },
                        properties = new
                        {
                            severity = f.Severity.ToString().ToLowerInvariant(),
                            confidence = f.Confidence.ToString().ToLowerInvariant(),
                            explanation = f.Evidence.Explanation,
                            explanationMessage = Key(options, f.AnalyzerId, f.ExplanationTemplate) is { } key ? new { id = key, arguments = f.ExplanationTemplate!.Arguments } : null,
                            module = f.Module,
                            entity = entities?.Resolve(f.Symbol),
                            measured = f.Measured is { } m ? new { metric = m.Metric, value = m.Value, threshold = m.Threshold } : null,
                        },
                    }),
                },
            },
        };
        output.WriteLine(JsonSerializer.Serialize(log, Options).ReplaceLineEndings("\n"));
    }

    /// <summary>English templates of the rule by key, in key order (rule.messageStrings of SARIF); null when the rule has none.</summary>
    private static SortedDictionary<string, object>? MessageStrings(FactsOptions options, string id)
    {
        var messages = options.RuleTexts?.GetValueOrDefault(id)?.Messages;
        if (messages is null || messages.Count == 0) return null;
        return new SortedDictionary<string, object>(messages.ToDictionary(m => m.Key, m => (object)new { text = m.Value }), StringComparer.Ordinal);
    }

    /// <summary>The key of the spec template a text was made from; null when the rule has no such template.</summary>
    private static string? Key(FactsOptions options, string ruleId, TemplateText? text)
    {
        if (text is null || options.RuleTexts?.GetValueOrDefault(ruleId)?.Messages is not { } messages) return null;
        foreach (var (key, template) in messages.OrderBy(m => m.Key, StringComparer.Ordinal))
            if (template == text.Template) return key;
        return null;
    }

    /// <summary>The message with <c>id</c> and <c>arguments</c> of its spec template (spec/l10n.md); the text stays the English fallback.</summary>
    private static Dictionary<string, object> Message(FactsOptions options, Finding finding)
    {
        var message = new Dictionary<string, object> { ["text"] = finding.Message };
        if (Key(options, finding.AnalyzerId, finding.MessageTemplate) is { } key)
        {
            message["id"] = key;
            message["arguments"] = finding.MessageTemplate!.Arguments;
        }
        return message;
    }

    /// <summary>Rule texts come from spec/rules; a rule without a spec entry falls back to the descriptor.</summary>
    private static (string Id, string Title, string Description, string Rationale, AnalyzerDescriptor Descriptor) Text(FactsOptions options, string id, AnalyzerDescriptor descriptor)
    {
        if (options.RuleTexts?.TryGetValue(id, out var spec) == true) return (id, spec.Title, spec.Description, spec.Rationale, descriptor);
        var description = descriptor.Description.Length > 0 ? descriptor.Description : descriptor.Title;
        return (id, descriptor.Title, description, description, descriptor);
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
